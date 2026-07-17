# @commoncurriculum/ts-surgeon

## 1.1.0

### Minor Changes

- ffa6a77: Publishable agent packaging and new CLI conveniences:

  - The repo is now a Claude Code plugin + marketplace (`/plugin marketplace add commoncurriculum/ts-surgeon`) shipping the `ts-surgeon` skill and the PreToolUse guard.
  - The npm package doubles as an opencode plugin: list it in opencode.json's `plugin` array (or run `init --opencode-hook`). `TS_SURGEON_STRICT=1` opts the fixed-command-line hooks into strict mode.
  - New `doctor` command, `--git-changed` / `--git-staged` file selection, `rewrite_where` (type-constrained structural rewrite), and `--all-projects` for solution-style tsconfigs.
  - Releases are now driven by changesets (this changeset is the first).
