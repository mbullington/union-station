import test from 'node:test';
import assert from 'node:assert/strict';
import { UnionStation, setupWorker } from '../dist/index.js';

const workerScripts = new Map();
const workerRuntimeKey = Symbol.for('union-station.worker-runtime');

function patchGlobals(patches) {
	const originals = new Map();
	for (const [key, value] of Object.entries(patches)) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value,
		});
	}

	return () => {
		for (const [key, descriptor] of originals.entries()) {
			if (descriptor) {
				Object.defineProperty(globalThis, key, descriptor);
			} else {
				delete globalThis[key];
			}
		}
	};
}

function withWorkerContext(scope, fn) {
	const restore = patchGlobals({
		self: globalThis,
		postMessage: scope.postMessage.bind(scope),
		addEventListener: scope.addEventListener.bind(scope),
		onmessage: null,
	});
	const hadRuntimeKey = Object.prototype.hasOwnProperty.call(globalThis, workerRuntimeKey);
	const originalRuntimeValue = globalThis[workerRuntimeKey];
	delete globalThis[workerRuntimeKey];

	try {
		fn();
		scope.onmessage = globalThis.onmessage;
	} finally {
		if (hadRuntimeKey) {
			globalThis[workerRuntimeKey] = originalRuntimeValue;
		} else {
			delete globalThis[workerRuntimeKey];
		}
		restore();
	}
}

function createWorkerScope(mainWorker) {
	const listeners = [];
	return {
		onmessage: null,
		postMessage(message) {
			setTimeout(() => {
				mainWorker.onmessage?.({ data: message });
			}, 0);
		},
		addEventListener(type, listener) {
			if (type === 'message') {
				listeners.push(listener);
			}
		},
		dispatchFromMain(message) {
			const event = { data: message };
			for (const listener of listeners) {
				listener(event);
			}
			this.onmessage?.(event);
		},
	};
}

class FakeWorker {
	static instances = [];

	constructor(url) {
		this.url = url;
		this.onmessage = null;
		this.scope = createWorkerScope(this);
		FakeWorker.instances.push(this);

		const script = workerScripts.get(url);
		if (!script) {
			throw new Error(`No fake worker script registered for ${url}`);
		}

		withWorkerContext(this.scope, () => script(this.scope, this));
	}

	postMessage(message) {
		setTimeout(() => {
			this.scope.dispatchFromMain(message);
		}, 0);
	}

	terminate() {}
}

function registerWorkerScript(url, factory) {
	workerScripts.set(url, factory);
}

function nextTick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test('runs sync and async jobs end-to-end and propagates worker errors', async () => {
	FakeWorker.instances.length = 0;
	workerScripts.clear();
	registerWorkerScript('math-worker.js', () => {
		setupWorker({
			add: (data) => data.reduce((sum, value) => sum + value, 0),
			asyncDouble: async (value) => {
				await nextTick();
				return value * 2;
			},
			explode: () => {
				throw new Error('boom');
			},
		});
	});

	const restore = patchGlobals({
		Worker: FakeWorker,
		navigator: { hardwareConcurrency: 2 },
	});

	try {
		const station = new UnionStation('math-worker.js', { maxWorkers: 1 });
		assert.equal(await station.call('add', [1, 2, 3, 4]), 10);
		assert.equal(await station.call('asyncDouble', 9), 18);
		await assert.rejects(() => station.call('explode', undefined), /boom/);
	} finally {
		restore();
	}
});

test('worker timings exclude time spent waiting in the local queue', async () => {
	FakeWorker.instances.length = 0;
	workerScripts.clear();
	let clock = 0;

	registerWorkerScript('timed-worker.js', () => {
		setupWorker({
			work: () => {
				clock += 10;
				return clock;
			},
		});
	});

	const restore = patchGlobals({
		Worker: FakeWorker,
		navigator: { hardwareConcurrency: 2 },
		performance: { now: () => clock },
	});

	try {
		const station = new UnionStation('timed-worker.js', { maxWorkers: 1 });
		await station.isReady;

		const first = station.call('work', undefined);
		const second = station.call('work', undefined);

		assert.equal(await first, 10);
		assert.equal(await second, 20);
		await nextTick();

		assert.equal(station.getTimeSnapshot().work, 10);
	} finally {
		restore();
	}
});

test('setupWorker only installs one runtime per worker global', async () => {
	FakeWorker.instances.length = 0;
	workerScripts.clear();
	let runs = 0;
	registerWorkerScript('idempotent-worker.js', () => {
		const jobs = {
			ping: () => {
				runs++;
				return 'pong';
			},
		};
		setupWorker(jobs);
		setupWorker(jobs);
	});

	const restore = patchGlobals({
		Worker: FakeWorker,
		navigator: { hardwareConcurrency: 2 },
	});

	try {
		const station = new UnionStation('idempotent-worker.js', { maxWorkers: 1 });
		assert.equal(await station.call('ping', undefined), 'pong');
		await nextTick();
		assert.equal(runs, 1);
	} finally {
		restore();
	}
});

test('priority jobs can jump ahead of a chunked workgroup job', async () => {
	FakeWorker.instances.length = 0;
	workerScripts.clear();
	const events = [];

	registerWorkerScript('priority-worker.js', () => {
		setupWorker({
			sum: async (data, prev, start, end) => {
				events.push(`sum:${start}-${end}`);
				await nextTick();
				let total = prev ?? 0;
				for (let i = start; i < end; i++) {
					total += data[i];
				}
				return total;
			},
			ping: () => {
				events.push('ping');
				return 'pong';
			},
		});
	});

	const restore = patchGlobals({
		Worker: FakeWorker,
		navigator: { hardwareConcurrency: 2 },
	});

	try {
		const station = new UnionStation('priority-worker.js', {
			maxWorkers: 1,
			localQueueSize: 8,
		});
		const longRunning = station.call('sum', [1, 2, 3, 4, 5], 5);
		await nextTick();
		await nextTick();

		const priority = station.call('ping', undefined, { priority: true });
		assert.equal(await priority, 'pong');
		assert.equal(await longRunning, 15);

		assert.ok(events.includes('ping'));
		assert.ok(events.indexOf('ping') > 0, 'priority ran after the workgroup started');
		assert.ok(
			events.indexOf('ping') < events.length - 1,
			'priority ran before the workgroup fully completed',
		);
	} finally {
		restore();
	}
});
