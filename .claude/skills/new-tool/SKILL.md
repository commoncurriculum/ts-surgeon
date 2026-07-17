---
name: new-tool
description: Guides the boilerplate work for adding a new ts-morph refactoring tool to this repository. Covers everything from ts-morph logic, the CLI registration file, co-located tests, aggregator registration, and appending entries to README/CLAUDE.md without omissions. Use when "adding a new tool", "creating more tools", "creating a register-*.ts", or similar.
disable-model-invocation: true
metadata:
  internal: true
---

# Adding a New Tool

The standard procedure for adding a new tool to `@commoncurriculum/ts-surgeon`. Because the README tool table and the CLAUDE.md module list have drifted from reality in the past, **documentation updates are treated as part of the same task**.

Follow t-wada-style TDD (test-first → red → green → refactor). Place logic in the ts-morph layer; keep the tool layer as a thin registration only.

## Files to Create or Update

Assuming the new tool name is `do_something` and its logic lives in `src/ts-morph/do-something/`:

1. **ts-morph logic**: `src/ts-morph/do-something/do-something.ts`
   - Implement as a pure function. Accept the `Project` received from `initializeProject(tsconfigPath)` as an argument and return a result object (or consider a Result type).
   - Do not swallow exceptions; throw them so the caller can convert them to messages.
2. **Co-located tests**: `src/ts-morph/do-something/do-something.test.ts`
   - Vitest. Write the tests as specifications first. Minimize mocks; when used, add a comment explaining why.
   - Build temporary projects using helpers in `src/ts-morph/_test-utils/` (refer to existing tests).
   - **Always add test cases for known pitfalls**: whichever of default export / re-export / path alias / cross-node_modules references apply.
3. **Registration file**: `src/tools/register-do-something-tool.ts`
   - Use the existing `register-safe-delete-symbol-tool.ts` as a template (see template below).
4. **Register with the aggregator**: `src/tools/ts-morph-tools.ts`
   - Add one import line and call `registerDoSomethingTool(registry);` inside `registerTsMorphTools`.
5. **README.md**:
   - Add one row to the "Available Tools" table (`[\`do_something\`](#do_something)`).
   - Add the corresponding detail section (features, use cases, required info, caveats).
6. **CLAUDE.md**:
   - Add `do-something/` to the module list under the ts-morph layer section.
   - Add one line to "Key Features and Implementation Files".

## register-*.ts Template

Skeleton aligned with existing tools. Four arguments: `registry.tool(name, description, zodSchema, handler)`. The shared shell (timing, error mapping, logging + flush, the `Status` / `Processing time` footer, the result envelope) lives in `runTool` — the handler only does tool-specific work.

```typescript
import type { ToolRegistry } from "./registry";
import { z } from "zod";
import { doSomething } from "../ts-morph/do-something/do-something";
import { formatChangedFiles, runTool } from "./_tool-runner";

export function registerDoSomethingTool(registry: ToolRegistry): void {
	registry.tool(
		"do_something",
		`[ts-morph] <one-line summary>

## When to use
- ...

## When NOT to use
- ...

## Critical constraints
- Positions are 1-based (line/column).`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			// ... other parameters
			dryRun: z
				.boolean()
				.optional()
				.default(false)
				.describe("If true, only show intended changes without modifying files."),
		},
		(args) =>
			runTool(
				"do_something",
				{ /* key args for the log line */ },
				async () => {
					const result = await doSomething({ ...args });
					return {
						message: `Done: ...\n - ${formatChangedFiles(result.changedFiles)}`,
						log: { changedFilesCount: result.changedFiles.length },
						data: result, // machine-readable payload for --json
					};
				},
			),
	);
}
```

The CLI picks the tool up automatically: `list` shows it, `describe` prints the Zod schema as JSON Schema, and `call` validates params against it before running the handler.

## Naming Conventions

- Tool name: `snake_case`, no suffix (e.g. `rename_symbol`). The registry
  automatically accepts dashed spellings and the legacy `*_by_tsmorph` aliases.
- Registration function: `register<PascalCase>Tool`.
- Directory: `kebab-case`.

## Pre-completion Checklist

```bash
pnpm check-types   # no type errors
pnpm test          # all tests pass, including new ones
pnpm format        # Biome formatting
```

Finally, run `/check-docs` to confirm that the registered tool name matches the entries in README/CLAUDE.md.
