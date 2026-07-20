---
"@commoncurriculum/ts-surgeon": minor
---

The guard now answers identifier searches instead of arguing, and its escape
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
