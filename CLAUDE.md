# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ts-morph Refactoring Tools — a CLI that provides TypeScript/JavaScript refactoring tools using ts-morph, designed to be driven directly by coding agents via shell (ast-grep agent-skill style).

## Development Commands

### Build
```bash
pnpm build        # Compile TypeScript (output to dist/)
pnpm clean        # Clean the dist directory
```

### Test
```bash
pnpm test         # Run tests (runs in a single thread)
pnpm test:watch   # Run tests in watch mode
pnpm test -- path/to/test.ts  # Run a specific test file
pnpm test:e2e     # Real-repo E2E (clone hono/zustand and apply all tools)
```

### E2E Tests (`pnpm test:e2e`)

`e2e/` clones pinned versions of real OSS projects (hono / zustand), applies each
tool to the real project, and verifies a "green diff" (no new type errors or new test
failures compared to baseline). This catches real-world AST inconsistencies that unit
tests miss (e.g., the reverse-direction import bug in `move_symbol_to_file`).

- Excluded from the default `pnpm test` run (see `exclude` in `vitest.config.ts`). Not
  yet integrated into CI (nightly + manual dispatch planned).
- The first run clones repositories and installs dependencies (`bun` / `pnpm` required;
  if unavailable, baseline is not acquired and each case is skipped). Subsequent runs
  reuse the `e2e/.cache/*.ready` marker files.
- Estimated runtime: 2-3 minutes with cache.

**Instructions for Claude**: For changes that touch refactoring logic in `src/ts-morph/**`
(especially `move-symbol-to-file` / `rename-*` / `remove-path-alias` / `change-signature`),
**run `pnpm test:e2e` at the finishing stage (before committing / before opening a PR)**
to confirm there are no regressions against real repositories. Because this takes time,
run it at the end of a body of work rather than after each iteration. If it is skipped
due to network issues or a missing `bun`, inform the user.

### Type Check, Lint, and Format
```bash
pnpm check-types  # TypeScript type check (no compilation)
pnpm lint         # Lint check with Biome
pnpm lint:fix     # Lint fix with Biome
pnpm format       # Code format with Biome
```

### Running the CLI locally
```bash
pnpm build
node dist/index.js list
node dist/index.js describe rename_symbol
node dist/index.js call <tool> --params '<json>'
```

### Release (version bump)

**The Git tag is the single source of truth. Do not bump manually.**

- Both `version` in `package.json` and `VERSION` in `src/version.ts` are fixed at `0.0.0-development`.
- To release, run `git tag vX.Y.Z && git push origin vX.Y.Z` only.
- `.github/workflows/release.yml` extracts the value from the tag, rewrites both files, and runs `pnpm build` → `pnpm test` → dist consistency check → `pnpm publish`.
- For detailed steps, see `.claude/skills/release/SKILL.md` and the "Release" section of the README.
- When the user says "release", "tag it", or similar, use the release skill.

## Project Structure

### Core Architecture

1. **Entry point**: `src/index.ts`
   - Dispatches to the CLI (`src/cli.ts`): `list` / `describe <tool>` /
     `call <tool>` / `batch` / `guide` (the embedded agent guide, `src/guide.ts`)
   - `call` params: `--params '<json>'`, `--params-file`, stdin JSON, or
     individual `--field` flags (kebab-case → camelCase, dots nest); relative
     paths resolve against cwd and `tsconfigPath` is auto-discovered
   - `--json` emits `{ tool, status, data, message }`
   - Exit codes: 0 success, 1 tool error, 2 usage/params error

2. **Tool layer** (`src/tools/`)
   - `registry.ts`: `ToolRegistry` — holds each tool's name, description, Zod
     schema, and handler; validates params and exposes `list`/`inputSchema`/`call`;
     `resolveName` accepts dashed names and legacy `*_by_tsmorph` aliases
   - Each tool is registered by a `register-*.ts` file
   - All tools are consolidated in `ts-morph-tools.ts`

