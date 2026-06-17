# Tool reference

Per-tool parameters, worked examples, and gotchas for the
`commoncurriculum/mcp-ts-morph` MCP server. Read
[`SKILL.md`](SKILL.md) first for how to choose and chain these tools.

All paths are absolute. `tsconfigPath` is required by every tool. Positions are
1-based and must land on the identifier. Mutating tools accept `dryRun: true` to
preview the changed-file list without writing.

---

## `rename_symbol_by_tsmorph`
Type-aware rename of a symbol (function, variable, class, type, interface, enum,
parameter, …) across the whole project.

- **When**: any symbol that may be imported, re-exported, or referenced
  elsewhere — and as the safe default even for local-only symbols. Also the
  right tool to **rename a parameter** (vs. changing the signature shape).
- **Params**: `targetFilePath`, `position {line, column}` (on the identifier),
  `symbolName` (current name; sanity-checked against the position), `newName`,
  `dryRun?`.

```json
{
  "tsconfigPath": "/repo/tsconfig.json",
  "targetFilePath": "/repo/src/user.ts",
  "position": { "line": 8, "column": 14 },
  "symbolName": "getUser",
  "newName": "fetchUser"
}
```

- **Gotchas**: fails if `position`/`symbolName` don't match. Not for renaming
  files (`rename_filesystem_entry`) or moving symbols (`move_symbol_to_file`).

---

## `rename_filesystem_entry_by_tsmorph`
Renames/moves files and folders and rewrites every `import`/`export` path.

- **When**: restructuring the file tree. **Batch all moves into one call** — a
  single AST pass is far faster and keeps paths consistent.
- **Params**: `renames: [{ oldPath, newPath }]` (non-empty), `dryRun?`,
  `timeoutSeconds?` (default 120; raise for huge batches).

```json
{
  "tsconfigPath": "/repo/tsconfig.json",
  "renames": [
    { "oldPath": "/repo/src/utils/date.ts", "newPath": "/repo/src/lib/date.ts" },
    { "oldPath": "/repo/src/components", "newPath": "/repo/src/ui" }
  ],
  "dryRun": true
}
```

- **Gotchas**: updated **alias imports (`@/x`) are rewritten as relative paths**;
  barrel imports (`from '../components'`) become explicit index paths
  (`'../components/index.tsx'`). Refuses to run on path conflicts. Bare
  `export default Foo;` references may not update.

---

## `find_references_by_tsmorph`
Lists the definition and every reference of a symbol at a position. Read-only.

- **When**: assess blast radius before a change; confirm a symbol is used. The
  pre-check before any delete.
- **Params**: `targetFilePath`, `position {line, column}`.
- **Tip**: its output gives you `file:line:col` for each site — feed those
  straight into position-taking tools instead of counting columns by hand.

---

## `remove_path_alias_by_tsmorph`
Replaces path aliases (`@/components`) with relative paths (`../../components`)
in a file or directory.

- **When**: improving portability or conforming to a no-alias convention.
- **Params**: `targetPath` (file **or** directory), `dryRun?`.

---

## `move_symbol_to_file_by_tsmorph`
Moves one top-level symbol to another file, carrying its internal-only
dependencies and rewriting all imports/exports.

- **When**: splitting a large file; relocating a helper out of `utils.ts`.
- **Params**: `originalFilePath`, `targetFilePath` (created if missing),
  `symbolToMove`, `declarationKindString?` (one of `FunctionDeclaration`,
  `VariableStatement`, `ClassDeclaration`, `InterfaceDeclaration`,
  `TypeAliasDeclaration`, `EnumDeclaration` — disambiguates same-named decls),
  `dryRun?`.

```json
{
  "tsconfigPath": "/repo/tsconfig.json",
  "originalFilePath": "/repo/src/utils.ts",
  "targetFilePath": "/repo/src/date-utils.ts",
  "symbolToMove": "formatDate",
  "declarationKindString": "FunctionDeclaration"
}
```

- **Gotchas**: **one symbol per call**. **Default exports can't be moved** —
  convert to named first. Deps used only by the moved symbol travel with it;
  shared deps stay put, gain `export`, and are imported back.

