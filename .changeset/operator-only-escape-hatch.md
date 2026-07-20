---
"@commoncurriculum/ts-surgeon": minor
---

The guard now answers identifier searches instead of arguing, and its escape
hatch is operator-only.

A real transcript (2026-07-19) showed agents cargo-culting the advertised
`TS_SURGEON_ALLOW=1` command prefix onto every search instead of using the
tools. Two mechanism changes close that loop for good:

- **Answer, don't argue.** When a Bash/Grep call recursively text-searches
  TS/JS sources for a code identifier (including declaration hunts like
  `grep -r "function renderStringAsData"`), the hook runs `find_references`
  itself and returns the real definition and reference list in the block
  message — the agent gets AST-accurate data in the same turn. If the lookup
  cannot answer (no tsconfig, not a project symbol, error, or the
  `TS_SURGEON_ANSWER_TIMEOUT_MS` budget — default 45s — expires), the search
  is **allowed through**: fail-open on reads, so legitimate greps are never
  stranded. Hard blocks remain only for `sed -i`/`perl -i` on sources and
  runtime-dynamic recursive search loops.
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
