# @commoncurriculum/ts-surgeon

## 1.5.0

### Minor Changes

- daa3e7b: Address a nine-point defect report (2026-07-29) about tools reporting more confidence than they have.

  **Guard**

  - Hand-edits of TS/JS are detected by write _effect_ rather than by binary name: interpreter one-liners that read → substitute → write back (`python3 -c`, `node -e`, `ruby -e`, `php -r`, bun/deno, target may be a variable) and redirects/`tee` that overwrite an **existing** source file now block, alongside `sed -i`/`perl -i`. Creating a new file that way stays allowed.
  - Block messages no longer claim "this guard has no in-session bypass" — a partial denylist cannot promise total coverage, and the false claim invited hunting for the mechanism that slips through.
  - Neither the answer nor the teaching hook fires for searches over paths that exist and demonstrably hold no TS/JS (e.g. a `defmodule` grep in an Elixir tree).

  **Template-based frameworks (Glint/Ember, Vue, Svelte)**

  - Tools now detect the environment from the tsconfig they already read (top-level marker, `compilerOptions.plugins`, or an `extends` chain) and stop presenting partial results as complete: `find_references` reports the blind spot and lists matching template lines as text; `rename_symbol` / `rename_filesystem_entry` state that they cannot update templates and list the matches left alone; `safe_delete_symbol` refuses to delete a symbol a template still mentions.

  **Lookups**

  - `find_references` answers every declaration of an ambiguous name instead of erroring and forcing a second process start and project parse (`--json` data gains `declarations`). Reference resolution is capped at 5 declarations — each one costs a full type-checker search — and the rest are reported as positions under `unsearchedDeclarations`.
  - A file that exists on disk but sits outside the tsconfig's include globs now says so, instead of the misleading "File not found".
  - Read-only tools fan out across a solution-style tsconfig's referenced projects by default; `--single-project` opts out, and the per-invocation warning is gone.

  **Startup**

  - `guide`, `--version` and `-v` no longer load ts-morph and the TypeScript compiler (~1s → ~50ms).

- daa3e7b: Close the gaps found reviewing the template-aware guard and lookups change.

  **Astro is now a recognized template environment**

  The sharpest version of this hole, because the invisible code is not markup: an `.astro` file's frontmatter is ordinary TypeScript — imports, calls, anything — that the Astro toolchain compiles and ts-morph never parses. A plain helper called only from a page's frontmatter read as completely unreferenced, so `find_references` answered _"References not found. Status: Success."_ and `safe_delete_symbol` would happily remove it. Detected from an `astro/tsconfigs/*` extends (including TypeScript 5 array form), `jsxImportSource: "astro"`, or the `@astrojs/ts-plugin` entry — Astro has no marker key of its own, and the generated config is little more than that one `extends` line. `.astro` and `.mdx` are both scanned.

  Match ranking gained a **call** shape (`formatPrice(`) for the same reason: a frontmatter use has no template punctuation in front of it, so neither the angle nor the curly shape reached it and the call that actually breaks ranked below the import line.

  _(React needs nothing: `.tsx` is in the TypeScript program, so JSX usage resolves through the checker like any other reference. Verified, not assumed.)_

  **Angular is now a recognized template environment**

  The feature covered Glint/Ember, Vue and Svelte but not Angular, which has the same hole on a much larger installed base — and reaches further into ordinary code. A component's markup lives in a separate `.html` behind `templateUrl`, and its bindings resolve against the class with no TypeScript reference edge, so `find_references` on a method bound by `(click)="onSave()"` answered _"References not found. Status: Success."_ and `rename_symbol` reported success while orphaning `{{ heroName }}`. Detected from `angularCompilerOptions` or the `@angular/language-service` plugin; `.html` is scanned, which is broader than the other dialects because a component template is not distinguishable by path. `Directive` and `Pipe` join the role suffixes stripped when deriving spellings.

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

### Patch Changes

