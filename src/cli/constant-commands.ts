/**
 * Commands that answer from a string constant, resolved before `cli.js` is
 * imported. cli.js pulls in the tool registry, and through it ts-morph and the
 * TypeScript compiler — ~400ms of the ~1s a no-work command spent starting up
 * (measured 2026-07-29, on top of whatever npx charges to resolve the package
 * in the first place). Printing the guide has no business paying for a compiler.
 *
 * The heavy-ish imports stay inside the thunks, so requiring this module costs
 * nothing: it is a lookup table, and the lookup is what has to be cheap.
 *
 * A Map rather than an object literal, deliberately. An argv string indexes an
 * object's PROTOTYPE too, so `ts-surgeon constructor` (or `toString`,
 * `valueOf`, `hasOwnProperty`) resolved to a function, called it, and died on
 * `.then` of a non-promise — a raw stack trace where cli.js would have printed
 * "Unknown command". A Map has no inherited keys, so the whole class is gone
 * rather than patched.
 */
const CONSTANT_COMMANDS = new Map<string, () => Promise<string>>([
	["guide", async () => (await import("../guide.js")).GUIDE],
	["--version", async () => `${(await import("../version.js")).VERSION}\n`],
	["-v", async () => `${(await import("../version.js")).VERSION}\n`],
]);

/**
 * The text `command` prints, or undefined when it is not one of these — in
 * which case the caller falls through to the full CLI, which owns unknown-command
 * reporting.
 */
export function constantCommand(
	command: string | undefined,
): (() => Promise<string>) | undefined {
	return command === undefined ? undefined : CONSTANT_COMMANDS.get(command);
}
