#!/usr/bin/env node
const argv = process.argv.slice(2);

// Both branches import lazily so the logger (initialized on module load)
// picks up the LOG_LEVEL default set below for one-shot CLI runs.
if (argv.length === 0 || argv[0] === "serve") {
	// Start the MCP server (default, keeps existing MCP client configs working)
	import("./mcp/stdio.js")
		.then(({ runStdioServer }) => runStdioServer())
		.catch((error: Error) => {
			process.stderr.write(JSON.stringify({ error: `Fatal error: ${error}` }));
			process.exit(1);
		});
} else {
	// One-shot CLI mode: keep stderr quiet unless the user asks for logs.
	process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";
	import("./cli.js")
		.then(({ runCli }) => runCli(argv))
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((error: Error) => {
			process.stderr.write(`Fatal error: ${error.message}\n`);
			process.exitCode = 1;
		});
}