---

## `change_signature_by_tsmorph`
Adds, removes, or reorders parameters and updates the arguments at every call
site. The cross-file change LLM one-shot edits miss most.

- **Params**: `targetFilePath`, `position {line, column}` (on the function-name
  identifier — for `const foo = () => {}` point at `foo`), `functionName`,
  `changes: [...]` (applied in order — later ops see the list produced by
  earlier ones), `dryRun?`.
- **`changes` operations** (discriminated by `kind`):
  - `add`: `{ kind, name, index?, typeText?, optional?, defaultValue?, argumentForCallers? }`.
    `index` is 0-based (omit = append). Provide `argumentForCallers` when
    inserting mid-list **or** when the new param is required and callers must be
    updated; omit it only for a trailing optional/defaulted param.
  - `remove`: `{ kind, index }` (0-based). Call sites passing that many args drop
    the matching one.
  - `reorder`: `{ kind, newOrder }` — a permutation of the current indices, e.g.
    `[2, 0, 1]` means `new[0]=old[2]`. Fails if any call site's argument count
    differs.

```json
{
  "tsconfigPath": "/repo/tsconfig.json",
  "targetFilePath": "/repo/src/handlers.ts",
  "position": { "line": 12, "column": 17 },
  "functionName": "handleRequest",
  "changes": [
    { "kind": "add", "index": 0, "name": "ctx", "typeText": "Context", "argumentForCallers": "ctx" }
  ]
}
```

- **Gotchas**: **spread call sites (`fn(...args)`) fail** any argument-modifying
  op — fix them by hand first. Preview with `dryRun: true` when there are many
  callers.

---

## `get_type_at_position_by_tsmorph`
Returns the checker-inferred type, symbol, and declaration location at a
position. Read-only.

- **When**: "what is the actual type here" without spawning `tsc`; a signature
  without reading a whole `.d.ts`.
- **Params**: `targetFilePath`, `position {line, column}`.
- **Gotchas**: check `nodeKind` in the response — a position on whitespace
  yields the file-level `typeof import(...)`, not what you want; re-target to an
  identifier.

---

## `find_unused_exports_by_tsmorph`
Lists exports with no references outside their declaring file. Read-only.
Returns **candidates, not verdicts**.

- **Params**: `entryPoints?` (absolute paths treated as public API — skipped),
  `excludeFilePatterns?` (substring match, e.g. `".test."`), `maxResults?`
  (default 100; list mode), `responseFormat?` (`"list"` | `"summary"`),
  `expandNamespaceImports?` (default true).

```json
{
  "tsconfigPath": "/repo/tsconfig.json",
  "responseFormat": "summary",
  "excludeFilePatterns": [".test.", "/generated/"]
}
```

- **Reading the output**:
  - `sameFileRefs=0` → truly dead, safe to delete the whole declaration
    (strongest with `textHits=0`). `sameFileRefs=1+` → only the `export` keyword
    is redundant; **keep the declaration**.
  - `textHits` = word-boundary occurrences in *other* files — a triage hint, not
    proof; `1+` may be string/JSX/dynamic use.
  - `[default]` candidates are false-positive-prone; verify each.
  - A **⚠ package-level warning** means a `dist`-publishing workspace package
    produced systematic false positives — treat those as low confidence.
- **Tip**: on large repos start with `"summary"` to see where dead code
  clusters, then narrow with `entryPoints` / `excludeFilePatterns` and switch to
  `"list"`. Always confirm with `find_references_by_tsmorph` before deleting; or
  delete via `safe_delete_symbol_by_tsmorph`, which can't break a reference.

---

## `convert_default_export_to_named_by_tsmorph`
Converts a file's `export default` to a named export and rewrites every importer
and re-exporter.

- **When**: migrating off default exports; normalizing inconsistent
  default-import local names.
- **Params**: `targetFilePath`, `newName?` (**required** when the default is
  anonymous; rejected when it differs from an already-named function/class
  default), `dryRun?`.

```json
{
  "tsconfigPath": "/repo/tsconfig.json",
  "targetFilePath": "/repo/src/Button.tsx",
  "newName": "Button"
}
```

