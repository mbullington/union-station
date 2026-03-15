function scheduleIdleCallback(fn: () => void) {
	const idleCallback = globalThis.requestIdleCallback;
	if (idleCallback) {
		idleCallback(fn);
		return;
	}

	setTimeout(fn, 0);
}

/**
 * Debounce a function call using requestIdleCallback.
 */
export function debounceIdleCallback<T extends (...args: any[]) => any>(
	fn: T,
): (...args: Parameters<T>) => void {
	let scheduled = false;
	return (...args: Parameters<T>) => {
		if (scheduled) {
			return;
		}
		scheduled = true;
		scheduleIdleCallback(() => {
			scheduled = false;
			fn(...args);
		});
	};
}
