import {
	ExcludeWorkgroupFn,
	OnlyWorkgroupFn,
	UnionWorkerCallRequest,
	UnionWorkerDef,
	UnionWorkerRequest,
	UnionWorkerResponse,
} from "./types";

import { Completer } from "./util/Completer";
import { debounceIdleCallback } from "./util/debounceIdleCallback";
import { arrayMin } from "./util/arrayMin";

interface UnionStationOptions<T extends string | number | symbol> {
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
	// This is the estimated time in milliseconds until the worker will be idle.
	// This is an estimate, and is not guaranteed to be accurate.
	estimate: number;
	// This is the number of jobs that are currently running on the worker.
	running: number;
}

// Cached for microscopic performance.
function getWorkerNumericValue(a: WorkerStatus) {
	return a.estimate;
}

interface UnionStationCallOptions {
	/**
	 * If true, the job will be run next. This is useful for jobs that are
	 * time-sensitive.
	 */
	priority?: boolean;
}

/**
 * {@link UnionStation} creates a pool of union workers that coordinate tasks.
 *
 * @example
 * // Path: worker.ts
 * import { setupWorker } from 'union-station';
 * 
 * // Define a set of jobs
 * export const jobs = setupWorker({
 *    add: (data: number[]) => data.reduce((a, b) => a + b, 0),
 * });
 * 
 * // Path: index.js
 * import { UnionStation } from 'union-station';
 * import type { jobs } from './worker';
 * 
 * const station = new UnionStation<typeof jobs>('worker.js');
 * await station.call("add", [1, 2, 3, 4, 5]); // 15
 */
export class UnionStation<T extends UnionWorkerDef> {
	// The maximum number of jobs that can be queued on any given worker.
	#localQueueSize: number;
	// The fallback time to use if no snapshot or previous runs are available.
	#fallbackTime: number;

	#workers: Worker[];
	// This is the estimated total time each worker will take to be idle in milliseconds.
	#workerStatus: WorkerStatus[];

	// jobId is incremented for each job, and the promise is stored in the map.
	#jobId = 0;
	#jobs: Map<number, Completer<any>> = new Map();

	// These are variables relating to the job system being initialized.
	#readyCount: number = 0;
	#isReady: Completer<void> = new Completer();
	get isReady(): Promise<void> {
		return this.#isReady.promise;
	}

	// These are the estimates given for each job type.
	#estimates: Map<keyof T, { length: number; mean: number }> = new Map();
	#pendingEstimates: { name: keyof T; dt: number }[] = [];

	// When each local queue runs out of room, we'll push the job to the global
	// queue.
	//
	// Workers will pick these up later when they reflow.
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

		// Create workers.
		const cpuCount = navigator.hardwareConcurrency;
		const workerCount = Math.min(cpuCount - 1, maxWorkers);

		this.#workers = new Array(workerCount);
		this.#workerStatus = new Array(workerCount);

