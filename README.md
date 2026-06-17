# MCP ts-morph Refactoring Tools

An MCP server that uses [ts-morph](https://ts-morph.com/) to provide AST-based refactoring operations for TypeScript / JavaScript codebases. Rename symbols, rename files/folders, find references, and more — all while preserving project-wide consistency.

## Table of Contents

- [Quick Start](#quick-start)
- [Available Tools](#available-tools)
- [Logging Configuration](#logging-configuration)
- [Development](#development)
- [Release](#release)
- [License](#license)

## Quick Start

Add the following to your MCP client configuration file (`mcp.json` or equivalent). Using `npx` ensures the latest published version is used automatically.

```json
{
  "mcpServers": {
    "mcp-tsmorph-refactor": {
      "command": "npx",
      "args": ["-y", "@sirosuzume/mcp-tsmorph-refactor"],
      "env": {}
    }
  }
}
```

To customize logging, see [Logging Configuration](#logging-configuration). To run from a local build, see [Development](#development).

## Available Tools

Each tool uses `ts-morph` to parse the AST and applies changes while preserving project-wide references. All tools require the path to the project's `tsconfig.json`.

| Tool | Description |
| --- | --- |
| [`rename_symbol_by_tsmorph`](#rename_symbol_by_tsmorph) | Rename a symbol across the entire project |
| [`rename_filesystem_entry_by_tsmorph`](#rename_filesystem_entry_by_tsmorph) | Rename files/folders and update all import paths |
| [`find_references_by_tsmorph`](#find_references_by_tsmorph) | List all definitions and references for a symbol |
| [`remove_path_alias_by_tsmorph`](#remove_path_alias_by_tsmorph) | Replace path aliases with relative paths |
| [`move_symbol_to_file_by_tsmorph`](#move_symbol_to_file_by_tsmorph) | Move a symbol to another file and update all references |
| [`change_signature_by_tsmorph`](#change_signature_by_tsmorph) | Add/remove/reorder function parameters and update all call sites |
| [`get_type_at_position_by_tsmorph`](#get_type_at_position_by_tsmorph) | Get the inferred type at a given position |
| [`find_unused_exports_by_tsmorph`](#find_unused_exports_by_tsmorph) | List candidates for unused exports |
| [`convert_default_export_to_named_by_tsmorph`](#convert_default_export_to_named_by_tsmorph) | Convert a default export to a named export and update all importers |

### `rename_symbol_by_tsmorph`

Renames a symbol (function, variable, class, interface, etc.) at a specific position in a file across the entire project.

- **Use case**: When there are many references and manual renaming is impractical.
- **Required information**: Target file path, symbol position (line and column), current symbol name, new symbol name.

### `rename_filesystem_entry_by_tsmorph`

Renames multiple files and/or folders and automatically updates all `import` / `export` statement paths throughout the project.

- **Use case**: Fixing import paths after restructuring files. Renaming or moving multiple files/folders at once.
- **Required information**: An array of rename operations `renames: { oldPath: string, newPath: string }[]`.
- **Behavior**:
  - Reference resolution relies primarily on symbol analysis.
  - References containing path aliases (e.g., `@/`) are updated but **converted to relative paths**.
  - Imports referencing a directory index (e.g., `../components`) are updated to **explicit file paths** (e.g., `../components/index.tsx`).
  - Path conflicts (existing paths, duplicates within the operation set) are checked before execution.
- **Note**: Analysis and updating may take time for large numbers of files/folders or very large projects. References to default exports in the form `export default Identifier;` may not be updated correctly (known limitation).

### `find_references_by_tsmorph`

Finds and lists the definition and all references of a symbol at a specific position in a file, across the entire project.

- **Use case**: Understanding where a function or variable is used. Assessing the impact scope of a refactoring.
- **Required information**: Target file path, symbol position (line and column).

### `remove_path_alias_by_tsmorph`

Replaces path aliases (e.g., `@/components`) in `import` / `export` statements within a specified file or directory with relative paths (e.g., `../../components`).

- **Use case**: Improving project portability, or conforming to a specific coding convention.
- **Required information**: Path of the target file or directory to process.

### `move_symbol_to_file_by_tsmorph`

Moves a specified symbol (function, variable, class, interface, type alias, or enum) to another file and automatically updates all references (including import/export paths) throughout the project.

- **Use case**: Extracting specific functionality into a separate file to reorganize code structure.
- **Required information**: Source and destination file paths, name of the symbol to move. If multiple symbols share the same name, specify the kind (`declarationKindString`) to disambiguate.
- **Behavior**: Internal dependencies used only within the moved symbol are moved along with it. Dependencies also referenced by other symbols in the source file remain in place, and `export` is added as needed so the destination can import them.
- **Note**: Symbols exported as default exports (`export default`) cannot be moved.

### `change_signature_by_tsmorph`

Adds, removes, or reorders parameters of a function, method, or arrow function, and updates the arguments at all call sites throughout the project.

- **Use case**: Adding a required parameter to a widely-called function; removing or reordering parameters of a function referenced via imports, re-exports, or method chains. Ensures updates that an LLM's one-shot edits might miss are reliably applied via the type checker.
- **Required information**: Target file path, position (line and column) of the function name identifier, function name, array of `operations` to apply.
- **Operations (`operations`)**:
  - `add`: Inserts a parameter at `index` (defaults to end). If `argumentForCallers` is specified, inserts that text at the corresponding position in each call site. If omitted, call sites are not modified (intended for trailing optional/default parameters).
  - `remove`: Removes the parameter at `index`. Removes the corresponding argument from any call site that passes that many or more arguments.
  - `reorder`: Reconstructs the parameter list and all call sites according to `newOrder`. Fails if any call site has a mismatched number of arguments.
  - Operations are applied in order; each subsequent operation references the parameter list after the preceding operation has been applied.
- **Note**: Call sites with spread arguments (`fn(...args)`) will fail for operations that modify arguments. Use `dryRun: true` to preview affected files when there are many call sites. Use `rename_symbol_by_tsmorph` to rename parameters and `move_symbol_to_file_by_tsmorph` to move functions.

### `get_type_at_position_by_tsmorph`

Returns the TypeChecker-inferred type, symbol, and declaration location at a specified position in a TypeScript / JavaScript file.

- **Use case**: Quickly checking "what is the actual inferred type of this variable / expression / function" without launching `tsc`. Getting a type signature more cheaply than `Read`-ing a declaration file. Verifying the actual shape of a value before refactoring.
- **Required information**: Target file path, position to inspect (line and column).
- **Note**: Pointing at whitespace or comment lines returns the file-level inferred type (e.g., `typeof import("...")`), which is usually not the intended result. Check `nodeKind` in the response and re-target to an identifier. For analyzing many positions in bulk, use `tsc` directly.

### `find_unused_exports_by_tsmorph`

Scans the entire project and lists `export` declarations that are not referenced from outside declaration files as candidates for removal.

- **Detection targets**: Inline `export` (`export function/class/const/let/var/enum/interface/type`), `export default` (identifier, function, or class), `export = <Identifier>`.
- **Detection method**: From the results of `findReferencesAsNodes()`, references within the same file, references under an `ExportDeclaration` (pure re-exports such as `export { x } from "./y"`), and references inside `node_modules` are excluded. If zero references remain, the export is flagged as an unused candidate.
- **Use case**: Dead code cleanup, auditing the public surface of a module. **Always double-check with `find_references_by_tsmorph` before deleting.**
- **`sameFileRefs` (deciding between deletion vs. unexport)**: Each candidate includes the number of references to it within the same file (excluding the declaration itself and re-export sites). Because reported candidates are by definition "not referenced outside the declaration file," the delete action depends on this value.
  - `sameFileRefs=0`: Also unused within the same file — **truly dead. Safe to delete the declaration entirely** (also verify with `textHits=0` for extra confidence).
  - `sameFileRefs=1+`: Used within the same file — **only the `export` keyword is unnecessary**. Keep the declaration (deleting it would break same-file references). Deleting all reported declarations indiscriminately will break the build.
- **`textOccurrences` (`textHits`)**: The number of occurrences of `\b<name>\b` in source files other than declaration files. `0` means "the name does not appear in other files," but whether it is used within the same file is separate — check `sameFileRefs` for that (this field alone cannot determine "safe to delete"). `1+` suggests possible string literals / JSX / dynamic references — verify with `find_references_by_tsmorph`.
- **False positives for default exports**: Candidates tagged with `[default]` (`export default <Identifier>` / `export = <Identifier>`) are prone to false positives because `findReferencesAsNodes` does not link to `import Foo from "./mod"` default imports. Default exports with `textHits` significantly greater than 0 are almost certainly in use. Treat them as low-confidence and always verify with `find_references_by_tsmorph`.
- **`responseFormat`**: `"list"` (default, one line per candidate) / `"summary"` (project-wide aggregates: total count, deletion-safety breakdown, by kind, by directory). In large repositories, listing all candidates can exceed the response size limit, so it is safer to first use `"summary"` to identify where dead code is concentrated, then narrow down with `entryPoints` / `excludeFilePatterns` before using `"list"` for precise locations (`summary` scans the entire project regardless of `maxResults`).
- **Options**: `entryPoints` (array of absolute paths; always treated as in-use public API), `excludeFilePatterns` (exclude scan targets by substring match), `maxResults` (limit for list mode; default 100), `expandNamespaceImports` (default ON).
- **Known limitations**: Dynamic `require` / `import()`, routing that depends on filesystem conventions (e.g., Next.js `page.tsx`), and references via string reflection cannot be detected. Use `entryPoints` / `excludeFilePatterns` to narrow down candidates.
- **Monorepo built dist packages produce systematic false positives**: If a workspace package publishes a build artifact (e.g., `./dist/index.js`) via `exports` (or `main` / `module` / `types`) in `package.json`, imports from other packages resolve to the build output (or `node_modules`) rather than to the scanned `src` symbols. As a result, **all exports that are actually consumed from that package appear as unused candidates in bulk**. This pattern is detected structurally, and a per-package warning (package name, entry point outside scan scope, number of affected candidates) is prepended to the results. Treat candidates from packages with this warning as low-confidence, and always verify with `textHits` and `find_references_by_tsmorph` before deleting. Workaround: point that package's `exports` to source (e.g., `./src/index.ts`) during analysis, or verify candidates individually.

### `convert_default_export_to_named_by_tsmorph`

Converts a file's `export default` into a named export and rewrites every importing/re-exporting site across the project.

- **Use case**: Migrating a module off default exports (e.g. to satisfy a "no default export" lint rule) without hand-editing every importer, or normalizing a default that is imported under inconsistent local names onto a single named export.
- **Required information**: Target file path. `newName` is required when the default export is anonymous (e.g. `export default () => {}`, `export default { ... }`, `export default function () {}`) and is rejected (when it differs) for an already-named function/class default export.
- **Supported target forms**: named/anonymous `export default function`/`class`; `export default <expr>` (arrow, object literal, call, literal); `export default <localIdentifier>`; `export { foo as default }`.
- **Reference updates**: `import Foo from "target"` and the named-specifier form `import { default as Foo } from "target"` both become `import { Name as Foo } from "target"` (the alias is dropped when the local name already equals `Name`); default imports are merged into existing named imports (deduping identical specifiers), or split into a separate declaration when a namespace import (`import Foo, * as ns`) is present (reusing an existing same-module declaration when one exists); `export { default } from "target"` and `export { default as X } from "target"` are rewritten to named re-exports. Path-alias and relative specifiers are both resolved via the TypeChecker.
- **Safety**: `newName` is validated as a non-reserved identifier; the conversion aborts if the resulting name would collide with an existing export in the target file, and anonymous abstract classes are rejected (they have no valid expression form) — so the tool never emits invalid TypeScript for these cases.
- **Note**: Run with `dryRun: true` first to preview the impacted files. Dynamic/runtime access to the default (`import("target").then(m => m.default)`, `require("target").default`) is not detected. A re-export that forwards the default as a default (`export { default } from "target"`) becomes a named re-export, changing that barrel's public surface; **transitive** chains are not followed (only sites whose module specifier resolves directly to the target are updated), so verify downstream consumers of such barrels.

## Logging Configuration

Server operation logs are controlled via environment variables, set in the `env` block of `mcp.json`.

| Environment Variable | Description | Default |
| --- | --- | --- |
| `LOG_LEVEL` | Log verbosity: `fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent` | `info` |
| `LOG_OUTPUT` | Output destination: `console` or `file` | `console` |
| `LOG_FILE_PATH` | Absolute path to the log file when `LOG_OUTPUT=file` | `[project root]/app.log` |

When `LOG_OUTPUT=console` and the development environment (`NODE_ENV !== 'production'`) has `pino-pretty` installed, output is formatted for readability. All logs and startup diagnostic messages are written to standard error (stderr), so they do not pollute the standard output (JSON-RPC) used by the MCP client. Set `LOG_LEVEL=silent` to suppress all log output.

Configuration example:

```json
{
  "mcpServers": {
    "mcp-tsmorph-refactor": {
      "command": "npx",
      "args": ["-y", "@sirosuzume/mcp-tsmorph-refactor"],
      "env": {
        "LOG_LEVEL": "debug",
        "LOG_OUTPUT": "file",
        "LOG_FILE_PATH": "/Users/yourname/logs/mcp-tsmorph.log"
      }
    }
  }
}
```

## Development

### Prerequisites

- Node.js (see the `volta` field in `package.json` for the version)
- pnpm (see the `packageManager` field in `package.json` for the version)

### Setup and Build

```bash
git clone https://github.com/sirosuzume/mcp-tsmorph-refactor.git
cd mcp-tsmorph-refactor
pnpm install
pnpm build      # outputs to dist/
```

### Main Commands

```bash
pnpm test       # run tests
pnpm test:watch # run tests in watch mode
pnpm check-types # type check (no compilation)
pnpm lint       # lint check
pnpm lint:fix   # lint fix
pnpm format     # format
pnpm inspector  # debug with MCP Inspector
```

### Using a Local Build with an MCP Client

After building, you can launch `dist/index.js` directly with `node`.

```json
{
  "mcpServers": {
    "mcp-tsmorph-refactor-dev": {
      "command": "node",
      "args": ["/path/to/your/local/repo/dist/index.js"],
      "env": {
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

### Debug Launcher

To inspect the server's startup sequence and stdio in detail, use `scripts/mcp_launcher.js`. It launches the actual server process as a child process and records startup information and output to `.logs/mcp_launcher.log`.

Change the `command` in `mcp.json` to `"node"` and `args` to the path of `scripts/mcp_launcher.js`, then restart the client to view `.logs/mcp_launcher.log` (and the server's own logs).

```json
{
  "mcpServers": {
    "mcp-tsmorph-refactor": {
      "command": "node",
      "args": ["scripts/mcp_launcher.js"],
      "env": {
        "LOG_OUTPUT": "file",
        "LOG_FILE_PATH": ".logs/mcp-ts-morph.log"
      }
    }
  }
}
```

## Release

This package is published to npm automatically via the GitHub Actions workflow (`.github/workflows/release.yml`).

**The Git tag is the single source of truth for the version.** Both `version` in `package.json` and `VERSION` in `src/version.ts` are fixed at `0.0.0-development`; the release workflow reads the tag and bakes the value in. **No manual version bump is needed.**

### Publishing Steps

```bash
git checkout main && git pull --ff-only
git tag v1.2.0
git push origin v1.2.0
```

Pushing the tag triggers the workflow, which executes the following in order:

1. Extract VERSION (`1.2.0`) from the tag (`v1.2.0`) (strict SemVer only; pre-releases are not supported)
2. Run `pnpm test` with the placeholder version still in place
3. Run `node scripts/release-version.mjs --bake 1.2.0` to rewrite `VERSION` in `src/version.ts` and `version` in `package.json`
4. Run `pnpm build`
5. Verify with `grep -F` that `dist/version.js` contains `exports.VERSION = "1.2.0";`
6. Remove `_version_note` from `package.json`
7. Publish to npm with `pnpm publish --provenance` (Trusted Publishing / OIDC)

After completion, confirm the release with `npm view @sirosuzume/mcp-tsmorph-refactor version`.

> npm Trusted Publishing is required. `NPM_TOKEN` has been retired; publishing is done via GitHub Actions OIDC (see `id-token: write` in `release.yml`).

### Why the Tag Is the Source of Truth

Under the old workflow, releasing required three steps — "bump `version` in `package.json`", "bump `serverInfo.version` in `src/mcp/config.ts`", and "push a tag" — and forgetting any one of them resulted in an inconsistent release (this actually happened). Under the new workflow, `0.0.0-development` is kept throughout development and CI reads the tag at release time to update all locations, making it **structurally impossible to forget a bump**.

CI (`.github/workflows/ci.yml`) runs `node scripts/release-version.mjs --check` on every PR and push to main to confirm that both files still have the placeholder value. A PR that manually bumps the version will fail here.

### Recovery from Failures

- If the workflow fails partway through, **do not delete the tag**. Merge a fix into main and create the next patch tag (`vX.Y.(Z+1)`) (fix forward).
- Re-publishing with the same tag is impossible due to npm's immutability, so overwriting the tag is pointless.

## License

This project is published under the MIT License. See the [LICENSE](LICENSE) file for details.
