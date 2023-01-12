type PromiseResolve<T> = (value: T | PromiseLike<T>) => void;
type PromiseReject = (error: unknown) => void;

/**
 * A simple promise wrapper that allows you to resolve or reject the promise
 * manually.
 *
 * Michael notes:
 * 
 * I go back and forth on whether this is a good idea or not. I was first inspired
 * by Dart {@link https://api.flutter.dev/flutter/dart-async/Completer-class.html},
 * of which this is a TypeScript port.
 *
 * Sometimes I'm really bullish on it, other times (especially for one-offs) I'm
 * against it.
 *
 * Oh well. It makes writing {@link UnionStation} a lot easier.
 */
export class Completer<T> {
	#resolve: PromiseResolve<T> = () => {};
	#reject: PromiseReject = () => {};

	#isCompleted = false;
	get isCompleted() {
		return this.#isCompleted;
	}

	#promise: Promise<T>;
	get promise() {
		return this.#promise;
	}

	constructor() {
		this.#promise = new Promise((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
	}

	resolve(value: T) {
		this.#resolve(value);
		this.#isCompleted = true;
	}

	reject(error: unknown) {
		this.#reject(error);
		this.#isCompleted = true;
	}
}
