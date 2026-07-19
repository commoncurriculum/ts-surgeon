---
name: ts-surgeon
description: >-
  Drive the commoncurriculum/ts-surgeon refactoring CLI (via npx) for AST-accurate,
  project-wide TypeScript/JavaScript refactors instead of hand-editing. Use when renaming a
  symbol or file, finding references, moving a symbol between files, changing a
  function signature, converting export styles, organizing/adding imports,
  deleting dead code safely, or reading types/diagnostics. Triggers: "rename
  across the project", "find all references", "move this function", "add a
  parameter and fix call sites", "remove unused imports", "find dead code",
  "safely delete this symbol", "what type is this", "what are the type errors".
license: MIT
---

# ts-morph Refactoring (CLI)

[`commoncurriculum/ts-surgeon`](https://github.com/commoncurriculum/ts-surgeon)
drives [ts-morph](https://ts-morph.com/) to refactor TypeScript/JavaScript
through the real AST + TypeScript type checker. Every change is resolved
project-wide, so import paths, re-exports, and call sites stay consistent —
something search-and-replace and one-shot LLM edits routinely get wrong.

**Reach for these tools instead of manual edits whenever a change crosses file
boundaries or touches more than a couple of call sites.** They are the
difference between "renamed the declaration and missed three importers" and a
green build.

This file is the decision layer: how to choose and chain tools. For each tool's
parameters, worked examples, and gotchas, see **[`reference.md`](reference.md)**.

## How to invoke the tools

Run the CLI directly with Bash via `npx` — no clone, no global install, no
configuration (it builds on first use; npm caches it for later runs):

```bash
# Discover tools / a tool's exact parameter schema
npx -y @commoncurriculum/ts-surgeon list
npx -y @commoncurriculum/ts-surgeon describe rename_symbol

# Run one tool with flags (kebab-case maps to the schema's camelCase; dots nest)
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

- Relative paths resolve against the working directory, and `tsconfigPath` is
  auto-discovered (nearest `tsconfig.json` above the target file) when omitted.
- `--json` prints a machine-readable result (`{ tool, status, data, message }`);
  `batch` runs a JSON array of `{ tool, params }` in one process, sharing one
  parsed project per tsconfig (one AST parse for N ops; `--fresh-project` opts
  out). `--stdin-files` turns a piped file list (e.g. `git diff --name-only`)
  into `filePaths`.
- For large parameter payloads, use `--params-file <path>` or pipe JSON via
  stdin instead of an inline `--params`.
- Exit codes: `0` success, `1` the tool reported an error (read stdout for the
  reason), `2` usage/params error.
- Pin a version for reproducibility (`@commoncurriculum/ts-surgeon@1.2.3`).
  Unreleased builds can be run from source with
  `npx -y github:commoncurriculum/ts-surgeon` (needs git access for a
  private repo).

The parameter JSON documented in `reference.md` is exactly what `--params`
takes (and what the flags spell field-by-field). The CLI also embeds this
guidance — `npx -y @commoncurriculum/ts-surgeon guide` prints it, so
any coding agent can self-serve without this file. To hack on the CLI itself,
build from source — see the repo's `run-ts-morph-cli` skill.

## The loop

Most refactoring sessions are the same three beats — make this your default
rhythm:

1. **Survey** — `find_references` / `find_unused_exports` /
   `get_type_at_position` to understand blast radius before you touch
   anything.
2. **Change** — the mutating tool, with `dryRun: true` first when it fans out.
3. **Verify** — `get_diagnostics` on the touched files to confirm you
   introduced no type errors, then `organize_imports` to clean up.

## Rules that apply to every tool

- **Relative paths resolve against the CLI's working directory** — run from the
  project root, or pass absolute paths when in doubt.
- **`tsconfigPath` defines the project graph.** When omitted, the nearest
  `tsconfig.json` above the target file is used; pass it explicitly when the
  project has multiple tsconfigs and the wrong one might win.
- **Prefer name-based targeting.** `rename_symbol`, `find_references`,
  `change_signature`, and `get_type_at_position` accept just the declaration
  name (omit `position`) when it
  is unambiguous in the file; the error lists candidate positions otherwise.
  When you do pass a **position, it is 1-based** (line *and* column) and must
  land on the **identifier**, not whitespace. Don't count columns by hand —
  copy them from a tool that already emitted a location (`get_diagnostics` and
  `find_references` return `file:line:col`).
- **`dryRun: true` previews the impacted files without writing** (every mutating
  tool supports it). Use it first whenever a change fans out widely, or whenever
  you omit `filePaths` — which means *the whole project*.
- **These tools write files in place**, not through git. Make sure the working
  tree is committed or clean before a bulk operation, so the result is a
  reviewable, revertible diff.
- **Verify after mutating** with `get_diagnostics`.

## Pick a tool by intent

| I want to… | Tool |
| --- | --- |
| Find every occurrence of a code shape (ast-grep pattern) | `search_pattern` |
| Rewrite a code shape project-wide (safe sed replacement) | `rewrite_pattern` |
| Rename a symbol everywhere it is used | `rename_symbol` |
| Rename/move files or folders and fix import paths | `rename_filesystem_entry` |
| See every definition + usage of a symbol | `find_references` |
| Turn path aliases (`@/x`) into relative imports | `remove_path_alias` |
| Move a symbol to another file, updating references | `move_symbol_to_file` |
| Add/remove/reorder params and fix all call sites | `change_signature` |
| Know the inferred type at a position | `get_type_at_position` |
| Audit exports nothing imports | `find_unused_exports` |
| Switch a default export to a named one | `convert_default_export_to_named` |
| Switch a named export to the default one | `convert_named_export_to_default` |
| Remove unused imports / sort / coalesce | `organize_imports` |
| Add imports for unresolved identifiers | `add_missing_imports` |
| Apply a "fix all in file" quick-fix | `apply_code_fix` |
| Delete a symbol only if it is truly unused | `safe_delete_symbol` |
| List the type errors `tsc --noEmit` would report | `get_diagnostics` |

## Workflow recipes

**Dead-code cleanup (safe).**
1. `find_unused_exports` (`responseFormat: "summary"` first on big
   repos) to find candidates — but read its output as *candidates, not
   verdicts* (see anti-patterns).
2. For each candidate with `sameFileRefs: 0`, confirm with
   `find_references`.
3. `safe_delete_symbol` — it refuses anything still referenced, so it
   is safe to attempt even when you are unsure.
4. `organize_imports` on the touched files to drop now-unused
   imports, then `get_diagnostics` to confirm green.

**Import hygiene after a big edit.**
`add_missing_imports` → `organize_imports` →
`get_diagnostics`, scoped to the files you changed.

**Changing a function's parameters.**
`change_signature` with `dryRun: true` to see the call sites it will
touch, then again to apply, then `get_diagnostics`. Spread call sites
(`fn(...args)`) it cannot rewrite — fix those by hand first.

**Export-style migration.**
`convert_default_export_to_named` /
`convert_named_export_to_default` with `dryRun: true` first; then
review barrels whose public surface changed (transitive re-exports aren't
followed).

**Restructuring the file tree.**
Batch all moves into one `rename_filesystem_entry` call so paths
resolve consistently; finish with `get_diagnostics`.

## Common mistakes (anti-patterns)

- **Trusting `find_unused_exports` blindly.** It returns *candidates*. Read
  `sameFileRefs` before deleting: `0` = truly dead (safe to delete the whole
  declaration); `1+` = only the `export` keyword is redundant — **keep the
  declaration**. Deleting every candidate breaks the build. Prefer routing
  deletions through `safe_delete_symbol`, which can't break a
  reference.
- **Deleting a `[default]` candidate.** Default exports are false-positive-prone
  (default imports aren't linked); one with `textHits` > 0 is almost certainly
  in use. Always confirm with `find_references`.
- **Ignoring the monorepo ⚠ warning.** When a workspace package publishes built
  output (`dist`), every one of its exports can be falsely reported unused. The
  tool prepends a package-level warning — treat those candidates as low
  confidence.
- **Pointing a position tool at whitespace** — it resolves the wrong node. Land
  on the identifier; check `nodeKind` in `get_type_at_position` output.
- **Forgetting `filePaths` makes it project-wide.** `organize_imports`,
  `add_missing_imports`, `apply_code_fix`, and `get_diagnostics` process the
  whole project when `filePaths` is omitted — a large diff. Pass the files you
  touched and/or `dryRun` first.
- **Trying to move a `export default`.** `move_symbol_to_file` can't — convert
  it to a named export first.
- **Expecting aliases to survive a file move.** `rename_filesystem_entry`
  rewrites updated alias imports (`@/x`) as relative paths.
- **Leaving orphaned imports after a delete.** `safe_delete_symbol` removes the
  declaration but not imports it made unused — follow with `organize_imports` /
  `apply_code_fix` (`remove_unused`).
