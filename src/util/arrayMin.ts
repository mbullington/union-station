/**
 * This is a generic function that finds the minimum value in an array and returns it.
 */
export function arrayMin<T>(array: T[], fn: (item: T) => number):
	| { item: T; idx: number }
	| undefined {
	if (!array.length) {
		return undefined;
	}

	let min = fn(array[0]);
	let minIdx = 0;

	for (let i = 1; i < array.length; i++) {
		const value = fn(array[i]);
		if (value < min) {
			min = value;
			minIdx = i;
		}
	}

	return { item: array[minIdx], idx: minIdx };
}
