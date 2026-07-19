# @commoncurriculum/ts-surgeon

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