3. **ts-morph layer** (`src/ts-morph/`)
   - Implements the actual refactoring logic
   - Each feature is implemented as an independent module:
     - `rename-symbol/`: Symbol renaming
     - `rename-file-system/`: File/folder renaming
     - `remove-path-alias/`: Path alias removal
     - `find-references.ts`: Reference search
     - `move-symbol-to-file/`: Moving symbols between files
     - `find-unused-exports.ts`: Unused export detection
     - `change-signature/`: Function signature changes
     - `get-type-at-position/`: Getting type information at a position
     - `convert-default-export/`: Converting a default export to a named export
     - `organize-imports/`: Removing unused imports, sorting, and coalescing
     - `get-diagnostics/`: Reporting TypeScript type errors/warnings
     - `convert-named-to-default/`: Converting a named export to the default export
     - `add-missing-imports/`: Adding imports for unresolved identifiers
     - `apply-code-fix/`: Applying TypeScript "fix all" quick-fixes
     - `safe-delete-symbol/`: Deleting a symbol only when it is unreferenced
   - `_utils/`: Shared utilities
     - `ts-morph-project.ts`: Common project creation logic
   - `_test-utils/`: Test helpers

4. **Utilities** (`src/utils/`)
   - `logger.ts`: Pino-based logger implementation
   - Other shared utilities

5. **Error handling** (`src/errors/`)
   - Custom error class definitions

### Test Structure

- Each feature module has a corresponding `.test.ts` file
- Test framework: Vitest
- Test sandbox: TypeScript code for testing in `packages/sandbox/`

## Important Implementation Patterns

### Creating a ts-morph Project
```typescript
// Use src/ts-morph/_utils/ts-morph-project.ts
import { createTsMorphProject } from "../_utils/ts-morph-project";
const project = createTsMorphProject(tsconfigPath);
```

### Registering Tools
Each `register-*.ts` follows this pattern:
1. Define parameters with a Zod schema and a `[ts-morph] ...` description.
2. Register with `registry.tool(name, description, schema, handler)`.
3. The handler delegates to `runTool(toolName, logArgs, run)` from
   `src/tools/_tool-runner.ts`, which owns the shared shell (timing,
   error mapping, start/finish logging + flush, the `Status` / `Processing
   time` footer, and the response envelope). `run` does only the
   tool-specific work and returns `{ message, log?, data? }` (`data` is the
   machine-readable payload surfaced by `--json`); use
   `formatChangedFiles(files)` for the changed-files list.
4. Tool names are `snake_case` with no suffix (e.g. `rename_symbol`); the
   registry also accepts dashed and legacy `*_by_tsmorph` spellings.

### Cross-file reference rewriting
Tools that rewrite importers/re-exporters of a target file (e.g.
`convert-default-export`, `convert-named-to-default`) share
`forEachReferenceTo(project, target, { onImport, onReExport })` from
`src/ts-morph/_utils/for-each-reference.ts`; the callbacks own the
direction-specific specifier mutation and return the per-site update count.

### Error Handling
- Use custom error classes
- Log error details with the logger
- `runTool` converts thrown errors into an `isError` tool result (CLI exit code 1)

## Development Notes

### Dependencies
- Node.js (managed by Volta; see `volta.node` in `package.json` for the version; currently 22.14.0)
- pnpm (specified by `packageManager` in `package.json`; currently 11.1.2)

### Git Hooks (lefthook)
- pre-commit: Auto-format with Biome
- pre-push: Format check and test run

### Logging
Controllable via environment variables:
- `LOG_LEVEL`: Log level (debug, info, warn, error, etc.)
- `LOG_OUTPUT`: Output destination (console, file)
- `LOG_FILE_PATH`: Path when outputting to a file

### Test Execution Details
- Runs in a single thread (`--pool threads --poolOptions.threads.singleThread`)
- Mocks are automatically reset after each test
- The environment variable `API_ADDRESS` is set during testing

## Key Features and Implementation Files

- **Symbol renaming**: `src/ts-morph/rename-symbol/`
- **File/folder renaming**: `src/ts-morph/rename-file-system/`
- **Reference search**: `src/ts-morph/find-references.ts`
- **Path alias removal**: `src/ts-morph/remove-path-alias/`
- **Symbol moving**: `src/ts-morph/move-symbol-to-file/`
- **Unused export detection**: `src/ts-morph/find-unused-exports.ts`
- **Function signature changes**: `src/ts-morph/change-signature/`
- **Type information retrieval**: `src/ts-morph/get-type-at-position/`
- **Default-to-named export conversion**: `src/ts-morph/convert-default-export/`
- **Import organization**: `src/ts-morph/organize-imports/`
- **Diagnostics retrieval**: `src/ts-morph/get-diagnostics/`
- **Named-to-default export conversion**: `src/ts-morph/convert-named-to-default/`
- **Adding missing imports**: `src/ts-morph/add-missing-imports/`
- **Applying code fixes**: `src/ts-morph/apply-code-fix/`
- **Safe symbol deletion**: `src/ts-morph/safe-delete-symbol/`

For detailed specifications of each feature, see README.md.
