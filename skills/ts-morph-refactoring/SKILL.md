---
name: ts-morph-refactoring
description: >-
  Drive the commoncurriculum/mcp-ts-morph MCP server for AST-accurate,
  project-wide TypeScript/JavaScript refactors instead of hand-editing. Use when renaming a
  symbol or file, finding references, moving a symbol between files, changing a
  function signature, converting export styles, organizing/adding imports,
  deleting dead code safely, or reading types/diagnostics. Triggers: "rename
  across the project", "find all references", "move this function", "add a
  parameter and fix call sites", "remove unused imports", "find dead code",
  "safely delete this symbol", "what type is this", "what are the type errors".
license: MIT
---

# ts-morph Refactoring (MCP)

[`commoncurriculum/mcp-ts-morph`](https://github.com/commoncurriculum/mcp-ts-morph)
is an MCP server that drives [ts-morph](https://ts-morph.com/) to refactor
TypeScript/JavaScript through the real AST + TypeScript type checker. Every
change is resolved project-wide, so import paths, re-exports, and call sites
stay consistent — something search-and-replace and one-shot LLM edits routinely
get wrong.

**Reach for these tools instead of manual edits whenever a change crosses file
boundaries or touches more than a couple of call sites.** They are the
difference between "renamed the declaration and missed three importers" and a
green build.

This file is the decision layer: how to choose and chain tools. For each tool's
parameters, worked examples, and gotchas, see **[`reference.md`](reference.md)**.

## Setup

Point your MCP client at the server with `npx` straight from GitHub — no clone,
no global install (it builds on first use; npm caches it for later runs). In
your client config (`mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "mcp-ts-morph": {
      "command": "npx",
      "args": ["-y", "github:commoncurriculum/mcp-ts-morph"],
      "env": {}
    }
  }
}
```

Pin a ref for reproducibility (`github:commoncurriculum/mcp-ts-morph#v1.2.3`);
for a private repo the client's environment needs git access to it. To hack on
the server itself, build from source — see the repo's `run-mcp-ts-morph` skill.

## The loop

Most refactoring sessions are the same three beats — make this your default
rhythm:

1. **Survey** — `find_references_by_tsmorph` / `find_unused_exports_by_tsmorph` /
   `get_type_at_position_by_tsmorph` to understand blast radius before you touch
   anything.
2. **Change** — the mutating tool, with `dryRun: true` first when it fans out.
3. **Verify** — `get_diagnostics_by_tsmorph` on the touched files to confirm you
   introduced no type errors, then `organize_imports_by_tsmorph` to clean up.

## Rules that apply to every tool

- **All paths must be absolute** — `tsconfigPath`, `targetFilePath`,
  `filePaths`, `oldPath`/`newPath`. Relative paths fail or misresolve.
- **`tsconfigPath` is always required.** It defines the project graph the tools
  resolve against; point it at the `tsconfig.json` that actually includes the
  files you are editing.
- **Positions are 1-based** (line *and* column) and must land on the
  **identifier**, not surrounding whitespace/punctuation. **Don't count columns
  by hand** — copy them from a tool that already emitted a location
  (`get_diagnostics` and `find_references` return `file:line:col`), or from your
  editor's cursor readout. A position on whitespace silently resolves the wrong
  node (often the file-level `typeof import(...)`).
- **`dryRun: true` previews the impacted files without writing** (every mutating
  tool supports it). Use it first whenever a change fans out widely, or whenever
  you omit `filePaths` — which means *the whole project*.
- **These tools write files in place**, not through git. Make sure the working
  tree is committed or clean before a bulk operation, so the result is a
  reviewable, revertible diff.
- **Verify after mutating** with `get_diagnostics_by_tsmorph`.

## Pick a tool by intent

| I want to… | Tool |
| --- | --- |
| Rename a symbol everywhere it is used | `rename_symbol_by_tsmorph` |
| Rename/move files or folders and fix import paths | `rename_filesystem_entry_by_tsmorph` |
| See every definition + usage of a symbol | `find_references_by_tsmorph` |
| Turn path aliases (`@/x`) into relative imports | `remove_path_alias_by_tsmorph` |
| Move a symbol to another file, updating references | `move_symbol_to_file_by_tsmorph` |
| Add/remove/reorder params and fix all call sites | `change_signature_by_tsmorph` |
| Know the inferred type at a position | `get_type_at_position_by_tsmorph` |
| Audit exports nothing imports | `find_unused_exports_by_tsmorph` |
| Switch a default export to a named one | `convert_default_export_to_named_by_tsmorph` |
| Switch a named export to the default one | `convert_named_export_to_default_by_tsmorph` |
| Remove unused imports / sort / coalesce | `organize_imports_by_tsmorph` |
| Add imports for unresolved identifiers | `add_missing_imports_by_tsmorph` |
| Apply a "fix all in file" quick-fix | `apply_code_fix_by_tsmorph` |
| Delete a symbol only if it is truly unused | `safe_delete_symbol_by_tsmorph` |
| List the type errors `tsc --noEmit` would report | `get_diagnostics_by_tsmorph` |

## Workflow recipes

**Dead-code cleanup (safe).**
1. `find_unused_exports_by_tsmorph` (`responseFormat: "summary"` first on big
   repos) to find candidates — but read its output as *candidates, not
   verdicts* (see anti-patterns).
2. For each candidate with `sameFileRefs: 0`, confirm with
   `find_references_by_tsmorph`.
3. `safe_delete_symbol_by_tsmorph` — it refuses anything still referenced, so it
   is safe to attempt even when you are unsure.
4. `organize_imports_by_tsmorph` on the touched files to drop now-unused
   imports, then `get_diagnostics_by_tsmorph` to confirm green.

**Import hygiene after a big edit.**
`add_missing_imports_by_tsmorph` → `organize_imports_by_tsmorph` →
`get_diagnostics_by_tsmorph`, scoped to the files you changed.

**Changing a function's parameters.**
`change_signature_by_tsmorph` with `dryRun: true` to see the call sites it will
touch, then again to apply, then `get_diagnostics_by_tsmorph`. Spread call sites
(`fn(...args)`) it cannot rewrite — fix those by hand first.

**Export-style migration.**
`convert_default_export_to_named_by_tsmorph` /
`convert_named_export_to_default_by_tsmorph` with `dryRun: true` first; then
review barrels whose public surface changed (transitive re-exports aren't
followed).

**Restructuring the file tree.**
Batch all moves into one `rename_filesystem_entry_by_tsmorph` call so paths
resolve consistently; finish with `get_diagnostics_by_tsmorph`.

## Common mistakes (anti-patterns)

- **Trusting `find_unused_exports` blindly.** It returns *candidates*. Read
  `sameFileRefs` before deleting: `0` = truly dead (safe to delete the whole
  declaration); `1+` = only the `export` keyword is redundant — **keep the
  declaration**. Deleting every candidate breaks the build. Prefer routing
  deletions through `safe_delete_symbol_by_tsmorph`, which can't break a
  reference.
- **Deleting a `[default]` candidate.** Default exports are false-positive-prone
  (default imports aren't linked); one with `textHits` > 0 is almost certainly
  in use. Always confirm with `find_references_by_tsmorph`.
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
