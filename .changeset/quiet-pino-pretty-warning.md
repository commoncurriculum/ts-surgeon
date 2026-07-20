---
"@commoncurriculum/ts-surgeon": patch
---

Stop printing the "pino-pretty was not found. Falling back to the default JSON
console logging." warning on every run.

`pino-pretty` is a devDependency, so it is expectedly absent in a published
install (e.g. an `npx @commoncurriculum/ts-surgeon …` run). The logger defaults
`NODE_ENV` to `development`, so the missing-transport warning fired on every
consumer invocation even though nothing was wrong — the JSON fallback is the
intended behavior there. Both the "not found" and the "Using pino-pretty"
setup lines are now gated behind `LOG_LEVEL=debug`, so a normal run stays quiet
while the diagnostic is still available when actually debugging the logger.
