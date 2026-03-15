export type MaybePromise<T> = T | PromiseLike<T>;

export type WorkgroupFn<K, V> = (
	data: K,
	prev: V | undefined,
	workgroupStart: number,
	workgroupEnd: number,
) => MaybePromise<V>;

type IsWorkgroupFunction<T> = T extends (...args: infer P) => any
	? P extends [any, any, number, number]
		? true
		: false
	: false;

export type OnlyWorkgroupFn<T extends UnionWorkerDef> = {
	[K in keyof T as IsWorkgroupFunction<T[K]> extends true ? K : never]: T[K];
};

export type ExcludeWorkgroupFn<T extends UnionWorkerDef> = {
	[K in keyof T as IsWorkgroupFunction<T[K]> extends true ? never : K]: T[K];
};

export interface UnionWorkerDef {
	/**
	 * Union workers can expose both one-shot functions, and also functions that
	 * have a set number of items (known as the workgroup).
	 *
	 * Functions can't access the length of the workgroup, nor is the workgroup
	 * start & end index consistent across runs. The requested run of the workgroup
	 * is an implementation detail of the scheduler and should not be depended on.
	 */
	[key: string]: ((data: any) => MaybePromise<any>) | WorkgroupFn<any, any>;
}

export interface UnionWorkerSerializedError {
	name: string;
	message: string;
	stack?: string;
}

export type UnionWorkerCallRequest = {
	type: "call";
	id: number;
	name: string;
	data: any;
	workgroupLength: number; // This is always filled to zero to maintain the same shape: default value is 0.
};

export type UnionWorkerRequest =
	| { type: "setup_ack"; localQueueSize: number }
	| UnionWorkerCallRequest
	| { type: "call_priority"; call: UnionWorkerCallRequest };

export type UnionWorkerResponse =
	| { type: "setup" }
	| { type: "done"; id: number; name: string; result: any; dt: number }
	| {
			type: "error";
			id: number;
			name: string;
			error: UnionWorkerSerializedError;
			dt: number;
	  };
