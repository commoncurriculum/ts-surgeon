---
"@commoncurriculum/ts-surgeon": patch
---

Review fixes on the template-aware guard and lookups change.

- `ts-surgeon <name>` no longer crashes with a raw `TypeError` stack when the command happens to be an `Object.prototype` key (`constructor`, `toString`, `valueOf`, …). The fast-path table that routes `guide`/`--version`/`-v` before the compiler loads was an object literal, so those names resolved to an inherited function; it is now a `Map`, and unknown commands reach the CLI's own "Unknown command" report as they should.
- The guard's source-presence walk stops as soon as its answer is decided. It kept draining its queue after the entry budget ran out, costing one `readdirSync` per already-queued directory — ~1500 wasted syscalls on a wide source-less tree, in a `PreToolUse` hook whose whole design constraint is to cost less than the grep it adjudicates.
- `find_references` falls back to the default declaration cap on a non-finite `maxDeclarations`, closing the one gap in that clamp (`Math.max(1, NaN)` is `NaN`, and `slice(0, NaN)` is the empty-but-reported-as-capped state the clamp exists to prevent).
- Docs match the shipped wording: the README described `rename_symbol` / `rename_filesystem_entry` as reporting what they "did not update", the action phrasing those tools deliberately avoid because it is false under `dryRun`. The agent-facing skill reference now also carries the template blind spot for `rename_symbol` / `rename_filesystem_entry` / `find_references`, and `find_references`'s ambiguous-name behavior.
