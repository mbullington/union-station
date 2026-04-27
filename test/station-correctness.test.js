import test from 'node:test';
import assert from 'node:assert/strict';
import { UnionStation } from '../dist/index.js';

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

function nextTick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

class ProbeWorker {
	static instances = [];
	static handler = null;

	constructor() {
		this.onmessage = null;
		this.messages = [];
		ProbeWorker.instances.push(this);
		setTimeout(() => {
			this.onmessage?.({ data: { type: 'setup' } });
		}, 0);
	}

	postMessage(message) {
		if (message.type === 'setup_ack') {
			this.localQueueSize = message.localQueueSize;
			return;
		}

		this.messages.push(message);
		ProbeWorker.handler?.(this, message);
	}

	respond(message, payload = {}) {
		setTimeout(() => {
			this.onmessage?.({
				data: {
					type: 'done',
					id: message.id,
					name: message.name,
					result: payload.result ?? message.data,
					dt: payload.dt ?? 10,
				},
			});
		}, 0);
	}

	terminate() {}
}

test('scheduler keeps original worker indices when filtering eligible workers', async () => {
	ProbeWorker.instances.length = 0;
	ProbeWorker.handler = null;

	const restore = patchGlobals({
		Worker: ProbeWorker,
		navigator: { hardwareConcurrency: 4 },
	});

	try {
		const station = new UnionStation('probe-worker.js', {
			maxWorkers: 3,
			localQueueSize: 1,
		});
		await station.isReady;

		const first = station.call('task', 'first');
		const second = station.call('task', 'second');
		const third = station.call('task', 'third');

		assert.deepEqual(
			ProbeWorker.instances.map((worker) => worker.messages.length),
			[1, 1, 1],
		);

		for (const worker of ProbeWorker.instances) {
			worker.respond(worker.messages[0]);
		}

		assert.deepEqual(await Promise.all([first, second, third]), [
			'first',
			'second',
			'third',
		]);
	} finally {
		restore();
	}
});

test('scheduler accounts for elapsed time when choosing a worker', async () => {
	ProbeWorker.instances.length = 0;
	ProbeWorker.handler = null;
	let clock = 0;

	const restore = patchGlobals({
		Worker: ProbeWorker,
		navigator: { hardwareConcurrency: 3 },
		performance: { now: () => clock },
	});

	try {
		const station = new UnionStation('probe-worker.js', {
			maxWorkers: 2,
			timeSnapshot: {
				long: 100,
				short: 20,
			},
		});
		await station.isReady;

		station.call('long', 'first');
		clock = 90;
		station.call('short', 'second');
		station.call('short', 'third');

		assert.deepEqual(
			ProbeWorker.instances.map((worker) => worker.messages.map((message) => message.name)),
			[['long', 'short'], ['short']],
		);
	} finally {
		restore();
	}
});

test('scheduler adjusts worker availability using the estimate assigned at dispatch', async () => {
	ProbeWorker.instances.length = 0;
	ProbeWorker.handler = null;
	let clock = 0;

	const restore = patchGlobals({
		Worker: ProbeWorker,
		navigator: { hardwareConcurrency: 3 },
		performance: { now: () => clock },
	});

	try {
		const station = new UnionStation('probe-worker.js', {
			maxWorkers: 2,
			timeSnapshot: { task: 10 },
		});
		await station.isReady;

		const first = station.call('task', 'first');
		const second = station.call('task', 'second');
		station.call('task', 'third');

		const firstWorker = ProbeWorker.instances[0];
		const secondWorker = ProbeWorker.instances[1];
		assert.deepEqual(
			ProbeWorker.instances.map((worker) => worker.messages.map((message) => message.data)),
			[['first', 'third'], ['second']],
		);

		secondWorker.respond(secondWorker.messages[0], { dt: 100 });
		assert.equal(await second, 'second');
		await nextTick();

		firstWorker.respond(firstWorker.messages[0], { dt: 10 });
		assert.equal(await first, 'first');

		station.call('task', 'fourth');

		assert.deepEqual(
			ProbeWorker.instances.map((worker) => worker.messages.map((message) => message.data)),
			[['first', 'third'], ['second', 'fourth']],
		);
	} finally {
		restore();
	}
});

test('time snapshots use each completion once when updating the running mean', async () => {
	ProbeWorker.instances.length = 0;
	ProbeWorker.handler = (worker, message) => {
		worker.respond(message, {
			result: message.data.result,
			dt: message.data.dt,
		});
	};

	const restore = patchGlobals({
		Worker: ProbeWorker,
		navigator: { hardwareConcurrency: 2 },
	});

	try {
		const station = new UnionStation('probe-worker.js', { maxWorkers: 1 });
		assert.equal(await station.call('task', { result: 'first', dt: 10 }), 'first');
		await nextTick();
		assert.equal(await station.call('task', { result: 'second', dt: 30 }), 'second');
		await nextTick();

		assert.equal(station.getTimeSnapshot().task, 20);
	} finally {
		restore();
		ProbeWorker.handler = null;
	}
});
