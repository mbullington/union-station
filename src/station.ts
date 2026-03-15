import {
	ExcludeWorkgroupFn,
	OnlyWorkgroupFn,
	UnionWorkerCallRequest,
	UnionWorkerDef,
	UnionWorkerRequest,
	UnionWorkerResponse,
	UnionWorkerSerializedError,
} from "./types";

import { Completer } from "./util/Completer";
import { debounceIdleCallback } from "./util/debounceIdleCallback";
import { arrayMin } from "./util/arrayMin";

export interface UnionStationOptions<T extends string | number | symbol> {
	/**
	 * This is the size of each worker's local queue. This is the number of jobs that
	 * can be queued before the worker is forced to wait for the main thread to
	 * process the queue.
	 *
	 * Default: 8
	 */
	localQueueSize?: number;
	/**
	 * This is the number of workers that will be created. It will never be higher
	 * than {@link navigator.hardwareConcurrency} - 1.
	 *
	 * Default: 4
	 */
	maxWorkers?: number;
	/**
	 * Since UnionStation is a predictive scheduler, it estimates how long each
	 * job will take to run.
	 *
	 * You can load a time snapshot to help the scheduler make better predictions
	 * without having to run the jobs first.
	 *
	 * {@link UnionStation.getTimeSnapshot} can be used to generate a time snapshot.
	 */
	timeSnapshot?: Record<T, number>;
	/**
	 * Estimates how long a job will take to run, if no snapshot or previous
	 * runs are available. This is in milliseconds.
	 *
	 * Default: 10
	 */
	fallbackTime?: number;
}

interface WorkerStatus {
	estimate: number;
	running: number;
}

interface IndexedWorkerStatus {
	idx: number;
	status: WorkerStatus;
}

export interface UnionStationCallOptions {
	/**
	 * If true, the job will be run next. This is useful for jobs that are
	 * time-sensitive.
	 */
	priority?: boolean;
}

function restoreError(error: UnionWorkerSerializedError): Error {
	const restored = new Error(error.message);
	restored.name = error.name;
	if (error.stack) {
		restored.stack = error.stack;
	}
	return restored;
}

/**
 * {@link UnionStation} creates a pool of union workers that coordinate tasks.
 */
export class UnionStation<T extends UnionWorkerDef> {
	#localQueueSize: number;
	#fallbackTime: number;

	#workers: Worker[];
	#workerStatus: WorkerStatus[];

	#jobId = 0;
	#jobs: Map<number, Completer<unknown>> = new Map();

	#readyCount = 0;
	#isReady: Completer<void> = new Completer();
	get isReady(): Promise<void> {
		return this.#isReady.promise;
	}

	#estimates: Map<keyof T, { length: number; mean: number }> = new Map();
	#pendingEstimates: { name: keyof T; dt: number }[] = [];
	#globalQueue: UnionWorkerCallRequest[] = [];

	constructor(
		url: string,
		{
			localQueueSize = 8,
			maxWorkers = 4,
			timeSnapshot,
			fallbackTime = 10,
		}: UnionStationOptions<keyof T> = {},
	) {
		this.#localQueueSize = localQueueSize;
		this.#fallbackTime = fallbackTime;

		const reportedCpuCount = globalThis.navigator?.hardwareConcurrency ?? 1;
		const cpuCount = Number.isFinite(reportedCpuCount)
			? Math.max(1, Math.floor(reportedCpuCount))
			: 1;
		const workerCount = Math.max(
			1,
			Math.min(Math.max(1, cpuCount - 1), Math.max(1, maxWorkers)),
		);

		this.#workers = new Array(workerCount);
		this.#workerStatus = new Array(workerCount);

		for (let i = 0; i < workerCount; i++) {
			this.#workerStatus[i] = {
				estimate: 0,
				running: 0,
			};
		}

