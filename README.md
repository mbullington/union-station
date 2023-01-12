Union Station
===

## **THIS IS STILL IN DEVELOPMENT.** (re: [TODO](#todo))

`union-station` is a multithreaded job scheduler for JavaScript, implemented
using [Web workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers).

The goals of `union-station` are:

- Provide an easy and (mostly) fast way to schedule async tasks across multiple
  workers in JavaScript.
- Optimize for running **fixed-size** workloads with many instances. (re: [design](#design))
- Best when using TypeScript

Non-goals of `union-station` are:

- Support for WebAssembly. With the advent of [WebAssembly threads](https://web.dev/webassembly-threads/), there are many C/C++/Rust multicore schedulers that will suit your needs better.
- Optimize this past being fun to make. Due to how this scheduler needs to work (re: [design](#design)), use WebAssembly or native if you need more performance than reasonably provided by this project. *This being said*, I am using this for a game project!

## Example

`worker.ts`:

```typescript
import { setupWorker } from 'union-station';

// Define a set of jobs
export const jobs = setupWorker({
   add: (data: number[]) => data.reduce((a, b) => a + b, 0),
});
```

`index.ts`:

> Make sure you import from the worker using `import type`. This will get the types, without adding code to your bundle!
>
> Very important here.

```typescript
import { UnionStation } from 'union-station';
import type { jobs } from './worker';

const station = new UnionStation<typeof jobs>('worker.js');
await station.call("add", [1, 2, 3, 4, 5]); // 15
```

## Design

The main difference between `union-station` and a general-use one you may find in [systems languages](#further-reading) is the lack of shared memory for JavaScript objects.

This is explored in ["Is postMessage slow?"](https://surma.dev/things/is-postmessage-slow/), and is shown to be variable along with the size of the data. 

We immediately have the following limitations:
- No work stealing (cause arbitrary copies).
- Workers must have local queues (otherwise, main thread is serialized with workers).
- Workloads with `>1` work items can't be shared across workers (cause arbitrary copies).

### Predictive scheduling

Because of the above limitations, we employ a **predictive scheduler** that is guaranteed to only make **two copies** (input, output).

Workers are chosen based on their estimated time to completion, and resulting runs help reduce the variance of the **arithmetic mean (average)** for each task type.

Using the average of all task runs is why we optimize for fixed-size workloads.

### Global queue & reflows

In case our estimates are wildly off, we employ a (configurable) queue limit for each worker. By default this is small, `8` tasks.

**Local queue is full:**

When we can't schedule a task due to queue limits, the task is placed in a **global queue** instead on the main thread.

**Local queue is empty:**

When a local worker queue is emptied and the global queue contains items, we do a **reflow**.

A reflow tries to distribute remaining tasks in the global queue evenly among all the workers. If it fails, it just remains in the global queue until the next reflow.

### Priority tasks

Tasks can be marked as priority, which means they get added to the **front** of a worker's queue.

This is useful for tasks that need done soon, perhaps by the next frame.

```typescript
await station.call("add", [1, 2, 3, 4, 5], { priority: true });
```

### Workloads

`worker.ts`:

```typescript
import { setupWorker } from 'union-station';

// Define a set of jobs
export const jobs = setupWorker({
  add: (
    data: number[],
    prev: number | undefined,
    workgroupStart: number,
	workgroupEnd: number
  ) => {
    let value = prev ?? 0;
    for (let i = workgroupStart; i < workgroupEnd; i++) {
        value += expensiveCalculation(data[i]);
    }

    return value;
  },
});
```

`index.ts`:

```typescript
import { UnionStation } from 'union-station';
import type { jobs } from './worker';

const station = new UnionStation<typeof jobs>('worker.js');
await station.call("add", [1, 2, 3, 4, 5], 5); // 15
```

In other schedulers, itemizing your workloads is a way to tackle "massively parallel problems" by having multiple workers compute a task at the same time.

So why is itemizing workloads still useful when we're limited to one worker?

In `union-station`, itemizing workloads is done to ensure a long running task doesn't "stall" a worker, preventing any priority tasks from being fired.

## Tips for best usage

### Split a variable-length task into multiple tasks with more consistent performnance

`union-worker` makes predictions based on averages. This means if you have a highly variable workload type, you should split it into **multiple types** that each have more consistent performance.

For example, if I have a task A:

```ruby
A (run 0) -> 4ms
A (run 1) -> 5ms

A (run 2) -> 16ms
A (run 3) -> 15ms
A (run 4) -> 13ms

A (run 5) -> 4ms
```

If possible, the scheduler is more efficient by splitting this into two types... `A0` and `A1`.

```ruby
A0 (run 0) -> 4ms
A0 (run 1) -> 5ms

A1 (run 0) -> 16ms
A1 (run 1) -> 15ms
A1 (run 2) -> 13ms

A0 (run 3) -> 4ms
```

### Split long-running tasks into workgroups

See [Workloads](#workloads).

If you have a long-running task (say, `>20ms`) or have a "massively parallel problem," consider breaking it up into *work items*.

This makes sure priority tasks won't get stalled.

A *work items* function is a reducer that looks like this.

```typescript
import { setupWorker } from 'union-station';

// Define a set of jobs
export const jobs = setupWorker({
  add: (
    data: number[],
    prev: T | undefined,
    workgroupStart: number,
	workgroupEnd: number
  ) => {
    return prev + /* stuff from [start...end] */
  },
});
```

Then, `station.call` accepts an additional parameter for the workload length.

```typescript
await station.call("add", [1, 2, 3, 4, 5], /* workload length: */ 5);
```

### Avoid cold starts by caching time snapshots

Since `union-station` is a predictive scheduler, a cold start means there won't be any data available for each task type.

To counter this, you can pass a `timeSnapshot` parameter to the `UnionStation` constructor.

This can be used to:
- Prerecord a snapshot on representative hardware, and load in the snapshot by default.
- Persist a user's time snapshot to `localStorage`, load *that* instead of the prerecorded snapshot if available.

```typescript
import { UnionStation } from 'union-station';
import type { jobs } from './worker';

const timeSnapshot = localStorage.timeSnapshot ?
    JSON.parse(localStorage.timeSnapshot) :
    {
        add: 2, // 2ms
        // ...
    };

const station = new UnionStation<typeof jobs>('worker.js', {
    timeSnapshot,
    fallbackTime: 2 // 10ms by default
});

// getting a time snapshot
station.getTimeSnapshot();
```

## Further reading

While I didn't use any code from any of the sources listed, they are good reference to how regular multicore schedulers work!

- `union-station`'s name is a riff on Apple's multicore library, Grand Central Dispatch. I live in Washington D.C.
- The global queue is a good compromise between entirely serializing the main thread with the workers, and (in our case) totally being wrong about the estimations. I got the idea from [goroutines](https://medium.com/a-journey-with-go/go-work-stealing-in-go-scheduler-d439231be64d).
- [Anatomy of a task scheduler](https://maxliani.wordpress.com/2022/07/27/anatomy-of-a-task-scheduler/) was a fun read, and may be a good basis if you need a WebAssembly solution!

## TODO

- [ ] I haven't made the Union Worker (hehe) implementation yet. Although this part doesn't do any scheduling of it's own, it just takes call commands and runs them!
- [ ] I haven't tested *any* of this, but the Station should be complete.
- [ ] We should implement an `Evented` interface for `UnionStation`, so when we
  adjust estimates the time snapshot can be persisted.