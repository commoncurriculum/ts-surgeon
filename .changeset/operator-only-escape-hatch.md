---
"@commoncurriculum/ts-surgeon": minor
---

Make the guard's escape hatch operator-only and close the observed evasions.

A real transcript (2026-07-19) showed agents cargo-culting the advertised
`TS_SURGEON_ALLOW=1` command prefix onto every search instead of using the
tools. The inline prefix is now inert (a blocked command carrying it gets an
explicit "that does nothing" note); the guard is bypassed only when a human
sets `TS_SURGEON_ALLOW=1` in the environment the hook runs in (e.g.
`TS_SURGEON_ALLOW=1 claude`, or the `"env"` block of `.claude/settings.json`).
Block messages no longer name any typeable bypass.

Two precision changes from the same transcript: recursive declaration hunts
(`grep -r "function renderStringAsData"`, `rg 'export const cartTotal'`) are
now blocked like bare identifier lookups, and recursive flags pointed at
explicitly named files (`grep -rn -A3 pattern a.ts b.ts`) are now allowed —
that is reading context, not hunting references.
