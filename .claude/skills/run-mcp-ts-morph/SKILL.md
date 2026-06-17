---
name: run-mcp-ts-morph
description: >-
  Build, launch, and drive the commoncurriculum/mcp-ts-morph MCP server — a
  ts-morph TypeScript/JavaScript refactoring server that speaks MCP over stdio.
  Use to build dist, run/start/launch the server, smoke-test it end-to-end
  (initialize → list tools → call a tool), or verify the refactoring tools still
  work after a change. Triggers: "run mcp-ts-morph", "launch the MCP server",
  "smoke test the server", "drive the ts-morph tools", "does the server start".
license: MIT
---

# Run: mcp-ts-morph (MCP stdio server)

`commoncurriculum/mcp-ts-morph` is a **stdio MCP server** (`dist/index.js`,
CommonJS) that exposes 15 ts-morph refactoring tools. There is no GUI and no
HTTP port: it reads JSON-RPC from stdin and writes JSON-RPC to stdout, with all
logs on stderr. Launching `node dist/index.js` by hand just blocks waiting for
a client — so you drive it programmatically.

**The driver is [`.claude/skills/run-mcp-ts-morph/driver.mjs`](driver.mjs).** It
launches the built server through the official MCP SDK client and runs a real
end-to-end flow: the `initialize` handshake, `tools/list` (asserts all 15 tools
are registered), then two `tools/call`s against a throwaway fixture project — a
read-only one (`get_diagnostics`, must surface a deliberate type error) and a
mutating one (`rename_symbol` in `dryRun`, must report the files it would
touch). Exit 0 = the server launched and is fully drivable.

> Paths below are relative to the repo root (the unit). Node 22 (pinned by
> Volta) and pnpm 11 are assumed; this is a pure Node/TypeScript project — **no
> `apt-get` system packages are needed** (no native GUI deps).

## Build

```bash
pnpm install
pnpm build        # tsc -> dist/, then chmod +x dist/index.js
```

`pnpm build` runs `clean` first, so `dist/` is wiped and regenerated — always
build after a fresh clone (or after `pnpm clean`) before driving.

## Run (agent path) — the driver

```bash
node .claude/skills/run-mcp-ts-morph/driver.mjs
```

Verified output (trimmed) — exit code 0:

```
[driver] connect: initialize handshake OK
[driver] tools/list: 15 tools registered
  add_missing_imports_by_tsmorph
  ... (15 total) ...
  safe_delete_symbol_by_tsmorph
[driver] get_diagnostics: Diagnostics: 1 total (1 error(s), 0 warning(s))
[driver] rename_symbol(dryRun): Dry run complete: Renaming symbol 'greet' to 'salute' ...
[driver] PASS — server launched and driven end-to-end.
```

Notes:
- The driver creates its fixture in a temp dir and removes it on exit; the one
  mutating call uses `dryRun`, so nothing is written. Safe to run repeatedly.
- It locates the server at `<repo>/dist/index.js`; override with
  `REPO_ROOT=/abs/path node .../driver.mjs` if running from elsewhere.
- Server logs are silenced via `LOG_LEVEL=silent`; pass `LOG_LEVEL=debug` to see
  the server's pino output (on stderr) interleaved with driver steps.

To drive a different tool, copy the `client.callTool({ name, arguments })`
pattern in `driver.mjs`. All tool arguments require **absolute** paths
(`tsconfigPath`, `targetFilePath`, …) and **1-based** positions.

## Direct invocation (internal-logic path)

Most PRs here touch `src/ts-morph/**`, not the MCP wire layer. Those are driven
fastest through the co-located vitest specs (each tool has a
`*OnProject(project, params)` core that tests call against an in-memory
project — no server, no stdio):

```bash
pnpm check-types
pnpm test -- src/ts-morph/safe-delete-symbol/safe-delete-symbol.test.ts
```

(The runner is single-threaded by config; a "single file" filter still loads the
shared suite, ~470 tests, in ~60–75s.) For real-repo regression coverage,
`pnpm test:e2e` clones hono/zustand and applies every tool — run it before
finishing work that touches refactoring logic (see CLAUDE.md).

## Run (human path) — wire it into an MCP client

Point any MCP client at the built entry (this is config, not a long-running
command you watch):

```json
{
  "mcpServers": {
    "mcp-ts-morph": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-ts-morph/dist/index.js"],
      "env": { "LOG_LEVEL": "info" }
    }
  }
}
```

Restart the client; the 15 `*_by_tsmorph` tools appear. (Running
`node dist/index.js` in a bare terminal looks like it hangs — that's correct; it
is waiting for a JSON-RPC client on stdin.)

## Gotchas

- **Bare launch looks frozen.** `node dist/index.js` with no client blocks on
  stdin forever. That is the server working, not a crash. Drive it via the
  driver or an MCP client.
- **stdout is the JSON-RPC channel — logs go to stderr.** Pino writes to stderr
  (you'll see `Using pino-pretty for console logging.` and a `SIGTERM` line on
  shutdown). Never write to stdout from tool code; it would corrupt the
  protocol. `LOG_LEVEL=silent` quiets it.
- **The `inspector` npm script is broken.** `package.json` has
  `inspector: "npx @modelcontextprotocol/inspector node build/index.js"`, but
  the build output is `dist/`, not `build/`. Use
  `npx @modelcontextprotocol/inspector node dist/index.js` instead.
- **dist is CommonJS; the driver is ESM.** There is no `"type": "module"`, so
  `dist/index.js` is CJS. The driver is a `.mjs` file (always ESM) and imports
  `@modelcontextprotocol/sdk/client/*` — this mix is fine because the SDK ships
  ESM subpaths and the driver resolves them from the repo's `node_modules`.
- **Always rebuild after a clean clone.** `pnpm build` deletes `dist/` first; the
  driver fails fast with "server entry not found … Run `pnpm build` first" if you
  skip it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FAIL: server entry not found at …/dist/index.js` | `pnpm build` |
| Driver throws `Cannot find package '@modelcontextprotocol/sdk'` | `pnpm install` (the driver resolves the SDK from the repo's `node_modules`) |
| `tools/list` shows fewer than 15 tools | a `register-*.ts` isn't wired into `src/mcp/tools/ts-morph-tools.ts` — run `/check-docs` |
| A `tools/call` returns `Error: … MUST be absolute` | pass absolute `tsconfigPath` / file paths; positions are 1-based |
