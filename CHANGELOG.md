# @commoncurriculum/ts-surgeon

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
