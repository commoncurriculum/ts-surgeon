---
"@commoncurriculum/ts-surgeon": patch
---

Fix the search answerer inside Bun-compiled hosts (OpenCode): `process.execPath` there is the host app's own binary, so the in-hook `find_references` child process printed the host's banner and the guard silently failed open. The runtime is now resolved via `Bun.which("node")`/`Bun.which("bun")` under Bun. Post-run teaching lines now also advertise the full toolset and the ts-surgeon skill, not just the one equivalent command.