		for (let i = 0; i < workerCount; i++) {
			const worker = (this.#workers[i] = new Worker(url));
			const onMessage = this.#onMessage;

			worker.onmessage = function (event: MessageEvent<UnionWorkerResponse>) {
				onMessage(i, event);
			};
		}

		if (timeSnapshot) {
			for (const [name, mean] of Object.entries(timeSnapshot)) {
				this.#estimates.set(name as keyof T, {
					length: 1,
					mean,
				});
			}
		}
	}

	#updateEstimates = debounceIdleCallback(() => {
		const pendingEstimates = this.#pendingEstimates.splice(0);
		for (const { name, dt } of pendingEstimates) {
			if (!this.#estimates.has(name)) {
				this.#estimates.set(name, {
					length: 1,
					mean: dt,
				});
				continue;
			}

			const estimate = this.#estimates.get(name)!;
			estimate.length++;
			estimate.mean =
				((estimate.mean * (estimate.length - 1)) + dt) / estimate.length;
		}
	});

	#completeJob(
		workerIdx: number,
		name: string,
		id: number,
		dt: number,
		settle: (completer: Completer<unknown>) => void,
	) {
		const completer = this.#jobs.get(id);
		if (completer) {
			this.#jobs.delete(id);
			settle(completer);
		}

		const status = this.#workerStatus[workerIdx];
		status.running = Math.max(0, status.running - 1);
		status.estimate = Math.max(
			0,
			status.estimate - this.#getEstimate(name as keyof T),
		);

		this.#pendingEstimates.push({ name: name as keyof T, dt });
		this.#updateEstimates();

		if (!status.running && this.#globalQueue.length) {
			this.#reflow();
		}
	}

	#onMessage = (
		workerIdx: number,
		event: MessageEvent<UnionWorkerResponse>,
	) => {
		const { data } = event;
		switch (data.type) {
			case "setup": {
				const worker = this.#workers[workerIdx];
				worker.postMessage(<UnionWorkerRequest>{
					type: "setup_ack",
					localQueueSize: this.#localQueueSize,
				});

				this.#readyCount++;
				if (this.#readyCount === this.#workers.length) {
					this.#isReady.resolve();
				}
				return;
			}
			case "done": {
				this.#completeJob(workerIdx, data.name, data.id, data.dt, (completer) => {
					completer.resolve(data.result);
				});
				return;
			}
			case "error": {
				this.#completeJob(workerIdx, data.name, data.id, data.dt, (completer) => {
					completer.reject(restoreError(data.error));
				});
				return;
			}
			default:
				return;
		}
	};

	#reflow = debounceIdleCallback(() => {
		if (!this.#globalQueue.length) {
			return;
		}

		let i = 0;
		while (i < this.#globalQueue.length) {
			const job = this.#globalQueue[i];
			if (!this.#schedule(job)) {
				break;
			}
			i++;
		}

		this.#globalQueue.splice(0, i);
	});

	#getEstimate(type: keyof T): number {
		const estimate = this.#estimates.get(type);
		if (!estimate) {
			return this.#fallbackTime;
		}
		return estimate.mean;
	}

	#schedule(call: UnionWorkerCallRequest, priority?: boolean): boolean {
		const eligibleWorkers = this.#workerStatus
			.map<IndexedWorkerStatus>((status, idx) => ({ idx, status }))
			.filter(({ status }) => priority || status.running < this.#localQueueSize);

		if (!eligibleWorkers.length) {
			return false;
		}

		const { item } = arrayMin(
			eligibleWorkers,
			({ status }) => status.estimate,
		)!;
		const { idx: workerIdx, status } = item;

		status.running++;
		status.estimate += this.#getEstimate(call.name as keyof T);

		const worker = this.#workers[workerIdx];
		if (priority) {
			worker.postMessage(<UnionWorkerRequest>{ type: "call_priority", call });
		} else {
			worker.postMessage(call);
		}

		return true;
	}

	call<Name extends keyof ExcludeWorkgroupFn<T>>(
		name: Name,
		data: Parameters<T[Name]>[0],
		options?: UnionStationCallOptions,
	): Promise<Awaited<ReturnType<T[Name]>>>;

	call<Name extends keyof OnlyWorkgroupFn<T>>(
		name: Name,
		data: Parameters<T[Name]>[0],
		workgroupLength: number,
		options?: UnionStationCallOptions,
	): Promise<Awaited<ReturnType<T[Name]>>>;

	async call<Name extends keyof T>(
		name: Name,
		data: Parameters<T[Name]>[0],
		workgroupLengthOrOptions?: number | UnionStationCallOptions,
		optionsOpt?: UnionStationCallOptions,
	): Promise<Awaited<ReturnType<T[Name]>>> {
		const hasWorkgroupLength = typeof workgroupLengthOrOptions === "number";
		const workgroupLength = hasWorkgroupLength
			? Math.max(0, workgroupLengthOrOptions)
			: 0;
		const { priority } =
			(hasWorkgroupLength ? optionsOpt : workgroupLengthOrOptions) ?? {};

		if (!this.#isReady.isCompleted) {
			await this.isReady;
		}

		const jobId = this.#jobId++;
		const completer = new Completer<Awaited<ReturnType<T[Name]>>>();
		const call = <UnionWorkerCallRequest>{
			type: "call",
			id: jobId,
			name: String(name),
			data,
			workgroupLength,
		};

		this.#jobs.set(jobId, completer as unknown as Completer<unknown>);
		if (!this.#schedule(call, priority)) {
			this.#globalQueue.push(call);
		}

		return completer.promise;
	}

	getTimeSnapshot(): Record<keyof T, number> {
		const snapshot = {} as Record<keyof T, number>;
		for (const key of this.#estimates.keys()) {
			snapshot[key] = this.#estimates.get(key)!.mean;
		}
		return snapshot;
	}
}
