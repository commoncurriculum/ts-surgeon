---
name: run-ts-morph-cli
description: >-
  Build, launch, and drive the commoncurriculum/mcp-ts-morph refactoring CLI —
  a ts-morph TypeScript/JavaScript refactoring tool driven via shell. Use to
  build dist, run the CLI, smoke-test it end-to-end (list tools → describe →
  call a tool), or verify the refactoring tools still work after a change.
  Triggers: "run mcp-ts-morph", "run the CLI", "smoke test the CLI", "drive the
  ts-morph tools", "does the CLI work".
license: MIT
---

# Run: mcp-ts-morph (refactoring CLI)

`commoncurriculum/mcp-ts-morph` is a **CLI** (`dist/index.js`, CommonJS) that
exposes 15 ts-morph refactoring tools as one-shot subcommands. There is no
server and no GUI: every invocation is a plain process that prints its result
to stdout and exits (0 = success, 1 = tool error, 2 = usage/params error).
Logs go to stderr (`LOG_LEVEL` defaults to `warn`).

> Paths below are relative to the repo root. Node 22 (pinned by Volta) and
> pnpm 11 are assumed; this is a pure Node/TypeScript project — **no
> `apt-get` system packages are needed**.

## Build

```bash
pnpm install
pnpm build        # tsc -> dist/, then chmod +x dist/index.js
```

`pnpm build` runs `clean` first, so `dist/` is wiped and regenerated — always
build after a fresh clone (or after `pnpm clean`) before driving.

## Smoke test (agent path)

Three commands prove the CLI is fully drivable:

```bash
# 1. All 15 tools registered?
node dist/index.js list

# 2. Schema introspection works?
node dist/index.js describe rename_symbol

# 3. A real tool call works? (create a throwaway fixture first)
FIX=$(mktemp -d)
printf '{"compilerOptions":{"strict":true},"include":["*.ts"]}' > "$FIX/tsconfig.json"
printf 'const n: number = "oops";\n' > "$FIX/bad.ts"
node dist/index.js call get_diagnostics \
  --params "{\"tsconfigPath\": \"$FIX/tsconfig.json\"}"
# Expect: "TS2322" in the output, exit 0
rm -rf "$FIX"
```

For a mutating tool, add `"dryRun": true` to the params to preview without
writing. All tool paths must be **absolute**; positions are **1-based**.

## Direct invocation (internal-logic path)

Most PRs here touch `src/ts-morph/**`, not the CLI shell. Those are driven
fastest through the co-located vitest specs (each tool has a
`*OnProject(project, params)` core that tests call against an in-memory
project — no process spawning):

```bash
pnpm check-types
pnpm test -- src/ts-morph/safe-delete-symbol/safe-delete-symbol.test.ts
```

(The runner is single-threaded by config; a "single file" filter still loads the
shared suite, ~490 tests, in ~60–75s.) For real-repo regression coverage,
`pnpm test:e2e` clones hono/zustand and applies every tool — run it before
finishing work that touches refactoring logic (see CLAUDE.md).

## Run (human path)

Use it from any shell — published package or local build:

```bash
npx -y @commoncurriculum/ts-surgeon list          # published
node /abs/path/to/mcp-ts-morph/dist/index.js list     # local build
```

## Gotchas

- **stdout is the result channel — logs go to stderr.** Never write to stdout
  from tool code; scripts parse it. `LOG_LEVEL=silent` quiets stderr entirely.
- **`call` with no params reads stdin.** In a non-TTY context (CI, agents), a
  `call` without `--params`/`--params-file` blocks reading stdin — pipe JSON in
  or pass the flag.
- **dist is CommonJS.** There is no `"type": "module"`; `dist/index.js` is CJS.
- **Always rebuild after a clean clone.** `pnpm build` deletes `dist/` first.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module …/dist/index.js` | `pnpm build` |
| `list` shows fewer than 15 tools | a `register-*.ts` isn't wired into `src/tools/ts-morph-tools.ts` — run `/check-docs` |
| A `call` returns `Error: … MUST be absolute` | pass absolute `tsconfigPath` / file paths; positions are 1-based |
| Exit code 2 with `Invalid parameters for '<tool>'` | params don't match the schema — check `describe <tool>` |
