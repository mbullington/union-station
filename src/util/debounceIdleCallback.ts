/**
 * Debounce a function call using requestIdleCallback.
 */
export function debounceIdleCallback<T extends (...args: any[]) => any>(
	fn: T,
): (...args: Parameters<T>) => void {
	let scheduled = false;
	return (...args: any[]) => {
		if (scheduled) {
			return;
		}
		scheduled = true;
		requestIdleCallback(() => {
			scheduled = false;
			fn(...args);
		});
	};
}
