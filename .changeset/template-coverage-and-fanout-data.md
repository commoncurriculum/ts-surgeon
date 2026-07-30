---
"@commoncurriculum/ts-surgeon": minor
---

Close the gaps found reviewing the template-aware guard and lookups change.

**Angular is now a recognized template environment**

The feature covered Glint/Ember, Vue and Svelte but not Angular, which has the same hole on a much larger installed base — and reaches further into ordinary code. A component's markup lives in a separate `.html` behind `templateUrl`, and its bindings resolve against the class with no TypeScript reference edge, so `find_references` on a method bound by `(click)="onSave()"` answered *"References not found. Status: Success."* and `rename_symbol` reported success while orphaning `{{ heroName }}`. Detected from `angularCompilerOptions` or the `@angular/language-service` plugin; `.html` is scanned, which is broader than the other dialects because a component template is not distinguishable by path. `Directive` and `Pipe` join the role suffixes stripped when deriving spellings.

**The blind-spot detector was blind in its own primary case**

Spellings were derived from the symbol name alone, but classic Ember resolves a component from its **file name**, which the class inside need not match: `export class Panel` in `app/components/side-panel.ts` is invoked as `<SidePanel />`. No spelling of `Panel` reaches that, so every one of these tools reported "no template matched" — and `safe_delete_symbol` deleted a component a template was using, the exact outcome the refusal exists to prevent. The declaring file's basename now contributes spellings too, in the symbol tools and in `find_unused_exports`, where such a candidate is the one most likely to be swept up.

**The template blind spot reached the two tools that most needed it**

- `find_unused_exports` now warns that an export used only from a template is reported there as unused, and names which candidates a template does mention — this is the list an agent sweeps to decide what to delete, so a blanket disclaimer was not enough. One template pass covers every candidate rather than one pass per name.
- `move_symbol_to_file` reports the same break `rename_filesystem_entry` does: relocating a component's file orphans the templates that resolve it by name, with no import statement recording the link.

**The guard hook stopped answering ambiguous searches with one declaration**

When `find_references` began succeeding on an ambiguous name instead of erroring, the hook's result parser fell through to `data.definition`/`data.references` — which are declaration #1's. An intercepted `grep -rn render` was answered with one of N declarations and nothing saying so, from a hook whose entire justification is beating the grep it replaced. It now reports every declaration, plus the ones past the cap as positions. The gate that decides whether to answer at all is extracted and covered, since it silently discarded the new result shape.

**Fan-out no longer hides the tool's own payload**

Running across a solution config's referenced projects replaced `--json` `data` with `{ byProject }`. Once fan-out became the default for read-only tools, `data.references` silently became `undefined` for every existing consumer. Array fields (`references`, `diagnostics`, `unusedExports`, …) are now concatenated at the top level alongside `byProject`. Per-project scalars like `scannedFiles` are not lifted — they have no single value across projects, and inventing one would be the same overclaim in a new place.

**Template matches are ranked, so a common name cannot bury the real one**

Matches were printed in directory-walk order and cut at 25. A component called `Item` also matches every `{{item.name}}` and `as |item|` in the app, so 25 lines of block-param noise could push out the one `<Item />` that actually resolves it. Matches are now collected across a wider budget and sorted invocation-shaped first, and the message states how many were left out. Matching itself stays broad on purpose — a false positive costs one glance, a false negative silently orphans a template.

Relatedly, `<Item.Sub />` is a real invocation of `Item`, but the classifier excluded any dotted name to keep `{{item.name}}` (a block-param path read) from counting. Angle-bracket and curly forms are now judged separately, because the dot means opposite things in each, and the classifier has its own test table of real template shapes.

**`safe_delete_symbol` refusals are overridable, on the record**

A text match on a generic name blocked the delete with no way through, making the tool unusable for a whole class of ordinary names. `ignoreTemplateMentions: true` is the explicit per-call override; the result records that the judgement was the caller's, and the type-checker reference check still runs and still blocks.

**The dead-code recipe warned about the wrong false positive**

`skills/ts-surgeon/SKILL.md` — the file an agent reads before deleting — listed the monorepo ⚠ warning but not the template one, which is harder: in a Glint/Vue/Svelte project nothing in the type system connects a component to `<BasicTooltip />`, so it is reported with `textHits=0 sameFileRefs=0`, the strongest "safe to delete" signal the tool has, and nothing fails until runtime. Added there and in the embedded `guide`.

**`rewrite_where` reached the skill**

It has been a registered tool and a documented one in the README, but appeared nowhere in `skills/ts-surgeon/` — the file that tells an agent which tools exist. 17 of 18 tools were reachable that way. Added, with a pointer from `rewrite_pattern`, which is where you find out you need it.

**The guard stops blocking extraction out of source**

A one-liner whose single write provably targets a non-source file — `fs.writeFileSync('data.json', fs.readFileSync('src/a.ts','utf8').replace(…))` — reads a `.ts` but rewrites a `.json`, and scanning the whole command for a source extension called that a source rewrite. Two writes, or a computed target, and the conservative reading applies again, so the narrowing cannot be used to smuggle a second write past the check.
