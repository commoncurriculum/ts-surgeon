/**
 * Marker line the `init` command uses for idempotency: a file already
 * containing it is left untouched.
 */
export const INIT_MARKER = "@commoncurriculum/ts-surgeon guide";

/** The section `init` appends to a project's agent-instructions file. */
export const AGENT_SNIPPET = `## Refactoring (ts-surgeon)

For TypeScript/JavaScript refactors that cross file boundaries (renames, moves,
signature changes, finding references, dead-code checks), do not hand-edit.
Use the ts-morph refactoring CLI:

    npx -y ${INIT_MARKER}   # read this first
    npx -y @commoncurriculum/ts-surgeon list    # tool names + summaries
`;

/**
 * The embedded agent guide, printed by `ts-surgeon guide`.
 *
 * This is the tool-agnostic equivalent of an agent "skill": any coding agent
 * (or human) can run `guide` to learn when and how to use the tools without
 * needing editor- or vendor-specific configuration.
 */
export const GUIDE = `# ts-surgeon — agent guide

This CLI drives ts-morph (the real TypeScript AST + type checker) to perform
project-wide refactors. Every change resolves imports, re-exports, and call
sites across the whole project — the things search-and-replace and hand edits
routinely miss. Reach for it whenever a change crosses file boundaries or
touches more than a couple of call sites.

## Invocation

    ts-surgeon list                          # all tools, one-line summaries
    ts-surgeon describe <tool>               # full docs + JSON input schema
    ts-surgeon call <tool> [params]          # run one tool
    ts-surgeon batch [--continue-on-error]   # run several tools in one process
                                              # (ops share one parsed project per
                                              #  tsconfig; --fresh-project re-parses)

Parameters can be passed three ways (flags win over JSON):

    # 1. Flags — kebab-case maps to the schema's camelCase; dots nest
    ts-surgeon call rename_symbol --target-file-path src/utils.ts \\
      --symbol-name oldName --new-name newName

    # 2. A JSON object
    ts-surgeon call rename_symbol --params '{"targetFilePath": "src/utils.ts", ...}'

    # 3. JSON via stdin or --params-file <path>

Conveniences:
- Relative paths are resolved against the current working directory.
- \`tsconfigPath\` may be omitted: the nearest tsconfig.json above the target
  file (or the cwd) is used automatically.
- Add \`--json\` for machine-readable output ({ tool, status, data, message }).
- Every mutating tool accepts \`--dry-run\` to preview the changed-file list.
- Tool names accept dashes (\`rename-symbol\`) and the legacy
  \`*_by_tsmorph\` aliases.
- \`--git-changed\` / \`--git-staged\` set \`filePaths\` to the TS/JS files
  git reports as changed (unstaged / staged):
  \`ts-surgeon call organize_imports --git-changed\`.
- \`--stdin-files\` turns a piped file list into \`filePaths\`:
  \`git diff --name-only | ts-surgeon call organize_imports --stdin-files\`
  (non-source and missing paths are skipped).
- Exit codes: 0 success, 1 the tool reported an error, 2 usage/params error.

## The loop

1. **Survey** — \`find_references\` (symbol usages) / \`search_pattern\` (code
   shapes) / \`search_text\` (plain text) / \`find_unused_exports\` /
   \`get_type_at_position\` to understand blast radius before touching anything.
2. **Change** — the mutating tool, with \`--dry-run\` first when it fans out.
3. **Verify** — \`get_diagnostics\` on the touched files to confirm no new type
   errors, then \`organize_imports\` to clean up.

## Pick a tool by intent

| I want to… | Tool |
| --- | --- |
| Find every occurrence of a code *shape* (ast-grep pattern) | search_pattern |
| Rewrite a code shape project-wide (sed-style codemod, safely) | rewrite_pattern |
| Find plain text / a regex (TODOs, strings, config keys) | search_text |
| Rename a symbol everywhere it is used | rename_symbol |
| Rename/move files or folders and fix import paths | rename_filesystem_entry |
| See every definition + usage of a symbol | find_references |
| Turn path aliases (@/x) into relative imports | remove_path_alias |
| Move a symbol to another file, updating references | move_symbol_to_file |
| Add/remove/reorder params and fix all call sites | change_signature |
| Know the inferred type at a position | get_type_at_position |
| Audit exports nothing imports | find_unused_exports |
| Switch a default export to a named one | convert_default_export_to_named |
| Switch a named export to the default one | convert_named_export_to_default |
| Remove unused imports / sort / coalesce | organize_imports |
| Add imports for unresolved identifiers | add_missing_imports |
| Apply a "fix all in file" quick-fix | apply_code_fix |
| Delete a symbol only if it is truly unused | safe_delete_symbol |
| List the type errors tsc --noEmit would report | get_diagnostics |

## Rules

- rename_symbol, find_references, change_signature, and get_type_at_position
  can target a symbol **by declaration name alone** (omit position) when the name is unambiguous
  in the file — the error lists candidate positions otherwise. Positions,
  when you do pass them, are **1-based** (line and column) and must land on
  the identifier, not whitespace. Don't count columns by hand — copy them
  from a tool that emitted a location (get_diagnostics and find_references
  print file:line:col).
- Omitting \`filePaths\` makes organize_imports / add_missing_imports /
  apply_code_fix / get_diagnostics process the **whole project**. Scope to the
  files you touched, or --dry-run first.
- Tools write files in place, not through git — keep the working tree clean
  before bulk operations so the diff is reviewable.
- Never fall back to grep/sed: route searches by intent — symbol usages ->
  \`find_references\` (type-aware), code shapes -> \`search_pattern\` (ast-grep
  patterns like \`console.log($$$ARGS)\`; formatting never false-negatives,
  strings/comments never false-positive), plain text -> \`search_text\`
  (project-scoped, so node_modules/dist are never scanned). For rewrites use
  \`rewrite_pattern\` instead of sed/perl; for symbol renames and signature
  changes use the type-aware tools — rewrite_pattern does not touch imports.
  (Projects can enforce this: \`ts-surgeon init --claude-hook\` installs a
  guard that blocks in-place sed/perl on TS/JS sources.)

## Anti-patterns

- Trusting find_unused_exports blindly: it returns *candidates*. sameFileRefs=0
  means deletable; 1+ means only the export keyword is redundant. Route
  deletions through safe_delete_symbol, which refuses anything referenced.
- Deleting a [default] candidate without confirming via find_references —
  default exports are false-positive-prone.
- Moving an \`export default\` with move_symbol_to_file — convert it to a named
  export first.
- Leaving orphaned imports after a delete — follow with organize_imports.
`;
