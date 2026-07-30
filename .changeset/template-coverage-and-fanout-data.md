---
"@commoncurriculum/ts-surgeon": minor
---

Close the gaps found reviewing the template-aware guard and lookups change.

**The template blind spot reached the two tools that most needed it**

- `find_unused_exports` now warns that an export used only from a template is reported there as unused, and names which candidates a template does mention — this is the list an agent sweeps to decide what to delete, so a blanket disclaimer was not enough. One template pass covers every candidate rather than one pass per name.
- `move_symbol_to_file` reports the same break `rename_filesystem_entry` does: relocating a component's file orphans the templates that resolve it by name, with no import statement recording the link.

**Template matches are ranked, so a common name cannot bury the real one**

Matches were printed in directory-walk order and cut at 25. A component called `Item` also matches every `{{item.name}}` and `as |item|` in the app, so 25 lines of block-param noise could push out the one `<Item />` that actually resolves it. Matches are now collected across a wider budget and sorted invocation-shaped first (`<Foo`, `{{foo`, `{{#foo`, `(foo`), and the message states how many were left out. Matching itself stays broad on purpose — a false positive costs one glance, a false negative silently orphans a template.

**`safe_delete_symbol` refusals are overridable, on the record**

A text match on a generic name blocked the delete with no way through, making the tool unusable for a whole class of ordinary names. `ignoreTemplateMentions: true` is the explicit per-call override; the result records that the judgement was the caller's, and the type-checker reference check still runs and still blocks.

**Fan-out no longer hides the tool's own payload**

Running across a solution config's referenced projects replaced `--json` `data` with `{ byProject }`. Once fan-out became the default for read-only tools, `data.references` silently became `undefined` for every existing consumer. Array fields (`references`, `diagnostics`, `unusedExports`, …) are now concatenated at the top level alongside `byProject`. Per-project scalars like `scannedFiles` are not lifted — they have no single value across projects, and inventing one would be the same overclaim in a new place.

**The guard hook stopped answering ambiguous searches with one declaration**

When `find_references` began succeeding on an ambiguous name instead of erroring, the hook's result parser fell through to `data.definition`/`data.references` — which are declaration #1's. An intercepted `grep -rn render` was answered with one of N declarations and nothing saying so, from a hook whose entire justification is beating the grep it replaced. It now reports every declaration, plus the ones past the cap as positions. The gate that decides whether to answer at all is extracted and covered, since it silently discarded the new result shape.

**`rewrite_where` reached the skill**

It has been a registered tool and a documented one in the README, but appeared nowhere in `skills/ts-surgeon/` — the file that tells an agent which tools exist. 17 of 18 tools were reachable that way. Added, with a pointer from `rewrite_pattern`, which is where you find out you need it.

**The guard stops blocking extraction out of source**

A one-liner whose single write provably targets a non-source file — `fs.writeFileSync('data.json', fs.readFileSync('src/a.ts','utf8').replace(…))` — reads a `.ts` but rewrites a `.json`, and scanning the whole command for a source extension called that a source rewrite. Two writes, or a computed target, and the conservative reading applies again, so the narrowing cannot be used to smuggle a second write past the check.