- daa3e7b: Review fixes on the template-aware guard and lookups change.

  - `ts-surgeon <name>` no longer crashes with a raw `TypeError` stack when the command happens to be an `Object.prototype` key (`constructor`, `toString`, `valueOf`, …). The fast-path table that routes `guide`/`--version`/`-v` before the compiler loads was an object literal, so those names resolved to an inherited function; it is now a `Map`, and unknown commands reach the CLI's own "Unknown command" report as they should.
  - The guard's source-presence walk stops as soon as its answer is decided. It kept draining its queue after the entry budget ran out, costing one `readdirSync` per already-queued directory — ~1500 wasted syscalls on a wide source-less tree, in a `PreToolUse` hook whose whole design constraint is to cost less than the grep it adjudicates.
  - `find_references` falls back to the default declaration cap on a non-finite `maxDeclarations`, closing the one gap in that clamp (`Math.max(1, NaN)` is `NaN`, and `slice(0, NaN)` is the empty-but-reported-as-capped state the clamp exists to prevent).
  - Docs match the shipped wording: the README described `rename_symbol` / `rename_filesystem_entry` as reporting what they "did not update", the action phrasing those tools deliberately avoid because it is false under `dryRun`. The agent-facing skill reference now also carries the template blind spot for `rename_symbol` / `rename_filesystem_entry` / `find_references`, and `find_references`'s ambiguous-name behavior.

- daa3e7b: Review-round hardening of the guard, the template blind-spot scan, and fan-out:

  - The guard no longer blocks quoted prose containing `->` (e.g. `git commit -m "moved a.ts -> src/index.ts"`): overwrite targets are harvested from the quote-aware tokenizer, never from a raw-string regex. Read-mode `open('Main.java')` no longer matches the write-API pattern (the mode must be its own argument). Heredoc-fed interpreters (`python3 <<'EOF'`) and attached eval flags (`node --eval=…`, `python3 -c"…"`) are now detected.
  - Angular components are matched by the `selector`/pipe-`name` string in their own decorator, so `ng generate component` defaults (`<app-hero-detail>`) no longer walk past `safe_delete_symbol`'s template refusal or `find_unused_exports`' likely-used warning.
  - `safe_delete_symbol` under `dryRun` + `ignoreTemplateMentions` says "Would delete despite N template text match(es)" instead of claiming a deletion that never happened, and attaches `templateBlindSpot` to `--json` data on the success path too.
  - Default fan-out no longer exits 1 when the target file or symbol lives in one referenced project and the others answer "not mine" — those are reported as `skipped` per project; merged arrays drop structurally identical duplicates from files shared between projects; tools outside the fan-out set are no longer accused of "mutating files".
  - Template-environment detection follows every entry of a TS 5.0 array `extends`, and recognizes create-vue (`@vue/tsconfig`) and SvelteKit (`.svelte-kit/tsconfig.json`) scaffolds by their extends strings.
  - The template scan keeps collecting invocation-shaped matches after generic noise exhausts its budget, searches every declaring file of a shared export name, and bounds the walk by directories visited.
  - The hook's search answerer fans its batch out across a solution config's referenced projects instead of parsing the empty solution project and failing open.

## 1.4.0

### Minor Changes

- 3fbf17b: Add `ts-surgeon install`: compile the guard, and stop paying npx on every tool call.

  The guard runs before every Bash and Grep call, so what it costs is what the
  harness costs. Through `npx -y @commoncurriculum/ts-surgeon hook` that was
  ~590ms per invocation — npx re-resolving the package, then Node loading a
  module graph that reached the TypeScript compiler — to decide that `ls` is
  harmless. With a PostToolUse hook installed too, that is over a second of
  latency added to every tool call.

  `ts-surgeon install` compiles the guard into a standalone executable with bun
  and points the hook config directly at it: **~15ms, a 39x improvement**,
  measured on a real project. bun is a build-time dependency only — `npx -y bun`
  fetches it, and the executable embeds its own runtime, so the machine running
  the guard afterwards needs neither bun nor node. The e2e test proves this by
  running the compiled guard with both removed from PATH.

  The hook config names the executable directly, with no `npx` and no shell
  wrapper in front of it: a wrapper to pick a fallback costs ~2.5ms, which is
  most of what compiling buys.

  Also splits `solutionReferences` out of `paths.ts` into its own module. It was
  the only thing importing `typescript` there, and `paths.ts` is on the guard's
  import graph — so every tool call was loading a compiler it never used. That
  alone took the hook's module graph from ~153ms to ~27ms, which also speeds up
  `npx … hook` for anyone not installing the binary.

