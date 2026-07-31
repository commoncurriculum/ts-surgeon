#!/usr/bin/env node
// Safe to import statically: the module body is a lookup table whose thunks own
// the only imports, so it costs nothing and initializes no logger.
import { constantCommand } from "./cli/constant-commands.js";

// Keep stderr quiet for one-shot CLI runs unless the user asks for logs.
// The import below is dynamic so the logger (initialized on module load)
// picks up this default. The `hook` command must be completely silent:
// harnesses feed its stderr verbatim to the agent as the block reason.
process.env.LOG_LEVEL =
	process.argv[2] === "hook" ? "silent" : (process.env.LOG_LEVEL ?? "warn");

const answer = constantCommand(process.argv[2]);
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
