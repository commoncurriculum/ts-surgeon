#!/usr/bin/env node
import { runStdioServer } from "./mcp/stdio";

// Start the server
runStdioServer().catch((error: Error) => {
	process.stderr.write(JSON.stringify({ error: `Fatal error: ${error}` }));
	process.exit(1);
});