- 3834b4e: Answer intercepted identifier searches with tsgo instead of ts-morph.

  The guard answers a hunted identifier by looking up real references. Through
  ts-morph that means parsing the project and loading its dependency type graph
  on every call — ~1.2s on a real repo, and the cost is not the parse: a
  two-file project with no dependencies resolves in 128ms, while narrowing a
  real project to the two files that mention the symbol makes it _slower_,
  because the checker still loads the `.d.ts` graph those files import.

  tsgo (TypeScript 7, Go) answers the same question in ~250ms from a process
  that starts, answers and exits. No daemon, no cache, nothing that can go
  stale. On a compiled guard the whole answered search drops from ~1979ms to
  ~402ms.

  Correctness is the point, so it is pinned rather than asserted:
  `src/tsgo/find-references.test.ts` runs both engines over one real project and
  compares location sets, including a symbol reachable only through an aliased
  re-export — the case a text search structurally cannot see.

  The subtlety is `workspace/symbol`, which is the editor's quick-open search:
  fuzzy, scoped to the repository rather than the project, and it returns
  duplicates. On a real repo, `lessonTitle` returned 15 hits from an unrelated
  package. Taking the first would answer from an arbitrary same-named symbol —
  so candidates are scoped to the project, deduplicated, and anything other than
  exactly one declaration is reported instead of guessed at.

### Patch Changes

- 051dff9: Stop counting property reads as declarations.

  `PropertyAccessExpression.getNameNode()` returns the identifier being read, so
  every `styles.lessonTitle` looked like a declaration of `lessonTitle`. That was
  invisible while the property had a resolvable symbol to dedupe on — but a
  CSS-module import is typed as an index signature, so each read counted as its
  own declaration. Symbol lookups then reported "N declarations; pass
  targetFilePath to disambiguate", and passing one of those positions resolved to
  nothing. The guard blocked the grep, demanded a disambiguation, and led nowhere.

  Declaration lookups now ignore access syntax (`a.b`, `Outer.Inner`), and group
  the remaining candidates by the declaration they ultimately stand for — so an
  object-literal key contextually typed by an interface resolves to that
  interface's property instead of rivalling it, and an overloaded function
  resolves to its implementation.

## 1.3.4

### Patch Changes

- 7451471: Teach the ts-surgeon equivalent after every eligible source grep, including single-file searches and OpenCode's native grep tool.

## 1.3.3

### Patch Changes

- 8000dcf: Fix the search answerer inside Bun-compiled hosts (OpenCode): `process.execPath` there is the host app's own binary, so the in-hook `find_references` child process printed the host's banner and the guard silently failed open. The runtime is now resolved via `Bun.which("node")`/`Bun.which("bun")` under Bun. Post-run teaching lines now also advertise the full toolset and the ts-surgeon skill, not just the one equivalent command.
- 8000dcf: Expose the OpenCode guard as a single named function export so OpenCode's plugin loader accepts it.

## 1.3.2

### Patch Changes

- f488fd1: Export only the guard plugin from the package entry point so OpenCode can load it.
- f488fd1: Stop printing the "pino-pretty was not found. Falling back to the default JSON
  console logging." warning on every run.

  `pino-pretty` is a devDependency, so it is expectedly absent in a published
  install (e.g. an `npx @commoncurriculum/ts-surgeon …` run). The logger defaults
  `NODE_ENV` to `development`, so the missing-transport warning fired on every
  consumer invocation even though nothing was wrong — the JSON fallback is the
  intended behavior there. Both the "not found" and the "Using pino-pretty"
  setup lines are now gated behind `LOG_LEVEL=debug`, so a normal run stays quiet
  while the diagnostic is still available when actually debugging the logger.

## 1.3.1

### Patch Changes

- bbc26ce: Stop printing the "pino-pretty was not found. Falling back to the default JSON
  console logging." warning on every run.

  `pino-pretty` is a devDependency, so it is expectedly absent in a published
  install (e.g. an `npx @commoncurriculum/ts-surgeon …` run). The logger defaults
  `NODE_ENV` to `development`, so the missing-transport warning fired on every
  consumer invocation even though nothing was wrong — the JSON fallback is the
  intended behavior there. Both the "not found" and the "Using pino-pretty"
  setup lines are now gated behind `LOG_LEVEL=debug`, so a normal run stays quiet
  while the diagnostic is still available when actually debugging the logger.

## 1.3.0

### Minor Changes

