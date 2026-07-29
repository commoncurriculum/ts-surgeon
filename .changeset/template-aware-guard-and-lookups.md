---
"@commoncurriculum/ts-surgeon": minor
---

Address a nine-point defect report (2026-07-29) about tools reporting more confidence than they have.

**Guard**
- Hand-edits of TS/JS are detected by write *effect* rather than by binary name: interpreter one-liners that read → substitute → write back (`python3 -c`, `node -e`, `ruby -e`, `php -r`, bun/deno, target may be a variable) and redirects/`tee` that overwrite an **existing** source file now block, alongside `sed -i`/`perl -i`. Creating a new file that way stays allowed.
- Block messages no longer claim "this guard has no in-session bypass" — a partial denylist cannot promise total coverage, and the false claim invited hunting for the mechanism that slips through.
- Neither the answer nor the teaching hook fires for searches over paths that exist and demonstrably hold no TS/JS (e.g. a `defmodule` grep in an Elixir tree).

**Template-based frameworks (Glint/Ember, Vue, Svelte)**
- Tools now detect the environment from the tsconfig they already read and stop presenting partial results as complete: `find_references` reports the blind spot and lists matching template lines as text; `rename_symbol` / `rename_filesystem_entry` report which templates they did not update; `safe_delete_symbol` refuses to delete a symbol a template still mentions.

**Lookups**
- `find_references` answers every declaration of an ambiguous name instead of erroring and forcing a second process start and project parse (`--json` data gains `declarations`).
- A file that exists on disk but sits outside the tsconfig's include globs now says so, instead of the misleading "File not found".
- Read-only tools fan out across a solution-style tsconfig's referenced projects by default; `--single-project` opts out, and the per-invocation warning is gone.

**Startup**
- `guide`, `--version` and `-v` no longer load ts-morph and the TypeScript compiler (~1s → ~50ms).