- **Gotchas**: `export { default } …` barrels become named re-exports (changing
  that barrel's surface); **transitive chains aren't followed**. Dynamic
  `import().then(m => m.default)` isn't detected.

---

## `convert_named_export_to_default_by_tsmorph`
The inverse: converts a named export to the file's default export and rewrites
importers/re-exporters.

- **When**: standardizing a module on a default export.
- **Params**: `targetFilePath`, `exportName` (must be a **value** export, not a
  `type`/`interface`), `dryRun?`.
- **Gotchas**: aborts if the file already has a default export, if `exportName`
  is re-exported from elsewhere (convert it at the source), or if it's in a
  multi-variable `export const a, b`. Namespace-member access (`ns.Foo`) isn't
  rewritten.

---

## `organize_imports_by_tsmorph`
Runs editor "Organize Imports" — removes unused imports, sorts, and coalesces
same-module imports.

- **Params**: `filePaths?` (omit = whole project), `dryRun?`.
- **Gotchas**: keeps side-effect-only imports. Expect ordering-only diffs.
  Omitting `filePaths` reorders the whole project — prefer touched files and/or
  `dryRun`.

---

## `get_diagnostics_by_tsmorph`
Returns the TypeScript pre-emit diagnostics (`tsc --noEmit`) for files or the
whole project. Read-only. **Your standard post-refactor check.**

- **Params**: `filePaths?` (omit = whole project, including global diagnostics),
  `maxResults?` (default 100).
- **Output**: a summary plus one line per diagnostic —
  `<category> TS<code> <file>:<line>:<col> — <message>`, sorted error → warning →
  suggestion, with a `truncated` flag. Those `file:line:col` values are ready to
  feed into position-taking tools.

---

## `add_missing_imports_by_tsmorph`
Adds import statements for unresolved identifiers (editor "Add all missing
imports").

- **When**: you just wrote/pasted code referencing not-yet-imported symbols, or
  to bulk-clear "Cannot find name 'X'".
- **Params**: `filePaths?` (omit = whole project), `dryRun?`.
- **Gotchas**: when a name could come from several modules the language service
  picks one — review ambiguous cases. Prefer touched files and/or `dryRun`.

---

## `apply_code_fix_by_tsmorph`
Applies a TypeScript "fix all in file" quick-fix — the automated counterpart to
`get_diagnostics_by_tsmorph`.

- **Params**: `fix` (enum, below), `filePaths?` (omit = whole project),
  `dryRun?`.
- **`fix` values**: `remove_unused` (delete unused declarations + imports),
  `implement_interface` (stub missing `implements` members),
  `implement_abstract_members` (stub inherited `abstract` members),
  `infer_types_from_usage` (annotate implicit-`any`; only under `noImplicitAny`).

```json
{
  "tsconfigPath": "/repo/tsconfig.json",
  "fix": "remove_unused",
  "filePaths": ["/repo/src/user.ts"]
}
```

- **Gotchas**: a fix with no matching diagnostic is a no-op. Stubbed bodies throw
  `new Error("Method not implemented.")` — fill them in.

---

## `safe_delete_symbol_by_tsmorph`
Deletes a top-level symbol **only when** it has no references outside its own
declaration; otherwise reports the blockers and changes nothing. The mutating
partner to `find_unused_exports_by_tsmorph`.

- **When**: removing code you believe is dead, with a type-checker guarantee you
  won't break a missed reference.
- **Params**: `targetFilePath`, `symbolName` (a top-level declaration),
  `dryRun?`.

```json
{
  "tsconfigPath": "/repo/tsconfig.json",
  "targetFilePath": "/repo/src/legacy.ts",
  "symbolName": "oldHelper"
}
```

- **Behavior**: self-references (its own name, recursion) are ignored; any other
  reference — other files, same-file usages, local `export { x }` re-exports —
  blocks the delete and is returned as `file:line:col`. Overload signatures go
  together; one declarator is removed from a multi-variable statement.
- **Gotchas**: if two symbols share the name, the first in the file is targeted.
  Imports left unused by the deletion are **not** removed — follow with
  `organize_imports` / `apply_code_fix` (`remove_unused`).
