# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

MCP ts-morph Refactoring Tools — an MCP server that provides TypeScript/JavaScript refactoring tools using ts-morph.

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

`e2e/` clones pinned versions of real OSS projects (hono / zustand), applies each MCP
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

### Debug
```bash
pnpm inspector    # Debug run with MCP Inspector
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
   - MCP server entry point
   - Starts the STDIO server

2. **MCP layer** (`src/mcp/`)
   - `stdio.ts`: STDIO server implementation
   - `config.ts`: Server configuration
   - `tools/`: MCP tool registration and implementation
     - Each tool is implemented as `register-*.ts`
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

### Registering MCP Tools
Each tool is implemented following this pattern:
1. Define parameters with a Zod schema
2. Tool implementation function (calls the ts-morph layer)
3. Register with `server.setRequestHandler`

### Error Handling
- Use custom error classes
- Log error details with the logger
- Return as an MCP error response

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

For detailed specifications of each feature, see README.md.
