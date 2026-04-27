import {
	UnionWorkerCallRequest,
	UnionWorkerDef,
	UnionWorkerRequest,
	UnionWorkerResponse,
	UnionWorkerSerializedError,
} from "./types";

interface WorkerMessageEvent<T> {
	data: T;
}

interface WorkerRuntimeScope {
	postMessage(message: UnionWorkerResponse): void;
	addEventListener?: (
		type: "message",
		listener: (event: WorkerMessageEvent<UnionWorkerRequest>) => void,
	) => void;
	onmessage:
		| ((event: WorkerMessageEvent<UnionWorkerRequest>) => void)
		| null
		| undefined;
}

interface PendingCall {
	call: UnionWorkerCallRequest;
	startedAt: number;
	prev: unknown;
	workgroupStart: number;
}

const WORKER_RUNTIME_KEY = Symbol.for("union-station.worker-runtime");

function now(): number {
	return globalThis.performance?.now() ?? Date.now();
}

function getWorkerRuntimeScope(): WorkerRuntimeScope | undefined {
	const scope = globalThis as Partial<WorkerRuntimeScope> & {
		document?: unknown;
		postMessage?: unknown;
	};

	if (typeof scope.document !== "undefined") {
		return undefined;
	}

	if (typeof scope.postMessage !== "function") {
		return undefined;
	}

	if (
		typeof scope.addEventListener !== "function" &&
		typeof scope.onmessage === "undefined"
	) {
		return undefined;
	}

	const runtimeScope: WorkerRuntimeScope = {
		postMessage: scope.postMessage.bind(scope),
		addEventListener:
			typeof scope.addEventListener === "function"
				? scope.addEventListener.bind(scope)
				: undefined,
		get onmessage() {
			return scope.onmessage;
		},
		set onmessage(value) {
			scope.onmessage = value;
		},
	};

	return runtimeScope;
}

function serializeError(error: unknown): UnionWorkerSerializedError {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}

	return {
		name: "Error",
		message: typeof error === "string" ? error : String(error),
	};
}

class UnionWorkerRuntime<T extends UnionWorkerDef> {
	#scope: WorkerRuntimeScope;
	#def: T;
	#localQueueSize = 8;
	#ready = false;

	#priorityQueue: PendingCall[] = [];
	#queue: PendingCall[] = [];
	#isDraining = false;
	#drainScheduled = false;

	constructor(scope: WorkerRuntimeScope, def: T) {
		this.#scope = scope;
		this.#def = def;

		const onMessage = this.#onMessage;
		if (typeof scope.addEventListener === "function") {
			scope.addEventListener("message", onMessage);
		} else {
			scope.onmessage = onMessage;
		}

		scope.postMessage({ type: "setup" });
	}

	#onMessage = (event: WorkerMessageEvent<UnionWorkerRequest>) => {
		const { data } = event;
		switch (data.type) {
			case "setup_ack":
				this.#localQueueSize = Math.max(1, data.localQueueSize);
				this.#ready = true;
				this.#scheduleDrain();
				return;
			case "call":
				this.#enqueue(data, false);
				return;
			case "call_priority":
				this.#enqueue(data.call, true);
				return;
			default:
				return;
		}
	};

	#enqueue(call: UnionWorkerCallRequest, priority: boolean) {
		const entry: PendingCall = {
			call,
			startedAt: now(),
			prev: undefined,
			workgroupStart: 0,
		};

		if (priority) {
			this.#priorityQueue.push(entry);
		} else {
			this.#queue.push(entry);
		}

		this.#scheduleDrain();
	}

	#scheduleDrain() {
		if (!this.#ready || this.#drainScheduled) {
			return;
		}

		this.#drainScheduled = true;
		setTimeout(() => {
			this.#drainScheduled = false;
			void this.#drain();
		}, 0);
	}

	#takeNextCall(): PendingCall | undefined {
		return this.#priorityQueue.shift() ?? this.#queue.shift();
	}

	#getWorkgroupChunkSize(length: number): number {
		return Math.max(1, Math.ceil(length / this.#localQueueSize));
	}

	async #drain() {
		if (this.#isDraining || !this.#ready) {
			return;
		}

		this.#isDraining = true;
		try {
			while (this.#ready) {
				const pending = this.#takeNextCall();
				if (!pending) {
					return;
				}

				const fn = this.#def[pending.call.name];
				if (!fn) {
					this.#scope.postMessage({
						type: "error",
						id: pending.call.id,
						name: pending.call.name,
						error: {
							name: "Error",
							message: `Unknown worker job: ${pending.call.name}`,
						},
						dt: now() - pending.startedAt,
					});
					continue;
				}

				try {
					if (!pending.call.workgroupLength) {
						const oneShotFn = fn as (data: unknown) => unknown;
						const result = await oneShotFn(pending.call.data);
						this.#scope.postMessage({
							type: "done",
							id: pending.call.id,
							name: pending.call.name,
							result,
							dt: now() - pending.startedAt,
						});
						continue;
					}

					const chunkSize = this.#getWorkgroupChunkSize(pending.call.workgroupLength);
					const workgroupEnd = Math.min(
						pending.call.workgroupLength,
						pending.workgroupStart + chunkSize,
					);

					const workgroupFn = fn as (
						data: unknown,
						prev: unknown,
						workgroupStart: number,
						workgroupEnd: number,
					) => unknown;
					pending.prev = await workgroupFn(
						pending.call.data,
						pending.prev,
						pending.workgroupStart,
						workgroupEnd,
					);
					pending.workgroupStart = workgroupEnd;

					if (pending.workgroupStart >= pending.call.workgroupLength) {
						this.#scope.postMessage({
							type: "done",
							id: pending.call.id,
							name: pending.call.name,
							result: pending.prev,
							dt: now() - pending.startedAt,
						});
						continue;
					}

					this.#queue.unshift(pending);
					this.#scheduleDrain();
					return;
				} catch (error) {
					this.#scope.postMessage({
						type: "error",
						id: pending.call.id,
						name: pending.call.name,
						error: serializeError(error),
						dt: now() - pending.startedAt,
					});
				}
			}
		} finally {
			this.#isDraining = false;
			if (this.#ready && (this.#priorityQueue.length || this.#queue.length)) {
				this.#scheduleDrain();
			}
		}
	}
}

/**
 * {@link setupWorker} creates a set of jobs and exposes them to the union station
 * that is running the worker.
 *
 * The object is returned as-is, but the type is narrowed to allow for easy TypeScript
 * binding.
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
export function setupWorker<T extends UnionWorkerDef>(def: T): T {
	const scope = getWorkerRuntimeScope();
	const runtimeGlobal = globalThis as Record<PropertyKey, unknown>;
	if (scope && !runtimeGlobal[WORKER_RUNTIME_KEY]) {
		runtimeGlobal[WORKER_RUNTIME_KEY] = true;
		new UnionWorkerRuntime(scope, def);
	}

	return def;
}
