---
"@commoncurriculum/ts-surgeon": minor
---

Add `ts-surgeon install`: compile the guard, and stop paying npx on every tool call.

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
