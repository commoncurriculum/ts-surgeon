---
name: new-mcp-tool
description: Guides the boilerplate work for adding a new ts-morph refactoring MCP tool to this repository. Covers everything from ts-morph logic, MCP registration file, co-located tests, aggregator registration, and appending entries to README/CLAUDE.md without omissions. Use when "adding a new tool", "creating more MCP tools", "creating a register-*.ts", or similar.
disable-model-invocation: true
---

# Adding a New MCP Tool

The standard procedure for adding a new tool to `@sirosuzume/mcp-tsmorph-refactor`. Because the README tool table and the CLAUDE.md module list have drifted from reality in the past, **documentation updates are treated as part of the same task**.

Follow t-wada-style TDD (test-first → red → green → refactor). Place logic in the ts-morph layer; keep the MCP layer as a thin registration only.

## Files to Create or Update

Assuming the new tool name is `do_something_by_tsmorph` and its logic lives in `src/ts-morph/do-something/`:

1. **ts-morph logic**: `src/ts-morph/do-something/do-something.ts`
   - Implement as a pure function. Accept the `Project` received from `initializeProject(tsconfigPath)` as an argument and return a result object (or consider a Result type).
   - Do not swallow exceptions; throw them so the caller can convert them to messages.
2. **Co-located tests**: `src/ts-morph/do-something/do-something.test.ts`
   - Vitest. Write the tests as specifications first. Minimize mocks; when used, add a comment explaining why.
   - Build temporary projects using helpers in `src/ts-morph/_test-utils/` (refer to existing tests).
   - **Always add test cases for known pitfalls**: whichever of default export / re-export / path alias / cross-node_modules references apply.
3. **MCP registration file**: `src/mcp/tools/register-do-something-tool.ts`
   - Use the existing `register-get-type-at-position-tool.ts` as a template (see template below).
4. **Register with the aggregator**: `src/mcp/tools/ts-morph-tools.ts`
   - Add one import line and call `registerDoSomethingTool(server);` inside `registerTsMorphTools`.
5. **README.md**:
   - Add one row to the "Available Tools" table (`[\`do_something_by_tsmorph\`](#do_something_by_tsmorph)`).
   - Add the corresponding detail section (features, use cases, required info, caveats).
6. **CLAUDE.md**:
   - Add `do-something/` to the module list under the ts-morph layer section.
   - Add one line to "Key Features and Implementation Files".

## register-*.ts Template

Skeleton aligned with existing tools. Four arguments: `server.tool(name, description, zodSchema, handler)`.

```typescript
import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { initializeProject } from "../../ts-morph/_utils/ts-morph-project";
import { doSomething } from "../../ts-morph/do-something/do-something";
import logger from "../../utils/logger";

// Wrap logger calls so that a throw inside the logger does not block MCP response generation
function safeLogError(error: unknown, toolArgs: Record<string, unknown>): void {
	try {
		logger.error({ err: error, toolArgs }, "Error executing do_something_by_tsmorph");
	} catch (loggerErr) {
		console.error("Failed to write error log:", loggerErr);
	}
}

function safeLogInfo(fields: Record<string, unknown>): void {
	try {
		logger.info(fields, "do_something_by_tsmorph tool finished");
	} catch (loggerErr) {
		console.error("Failed to write info log:", loggerErr);
	}
}

export function registerDoSomethingTool(server: McpServer): void {
	server.tool(
		"do_something_by_tsmorph",
		`[ts-morph] <one-line summary>

## When to use
- ...

## When NOT to use
- ...

## Critical constraints
- All paths (\`tsconfigPath\`, ...) MUST be absolute.
- Positions are 1-based (line/column).`,
		{
			tsconfigPath: z.string().describe("Path to the project's tsconfig.json file."),
			// ... other parameters
		},
		async (args) => {
			const startTime = performance.now();
			let message = "";
			let isError = false;
			let duration = "0.00";
			const logArgs = { /* key args */ };

			try {
				const project = initializeProject(args.tsconfigPath);
				const result = doSomething(project /*, ...args */);
				message = /* serialize result to string */ "";
			} catch (error) {
				safeLogError(error, logArgs);
				message = `Error: ${error instanceof Error ? error.message : String(error)}`;
				isError = true;
			} finally {
				const endTime = performance.now();
				duration = ((endTime - startTime) / 1000).toFixed(2);
				safeLogInfo({
					status: isError ? "Failure" : "Success",
					durationMs: Number.parseFloat((endTime - startTime).toFixed(2)),
					...logArgs,
				});
				try {
					logger.flush();
				} catch (flushErr) {
					console.error("Failed to flush logs:", flushErr);
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `${message}\nStatus: ${isError ? "Failure" : "Success"}\nProcessing time: ${duration} seconds`,
					},
				],
				isError,
			};
		},
	);
}
```

## Naming Conventions

- MCP tool name: `snake_case` + `_by_tsmorph` suffix.
- Registration function: `register<PascalCase>Tool`.
- Directory: `kebab-case`.

## Pre-completion Checklist

```bash
pnpm check-types   # no type errors
pnpm test          # all tests pass, including new ones
pnpm format        # Biome formatting
```

Finally, run `/check-docs` to confirm that the registered tool name matches the entries in README/CLAUDE.md.
