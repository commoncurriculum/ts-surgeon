#!/usr/bin/env node
// Keep stderr quiet for one-shot CLI runs unless the user asks for logs.
// The import below is dynamic so the logger (initialized on module load)
// picks up this default. The `hook` command must be completely silent:
// harnesses feed its stderr verbatim to the agent as the block reason.
process.env.LOG_LEVEL =
	process.argv[2] === "hook" ? "silent" : (process.env.LOG_LEVEL ?? "warn");

/**
 * Commands that answer from a string constant, routed before cli.js is
 * imported. cli.js pulls in the tool registry, and through it ts-morph and the
 * TypeScript compiler — ~400ms of the ~1s a no-work command spent starting up
 * (measured 2026-07-29, on top of whatever npx charges to resolve the package
 * in the first place). Printing the guide has no business paying for a
 * compiler.
 */
const CONSTANT_COMMANDS: Record<string, () => Promise<string>> = {
	guide: async () => (await import("./guide.js")).GUIDE,
	"--version": async () => `${(await import("./version.js")).VERSION}\n`,
	"-v": async () => `${(await import("./version.js")).VERSION}\n`,
};

const answer = CONSTANT_COMMANDS[process.argv[2]];
const run = answer
	? answer().then((text) => {
			process.stdout.write(text);
			return 0;
		})
	: import("./cli.js").then(({ runCli }) => runCli(process.argv.slice(2)));

run
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch((error: Error) => {
		process.stderr.write(`Fatal error: ${error.message}\n`);
		process.exitCode = 1;
	});
