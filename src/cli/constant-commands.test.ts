import { describe, expect, it } from "vitest";
import { constantCommand } from "./constant-commands.js";

describe("constantCommand", () => {
	it("resolves the commands that answer from a string constant", async () => {
		for (const command of ["guide", "--version", "-v"]) {
			const answer = constantCommand(command);
			expect(answer, command).toBeTypeOf("function");
			// The thunk must return a promise of text — index.ts writes it and exits.
			await expect((answer as () => Promise<string>)()).resolves.toBeTypeOf(
				"string",
			);
		}
	});

	it("resolves nothing for commands the full CLI owns", () => {
		for (const command of ["call", "list", "describe", "batch", "hook", ""]) {
			expect(constantCommand(command), command).toBeUndefined();
		}
		expect(constantCommand(undefined)).toBeUndefined();
	});

	/**
	 * Regression: the table was an object literal, so an argv string reached
	 * Object.prototype. `ts-surgeon constructor` resolved to a function, index.ts
	 * called it and then called `.then` on the non-promise it returned, and the
	 * process died with a raw TypeError stack instead of the CLI's
	 * "Unknown command". Keep the table free of inherited keys.
	 */
	it("does not resolve inherited object keys", () => {
		for (const command of [
			"constructor",
			"toString",
			"valueOf",
			"hasOwnProperty",
			"__proto__",
			"isPrototypeOf",
			"propertyIsEnumerable",
		]) {
			expect(constantCommand(command), command).toBeUndefined();
		}
	});
});
