import { UnionWorkerDef } from "./types";

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
	return def;
}
