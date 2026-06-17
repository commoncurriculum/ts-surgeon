import { valueA } from "./moduleA"; // dependency on moduleA

// Exported function
export function utilFunc1(): void {
	console.log("Util Func 1 executed with value:", valueA);
}

// Internal helper function (not exported)
function internalUtil(): string {
	return "Internal Util Result";
}

// Another exported function that uses the internal helper
export function utilFunc2(): string {
	const internalResult = internalUtil();
	return `Util Func 2 using ${internalResult}`;
}

function anotherInternalConsumer(): string {
	return `Another consumer: ${internalUtil()}`;
}

export function publicConsumer(): string {
	return anotherInternalConsumer();
}

export const utilValue = 123;

export type UtilType = {
	key: string;
	value: number;
};