- 3c2a066: The guard now answers identifier searches instead of arguing, and its escape
  hatch is operator-only.

  A real transcript (2026-07-19) showed agents cargo-culting the advertised
  `TS_SURGEON_ALLOW=1` command prefix onto every search instead of using the
  tools. Two mechanism changes close that loop for good:

  - **Answer, don't argue.** When a Bash/Grep call recursively text-searches
    TS/JS sources for code identifiers, the hook runs `find_references` for
    every hunted symbol (one `batch` child process, one parsed project) and
    returns the real definitions and reference lists in the block message —
    the agent gets AST-accurate data in the same turn. Patterns are analyzed
    per regex syntax (BRE / ERE / fixed strings): alternations decompose into
    branches (`rg 'foo|bar'`, BRE `"foo\|bar"`), multiple `-e` patterns count,
    decorations strip to the identifier core (`\bname\b`, `name\(`, `^name$`),
    and declaration hunts (`grep -r "function renderStringAsData"`) resolve to
    the declared name. If nothing can be answered (no tsconfig, no project
    symbol among the hunted names, error, or the `TS_SURGEON_ANSWER_TIMEOUT_MS`
    budget — default 10s — expires), the search is **allowed through**:
    fail-open on reads, so legitimate greps (free text, true regexes, inverted
    matches, literal-pipe patterns) are never stranded. Hard blocks remain only
    for `sed -i`/`perl -i` on sources and runtime-dynamic recursive search
    loops. The guard is now a pipeline of independently tested stages under
    `src/cli/guard/` (shell → invocation → pattern intent → scope → policy →
    answer).
  - **Teach after every search.** A companion `PostToolUse` hook
    (`ts-surgeon hook --post`, installed by the plugin's hooks.json and by
    `init --claude-hook`; the opencode plugin's `tool.execute.after` does the
    same) appends a line after each executed search: the exact ts-surgeon
    equivalent when one exists ("next time, use `… call find_references
--symbol-name <name>` for faster, more accurate results"), or a generic
    pointer when there is no direct translation.
  - **Operator-only escape hatch.** The inline `TS_SURGEON_ALLOW=1` prefix is
    inert (a command carrying it gets an explicit "that does nothing" note);
    the guard is bypassed only when a human sets `TS_SURGEON_ALLOW=1` in the
    environment the hook runs in (e.g. `TS_SURGEON_ALLOW=1 claude`, or the
    `"env"` block of `.claude/settings.json`). No block message names a
    typeable bypass.

  Enabling change: `find_references` now accepts `--symbol-name` alone —
  `targetFilePath` is optional and the declaration is resolved project-wide
  (overloads dedupe; ambiguity errors list every candidate). Agents no longer
  need to know the declaring file, which was the chicken-and-egg reason to grep
  in the first place.

  Also from the same transcript: recursive flags pointed at explicitly named
  files (`grep -rn -A3 pattern a.ts b.ts`) are allowed — that is reading
  context, not hunting references.

## 1.2.0

### Minor Changes

- 1fca671: The PreToolUse guard now redirects text searches by default, not just sed/perl edits. Every `grep`/`rg` in a compound command is inspected (pipelines, `;`/`&&` chains, loops, `$(...)` substitutions); variable-pattern recursive greps over TS/JS sources — the export-sweep evasion — are blocked; and the harness's native Grep tool is covered (hook matcher `Bash|Grep`). The strict/default split is retired: `--strict` and `TS_SURGEON_STRICT` are accepted no-ops. Block messages name the concrete replacements (`find_references`, `search_pattern`, `find_unused_exports`) and the `TS_SURGEON_ALLOW=1` escape hatch. `init --claude-hook` upgrades older Bash-only matchers in place. A live-agent behavioral e2e suite (`pnpm test:e2e:agent`) proves the redirect against a real headless agent.

## 1.1.0

### Minor Changes

- ffa6a77: Publishable agent packaging and new CLI conveniences:

  - The repo is now a Claude Code plugin + marketplace (`/plugin marketplace add commoncurriculum/ts-surgeon`) shipping the `ts-surgeon` skill and the PreToolUse guard.
  - The npm package doubles as an opencode plugin: list it in opencode.json's `plugin` array (or run `init --opencode-hook`). `TS_SURGEON_STRICT=1` opts the fixed-command-line hooks into strict mode.
  - New `doctor` command, `--git-changed` / `--git-staged` file selection, `rewrite_where` (type-constrained structural rewrite), and `--all-projects` for solution-style tsconfigs.
  - Releases are now driven by changesets (this changeset is the first).
