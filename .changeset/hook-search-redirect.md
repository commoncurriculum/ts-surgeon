---
"@commoncurriculum/ts-surgeon": minor
---

The PreToolUse guard now redirects text searches by default, not just sed/perl edits. Every `grep`/`rg` in a compound command is inspected (pipelines, `;`/`&&` chains, loops, `$(...)` substitutions); variable-pattern recursive greps over TS/JS sources — the export-sweep evasion — are blocked; and the harness's native Grep tool is covered (hook matcher `Bash|Grep`). The strict/default split is retired: `--strict` and `TS_SURGEON_STRICT` are accepted no-ops. Block messages name the concrete replacements (`find_references`, `search_pattern`, `find_unused_exports`) and the `TS_SURGEON_ALLOW=1` escape hatch. `init --claude-hook` upgrades older Bash-only matchers in place. A live-agent behavioral e2e suite (`pnpm test:e2e:agent`) proves the redirect against a real headless agent.