		for (let i = 0; i < workerCount; i++) {
			this.#workerStatus[i] = {
				estimate: 0,
				running: 0,
			};
		}

		for (let i = 0; i < workerCount; i++) {
			const worker = this.#workers[i] = new Worker(url);
			const onMessage = this.#onMessage;

			worker.onmessage = function (event: MessageEvent<UnionWorkerResponse>) {
				onMessage(i, event);
			};
		}

		// Pre-populate the estimates with the time snapshot, if available.
		if (timeSnapshot) {
			for (const [name, mean] of Object.entries(timeSnapshot)) {
				this.#estimates.set(name, {
					length: 1,
					mean,
				});
			}
		}
	}

	// Update our estimates based on prior data.
	#updateEstimates = debounceIdleCallback(() => {
		for (const { name, dt } of this.#pendingEstimates) {
			if (!this.#estimates.has(name)) {
				this.#estimates.set(name, {
					length: 1,
					mean: dt,
				});
				continue;
			}

			const estimate = this.#estimates.get(name)!;

			// Update mean.
			estimate.length++;
			estimate.mean =
				((estimate.mean * (estimate.length - 1)) + dt) / estimate.length;
		}
	});

	// Message received from worker.
	#onMessage = (
		workerIdx: number,
		event: MessageEvent<UnionWorkerResponse>,
	) => {
		const { data } = event;
		switch (data.type) {
			case "setup": {
				// Worker is ready, send the ack and increment the ready count.
				const worker = this.#workers[workerIdx];
				worker.postMessage(<UnionWorkerRequest>{
					type: "setup_ack",
					localQueueSize: this.#localQueueSize,
				});

				this.#readyCount++;
				if (this.#readyCount === this.#workers.length) {
					// All workers are ready, resolve the isReady promise.
					this.#isReady.resolve();
				}
				break;
			}
			case "done": {
				// Job is done, resolve the promise.
				const { id, name, result, dt } = data;

				const completer = this.#jobs.get(id);
				if (completer) {
					this.#jobs.delete(id);
					completer.resolve(result);
				}

				// Modify worker status.
				const status = this.#workerStatus[workerIdx];
				status.running--;
				status.estimate -= this.#getEstimate(name);

				// Recalculate the worker's time estimate.
				this.#pendingEstimates.push({ name, dt });
				this.#updateEstimates();

				// Reflow if necessary.
				if (!status.running && this.#globalQueue.length) {
					this.#reflow();
				}
			}
			default:
				break;
		}
	};

	/**
	 * Reflows all of the jobs in the global queue into the workers, if possible.
	 *
	 * TODO: There's probably a lot of room for speed improvements here.
	 */
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
		// This looks somewhat strange, but if priority,
		// we don't care about the local queue size.
		const eligibleWorkers = priority ? (
			this.#workerStatus
		) : this.#workerStatus.filter(
			({ running }) => running < this.#localQueueSize,
		);

		// Decline if false, push to global queue.
		if (!eligibleWorkers.length) {
			return false;
		}

		const { item: status, idx: workerIdx } = arrayMin(
			eligibleWorkers,
			getWorkerNumericValue,
		)!;

		// Update worker status.
		status.running++;
		status.estimate += this.#getEstimate(call.name);

		// Send worker message.
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
	): Promise<ReturnType<T[Name]>>;

	call<Name extends keyof OnlyWorkgroupFn<T>>(
		name: Name,
		data: Parameters<T[Name]>[0],
		workgroupLength: number,
		options?: UnionStationCallOptions,
	): Promise<ReturnType<T[Name]>>;

	async call<Name extends keyof T>(
		name: Name,
		data: Parameters<T[Name]>[0],
		workgroupLengthOrOptions?: number | UnionStationCallOptions,
		optionsOpt?: UnionStationCallOptions,
	): Promise<ReturnType<T[Name]>> {
		const hasWorkgroupLength = typeof workgroupLengthOrOptions === "number";
		// Deswizzle the options.
		const workgroupLength = hasWorkgroupLength ? workgroupLengthOrOptions : 0;
		const { priority } =
			(hasWorkgroupLength ? optionsOpt : workgroupLengthOrOptions) ?? {};

		// Wait for scheduler to be ready.
		if (!this.#isReady.isCompleted) {
			await this.isReady;
		}

		const jobId = this.#jobId++;
		const completer = new Completer<ReturnType<T[Name]>>();
		const call = <UnionWorkerCallRequest>{
			type: "call",
			id: jobId,
			name,
			data,
			workgroupLength, // This is always filled to zero to maintain the same shape.
		};

		this.#jobs.set(jobId, completer);
		if (!this.#schedule(call, priority)) {
			// No worker was available, push to global queue.
			this.#globalQueue.push(call);
		}

		return completer.promise;
	}

	/**
	 * Returns a snapshot of the current time estimates for each job type, used
	 * for cold start prediction.
	 *
	 * Can be persisted to local storage and passed to the scheduler on
	 * initialization.
	 *
	 * {@link UnionStationOptions.timeSnapshot}
	 */
	getTimeSnapshot(): Record<keyof T, number> {
		const keys = this.#estimates.keys();
		const snapshot: Record<keyof T, number> = {} as any;
		for (const key of keys) {
			snapshot[key] = this.#estimates.get(key)!.mean;
		}

		return snapshot;
	}
}
