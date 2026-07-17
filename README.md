# ts-morph Refactoring Tools

A CLI that uses [ts-morph](https://ts-morph.com/) to provide AST-based refactoring operations for TypeScript / JavaScript codebases. Rename symbols, rename files/folders, find references, and more — all while preserving project-wide consistency. Built for coding agents (invoke it directly via shell, [ast-grep agent-skill](https://github.com/ast-grep/agent-skill) style) and equally usable from scripts and CI.

## Table of Contents

- [Quick Start](#quick-start)
- [Use with any coding agent](#use-with-any-coding-agent)
- [Available Tools](#available-tools)
- [Logging Configuration](#logging-configuration)
- [Development](#development)
- [Release](#release)
- [License](#license)

## Quick Start

No install needed — run straight from npm with `npx` (or install globally with `npm i -g @commoncurriculum/ts-surgeon` for a bare `ts-surgeon` command):

```bash
# Discover tools and their parameter schemas
npx -y @commoncurriculum/ts-surgeon list
npx -y @commoncurriculum/ts-surgeon describe rename_symbol

# Run a tool with flags — kebab-case maps to the schema's camelCase, dots nest
npx -y @commoncurriculum/ts-surgeon call rename_symbol \
  --target-file-path src/utils.ts \
  --symbol-name calculateSum --new-name addNumbers --dry-run

# Or pass the whole parameter object as JSON
npx -y @commoncurriculum/ts-surgeon call rename_symbol --params '{
  "targetFilePath": "src/utils.ts",
  "symbolName": "calculateSum",
  "newName": "addNumbers",
  "dryRun": true
}'
```

- **Relative paths** are resolved against the working directory, and **`tsconfigPath` is auto-discovered** (nearest `tsconfig.json` above the target file) when omitted.
- **`position` is optional** for `rename_symbol` / `find_references` / `change_signature` / `get_type_at_position`: when omitted, the symbol is located by its declaration name (`symbolName` / `functionName`), which must be unambiguous in the file — the error lists candidate positions otherwise (`{ "position": { "line": 1, "column": 17 } }`, 1-based).
- `--json` prints a machine-readable result: `{ tool, status, data, message }` (e.g. `data.changedFiles`).
- `batch` runs several tools in one process: pass a JSON array of `{ "tool": "...", "params": { ... } }` via `--params`, `--params-file`, or stdin. Output is a JSON array; it stops at the first failure unless `--continue-on-error` is set. Operations **share one parsed project per tsconfig** (one AST parse for N operations; later ops see earlier results) — pass `--fresh-project` to re-parse from disk per operation.
- `call` also accepts `--params-file <path>` or JSON piped via stdin (handy for large payloads); flags win when combined with JSON.
- `--stdin-files` turns a piped file list into `filePaths` — `git diff --name-only | npx -y @commoncurriculum/ts-surgeon call organize_imports --stdin-files` (non-source and missing paths are skipped; refuses to run if nothing usable arrives).
- Tool names accept dashes (`rename-symbol`) and the legacy `*_by_tsmorph` aliases.
- Exit codes: `0` success, `1` the tool reported an error, `2` usage error (including params that fail the tool's schema).
- Tool output goes to stdout; logs go to stderr (`LOG_LEVEL` defaults to `warn`).

To customize logging, see [Logging Configuration](#logging-configuration). To run from a local build, see [Development](#development).

## Use with any coding agent

The CLI is self-describing, so it works with **any** coding agent that can run shell commands — no editor plugin, no protocol, no vendor-specific config:

```bash
npx -y @commoncurriculum/ts-surgeon guide   # the full agent guide: when to use which tool, the survey→change→verify loop, anti-patterns
```

To make an agent reach for it, run `npx -y @commoncurriculum/ts-surgeon init` (appends the snippet below to `AGENTS.md`; `--file CLAUDE.md` or any other path works too), or add it yourself to your project's agent instructions file (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or equivalent):

```markdown
## Refactoring

For TypeScript/JavaScript refactors that cross file boundaries (renames, moves,
signature changes, finding references, dead-code checks), do not hand-edit.
Use the ts-morph refactoring CLI:

    npx -y @commoncurriculum/ts-surgeon guide   # read this first
    npx -y @commoncurriculum/ts-surgeon list    # tool names + summaries
```

Claude Code users can alternatively copy the richer skill from [`.claude/skills/ts-morph-refactoring/`](.claude/skills/ts-morph-refactoring/).

### Guard against hand-rolled refactors

Instructions files are advisory — agents still sometimes reach for `sed`. The `hook` command turns the advice into an enforced guard for harnesses that support pre-tool hooks (Claude Code today):

```bash
npx -y @commoncurriculum/ts-surgeon init --claude-hook   # installs into .claude/settings.json
```

Once installed, any Bash command that hand-edits TS/JS sources with `sed -i`/`perl -i` is blocked before it runs, and the agent is told to use the AST-accurate tool instead (with `--dry-run` guidance). A genuine non-refactor use is one prefix away: `TS_SURGEON_ALLOW=1 sed -i …`. Pass `--strict` in the hook command to also redirect recursive identifier searches (`grep -r name` / `rg name`) to `find_references`.

## Available Tools

Each tool uses `ts-morph` to parse the AST and applies changes while preserving project-wide references. Every tool resolves against a `tsconfig.json` (auto-discovered when not passed explicitly).

| Tool | Description |
| --- | --- |
| [`rename_symbol`](#rename_symbol) | Rename a symbol across the entire project |
| [`rename_filesystem_entry`](#rename_filesystem_entry) | Rename files/folders and update all import paths |
| [`find_references`](#find_references) | List all definitions and references for a symbol |
| [`remove_path_alias`](#remove_path_alias) | Replace path aliases with relative paths |
| [`move_symbol_to_file`](#move_symbol_to_file) | Move a symbol to another file and update all references |
| [`change_signature`](#change_signature) | Add/remove/reorder function parameters and update all call sites |
| [`get_type_at_position`](#get_type_at_position) | Get the inferred type at a given position |
| [`find_unused_exports`](#find_unused_exports) | List candidates for unused exports |
| [`convert_default_export_to_named`](#convert_default_export_to_named) | Convert a default export to a named export and update all importers |
| [`organize_imports`](#organize_imports) | Remove unused imports, sort, and coalesce them across files |
| [`get_diagnostics`](#get_diagnostics) | Report TypeScript type errors/warnings for files or the project |
| [`convert_named_export_to_default`](#convert_named_export_to_default) | Convert a named export to the default export and update all importers |
| [`add_missing_imports`](#add_missing_imports) | Add imports for unresolved identifiers across files |
| [`apply_code_fix`](#apply_code_fix) | Apply a TypeScript "fix all" quick-fix (remove unused, implement members, infer types) |
| [`safe_delete_symbol`](#safe_delete_symbol) | Delete a symbol only when it has no references, else report blockers |

### `rename_symbol`

Renames a symbol (function, variable, class, interface, etc.) at a specific position in a file across the entire project.

- **Use case**: When there are many references and manual renaming is impractical.
- **Required information**: Target file path, current symbol name, new symbol name. Position (line/column) only when the name is ambiguous in the file.

### `rename_filesystem_entry`

Renames multiple files and/or folders and automatically updates all `import` / `export` statement paths throughout the project.

- **Use case**: Fixing import paths after restructuring files. Renaming or moving multiple files/folders at once.
- **Required information**: An array of rename operations `renames: { oldPath: string, newPath: string }[]`.
- **Behavior**:
  - Reference resolution relies primarily on symbol analysis.
  - References containing path aliases (e.g., `@/`) are updated but **converted to relative paths**.
  - Imports referencing a directory index (e.g., `../components`) are updated to **explicit file paths** (e.g., `../components/index.tsx`).
  - Path conflicts (existing paths, duplicates within the operation set) are checked before execution.
- **Note**: Analysis and updating may take time for large numbers of files/folders or very large projects. References to default exports in the form `export default Identifier;` may not be updated correctly (known limitation).

### `find_references`

Finds and lists the definition and all references of a symbol at a specific position in a file, across the entire project.

- **Use case**: Understanding where a function or variable is used. Assessing the impact scope of a refactoring.
- **Required information**: Target file path, plus either the symbol's declaration name or its position (line and column).

### `remove_path_alias`

Replaces path aliases (e.g., `@/components`) in `import` / `export` statements within a specified file or directory with relative paths (e.g., `../../components`).

- **Use case**: Improving project portability, or conforming to a specific coding convention.
- **Required information**: Path of the target file or directory to process.

### `move_symbol_to_file`

Moves a specified symbol (function, variable, class, interface, type alias, or enum) to another file and automatically updates all references (including import/export paths) throughout the project.

- **Use case**: Extracting specific functionality into a separate file to reorganize code structure.
- **Required information**: Source and destination file paths, name of the symbol to move. If multiple symbols share the same name, specify the kind (`declarationKindString`) to disambiguate.
- **Behavior**: Internal dependencies used only within the moved symbol are moved along with it. Dependencies also referenced by other symbols in the source file remain in place, and `export` is added as needed so the destination can import them.
- **Note**: Symbols exported as default exports (`export default`) cannot be moved.

### `change_signature`

Adds, removes, or reorders parameters of a function, method, or arrow function, and updates the arguments at all call sites throughout the project.

- **Use case**: Adding a required parameter to a widely-called function; removing or reordering parameters of a function referenced via imports, re-exports, or method chains. Ensures updates that an LLM's one-shot edits might miss are reliably applied via the type checker.
- **Required information**: Target file path, position (line and column) of the function name identifier, function name, array of `operations` to apply.
- **Operations (`operations`)**:
  - `add`: Inserts a parameter at `index` (defaults to end). If `argumentForCallers` is specified, inserts that text at the corresponding position in each call site. If omitted, call sites are not modified (intended for trailing optional/default parameters).
  - `remove`: Removes the parameter at `index`. Removes the corresponding argument from any call site that passes that many or more arguments.
  - `reorder`: Reconstructs the parameter list and all call sites according to `newOrder`. Fails if any call site has a mismatched number of arguments.
  - Operations are applied in order; each subsequent operation references the parameter list after the preceding operation has been applied.
- **Note**: Call sites with spread arguments (`fn(...args)`) will fail for operations that modify arguments. Use `dryRun: true` to preview affected files when there are many call sites. Use `rename_symbol` to rename parameters and `move_symbol_to_file` to move functions.

### `get_type_at_position`

Returns the TypeChecker-inferred type, symbol, and declaration location at a specified position in a TypeScript / JavaScript file.

- **Use case**: Quickly checking "what is the actual inferred type of this variable / expression / function" without launching `tsc`. Getting a type signature more cheaply than `Read`-ing a declaration file. Verifying the actual shape of a value before refactoring.
- **Required information**: Target file path, position to inspect (line and column).
- **Note**: Pointing at whitespace or comment lines returns the file-level inferred type (e.g., `typeof import("...")`), which is usually not the intended result. Check `nodeKind` in the response and re-target to an identifier. For analyzing many positions in bulk, use `tsc` directly.

### `find_unused_exports`

Scans the entire project and lists `export` declarations that are not referenced from outside declaration files as candidates for removal.

- **Detection targets**: Inline `export` (`export function/class/const/let/var/enum/interface/type`), `export default` (identifier, function, or class), `export = <Identifier>`.
- **Detection method**: From the results of `findReferencesAsNodes()`, references within the same file, references under an `ExportDeclaration` (pure re-exports such as `export { x } from "./y"`), and references inside `node_modules` are excluded. If zero references remain, the export is flagged as an unused candidate.
- **Use case**: Dead code cleanup, auditing the public surface of a module. **Always double-check with `find_references` before deleting.**
- **`sameFileRefs` (deciding between deletion vs. unexport)**: Each candidate includes the number of references to it within the same file (excluding the declaration itself and re-export sites). Because reported candidates are by definition "not referenced outside the declaration file," the delete action depends on this value.
  - `sameFileRefs=0`: Also unused within the same file — **truly dead. Safe to delete the declaration entirely** (also verify with `textHits=0` for extra confidence).
  - `sameFileRefs=1+`: Used within the same file — **only the `export` keyword is unnecessary**. Keep the declaration (deleting it would break same-file references). Deleting all reported declarations indiscriminately will break the build.
- **`textOccurrences` (`textHits`)**: The number of occurrences of `\b<name>\b` in source files other than declaration files. `0` means "the name does not appear in other files," but whether it is used within the same file is separate — check `sameFileRefs` for that (this field alone cannot determine "safe to delete"). `1+` suggests possible string literals / JSX / dynamic references — verify with `find_references`.
- **False positives for default exports**: Candidates tagged with `[default]` (`export default <Identifier>` / `export = <Identifier>`) are prone to false positives because `findReferencesAsNodes` does not link to `import Foo from "./mod"` default imports. Default exports with `textHits` significantly greater than 0 are almost certainly in use. Treat them as low-confidence and always verify with `find_references`.
- **`responseFormat`**: `"list"` (default, one line per candidate) / `"summary"` (project-wide aggregates: total count, deletion-safety breakdown, by kind, by directory). In large repositories, listing all candidates can exceed the response size limit, so it is safer to first use `"summary"` to identify where dead code is concentrated, then narrow down with `entryPoints` / `excludeFilePatterns` before using `"list"` for precise locations (`summary` scans the entire project regardless of `maxResults`).
- **Options**: `entryPoints` (array of absolute paths; always treated as in-use public API), `excludeFilePatterns` (exclude scan targets by substring match), `maxResults` (limit for list mode; default 100), `expandNamespaceImports` (default ON).
- **Known limitations**: Dynamic `require` / `import()`, routing that depends on filesystem conventions (e.g., Next.js `page.tsx`), and references via string reflection cannot be detected. Use `entryPoints` / `excludeFilePatterns` to narrow down candidates.
- **Monorepo built dist packages produce systematic false positives**: If a workspace package publishes a build artifact (e.g., `./dist/index.js`) via `exports` (or `main` / `module` / `types`) in `package.json`, imports from other packages resolve to the build output (or `node_modules`) rather than to the scanned `src` symbols. As a result, **all exports that are actually consumed from that package appear as unused candidates in bulk**. This pattern is detected structurally, and a per-package warning (package name, entry point outside scan scope, number of affected candidates) is prepended to the results. Treat candidates from packages with this warning as low-confidence, and always verify with `textHits` and `find_references` before deleting. Workaround: point that package's `exports` to source (e.g., `./src/index.ts`) during analysis, or verify candidates individually.

### `convert_default_export_to_named`

Converts a file's `export default` into a named export and rewrites every importing/re-exporting site across the project.

- **Use case**: Migrating a module off default exports (e.g. to satisfy a "no default export" lint rule) without hand-editing every importer, or normalizing a default that is imported under inconsistent local names onto a single named export.
- **Required information**: Target file path. `newName` is required when the default export is anonymous (e.g. `export default () => {}`, `export default { ... }`, `export default function () {}`) and is rejected (when it differs) for an already-named function/class default export.
- **Supported target forms**: named/anonymous `export default function`/`class`; `export default <expr>` (arrow, object literal, call, literal); `export default <localIdentifier>`; `export { foo as default }`.
- **Reference updates**: `import Foo from "target"` and the named-specifier form `import { default as Foo } from "target"` both become `import { Name as Foo } from "target"` (the alias is dropped when the local name already equals `Name`); default imports are merged into existing named imports (deduping identical specifiers), or split into a separate declaration when a namespace import (`import Foo, * as ns`) is present (reusing an existing same-module declaration when one exists); `export { default } from "target"` and `export { default as X } from "target"` are rewritten to named re-exports. Path-alias and relative specifiers are both resolved via the TypeChecker.
- **Safety**: `newName` is validated as a non-reserved identifier; the conversion aborts if the resulting name would collide with an existing export in the target file, and anonymous abstract classes are rejected (they have no valid expression form) — so the tool never emits invalid TypeScript for these cases.
- **Note**: Run with `dryRun: true` first to preview the impacted files. Dynamic/runtime access to the default (`import("target").then(m => m.default)`, `require("target").default`) is not detected. A re-export that forwards the default as a default (`export { default } from "target"`) becomes a named re-export, changing that barrel's public surface; **transitive** chains are not followed (only sites whose module specifier resolves directly to the target are updated), so verify downstream consumers of such barrels.

### `organize_imports`

Runs the editor "Organize Imports" action on specific files (or the whole project): removes unused imports, sorts them, and coalesces multiple imports from the same module.

- **Use case**: Cleaning up unused imports left behind after edits (deleting code, moving symbols), or normalizing import order across a set of files in one pass.
- **Required information**: `tsconfigPath`. `filePaths` is optional — omit it to organize every non-declaration source file in the project.
- **Behavior**: Removes unused named imports (and import declarations that become empty), sorts/coalesces same-module imports, and keeps side-effect-only imports (`import "./x"`). Usage in JSX, type positions, and decorators is accounted for via the TypeScript language service.
- **Note**: Omitting `filePaths` can produce a large diff (it reorders imports project-wide), so prefer passing the files you touched and/or run with `dryRun: true` first. Expect ordering-only diffs even when nothing was unused.

### `get_diagnostics`

Returns the TypeScript pre-emit diagnostics (the type errors, warnings, and suggestions `tsc --noEmit` would report) for specific files or the whole project.

- **Use case**: Validating that an edit/refactor introduced no type errors without spawning a separate `tsc` process, and getting the exact location + code + message of each error to fix it.
- **Required information**: `tsconfigPath`. `filePaths` is optional — omit it to check the whole project (including global diagnostics that have no associated file).
- **Behavior**: Uses `getPreEmitDiagnostics`; results are sorted error → warning → suggestion → message, then by file and 1-based position. Capped at `maxResults` (default 100), with a `truncated` flag.
- **Output**: A summary (total/error/warning counts) plus one line per diagnostic: `<category> TS<code> <file>:<line>:<col> — <message>`. A file-level diagnostic with no specific position renders as just `<file>`; a project-global diagnostic (no associated file) renders as `(global)`.

### `convert_named_export_to_default`

Converts a file's named export into its default export and rewrites every importing/re-exporting site across the project. The inverse of `convert_default_export_to_named`.

- **Use case**: Standardizing a module on a default export (e.g. a component file expected to default-export its component).
- **Required information**: Target file path and the `exportName` to convert (must be a value export, not a `type`/`interface`).
- **Supported target forms**: `export function`/`class Foo` → `export default function`/`class Foo`; `export const/let/var/enum Foo` → keeps the declaration and appends `export default Foo;`; `export { Foo }` / `export { local as Foo }`.
- **Reference updates**: `import { Foo } from "target"` → `import Foo from "target"` (alias preserved as the default's local name), splitting the default out of any combined named import; `export { Foo [as X] } from "target"` → `export { default as Foo|X } from "target"`.
- **Note**: Aborts if the file already has a default export, if `exportName` is re-exported from another file (convert it in its source file), or if it is part of a multi-variable `export const a, b` statement. Namespace-member access (`ns.Foo` from `import * as ns`) is not rewritten — review such sites manually.

### `add_missing_imports`

Adds import statements for unresolved identifiers (the editor "Add all missing imports" action) in specific files or the whole project.

- **Use case**: After writing or pasting code that references not-yet-imported symbols, or clearing "Cannot find name 'X'" errors in bulk.
- **Required information**: `tsconfigPath`. `filePaths` is optional — omit it to process every non-declaration source file.
- **Behavior**: For each unresolved identifier, inserts an import from the best matching export in the project or its dependencies (merging into an existing same-module import where possible), respecting `paths` aliases via the language service.
- **Note**: When an identifier could come from multiple modules the language service picks one — review ambiguous cases. Nothing is added for names with no resolvable export. Omitting `filePaths` processes the whole project, so prefer the files you touched and/or run with `dryRun: true` first.

### `apply_code_fix`

Applies a TypeScript "fix all in file" quick-fix across specific files or the whole project — the automated counterpart to `get_diagnostics`.

- **Supported fixes (`fix`)**: `remove_unused` (delete unused declarations + unused imports), `implement_interface` (stub members missing from an `implements` clause), `implement_abstract_members` (stub inherited `abstract` members), `infer_types_from_usage` (annotate implicit-`any` parameters/variables; only under `noImplicitAny`).
- **Use case**: Bulk-clearing a class of diagnostics surfaced by `get_diagnostics`.
- **Required information**: `tsconfigPath` and the `fix` to apply. `filePaths` is optional — omit it to process every non-declaration source file.
- **Note**: A fix with no matching diagnostic in a file is a no-op. Stubbed member bodies throw `new Error("Method not implemented.")` — review and fill them in. Omitting `filePaths` processes the whole project, so prefer the files you touched and/or run with `dryRun: true` first.

### `safe_delete_symbol`

Deletes a top-level symbol's declaration **only when** it has no references outside its own declaration; otherwise it reports the blocking references and changes nothing. The mutating partner to `find_unused_exports`.

- **Use case**: Removing code you believe is dead, with a type-checker guarantee you won't break a reference you missed.
- **Required information**: Target file path and the `symbolName` (a top-level declaration).
- **Behavior**: Resolves all references via the type checker. References inside the declaration itself (its name, recursive self-calls) are ignored; all other references — other files, same-file usages, local `export { x }` re-exports — block deletion. Overload signatures of the same symbol are deleted together; a single declarator is removed from a multi-variable statement.
- **Note**: If two different symbols share the name, the first in the file is targeted. Imports that become unused after deletion are not removed — follow up with `organize_imports` / `apply_code_fix`.

## Logging Configuration

Operation logs are controlled via environment variables.

| Environment Variable | Description | Default |
| --- | --- | --- |
| `LOG_LEVEL` | Log verbosity: `fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent` | `warn` |
| `LOG_OUTPUT` | Output destination: `console` or `file` | `console` |
| `LOG_FILE_PATH` | Absolute path to the log file when `LOG_OUTPUT=file` | `[project root]/app.log` |

When `LOG_OUTPUT=console` and the development environment (`NODE_ENV !== 'production'`) has `pino-pretty` installed, output is formatted for readability. All logs and startup diagnostic messages are written to standard error (stderr), so they never pollute the tool output on stdout. Set `LOG_LEVEL=silent` to suppress all log output.

Example:

```bash
LOG_LEVEL=debug LOG_OUTPUT=file LOG_FILE_PATH=/tmp/tsmorph.log \
  npx -y @commoncurriculum/ts-surgeon call get_diagnostics \
  --params '{"tsconfigPath": "/abs/path/tsconfig.json"}'
```

## Development

### Prerequisites

- Node.js (see the `volta` field in `package.json` for the version)
- pnpm (see the `packageManager` field in `package.json` for the version)

### Setup and Build

```bash
git clone https://github.com/commoncurriculum/ts-surgeon.git
cd ts-surgeon
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
```

### Using a Local Build

After building, launch `dist/index.js` directly with `node`:

```bash
node dist/index.js list
node dist/index.js call get_diagnostics --params '{"tsconfigPath": "/abs/path/tsconfig.json"}'
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

After completion, confirm the release with `npm view @commoncurriculum/ts-surgeon version`.

> npm Trusted Publishing is required. `NPM_TOKEN` has been retired; publishing is done via GitHub Actions OIDC (see `id-token: write` in `release.yml`).

### Why the Tag Is the Source of Truth

Under the old workflow, releasing required three steps — "bump `version` in `package.json`", "bump the reported version in `src/version.ts`", and "push a tag" — and forgetting any one of them resulted in an inconsistent release (this actually happened). Under the new workflow, `0.0.0-development` is kept throughout development and CI reads the tag at release time to update all locations, making it **structurally impossible to forget a bump**.

CI (`.github/workflows/ci.yml`) runs `node scripts/release-version.mjs --check` on every PR and push to main to confirm that both files still have the placeholder value. A PR that manually bumps the version will fail here.

### Recovery from Failures

- If the workflow fails partway through, **do not delete the tag**. Merge a fix into main and create the next patch tag (`vX.Y.(Z+1)`) (fix forward).
- Re-publishing with the same tag is impossible due to npm's immutability, so overwriting the tag is pointless.

## License

This project is published under the MIT License. See the [LICENSE](LICENSE) file for details.
