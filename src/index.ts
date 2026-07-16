#!/usr/bin/env node
// Keep stderr quiet for one-shot CLI runs unless the user asks for logs.
// The import below is dynamic so the logger (initialized on module load)
// picks up this default.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

import("./cli.js")
	.then(({ runCli }) => runCli(process.argv.slice(2)))
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch((error: Error) => {
		process.stderr.write(`Fatal error: ${error.message}\n`);
		process.exitCode = 1;
	});
