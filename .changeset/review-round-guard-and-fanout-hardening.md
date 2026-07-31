---
"@commoncurriculum/ts-surgeon": patch
---

Review-round hardening of the guard, the template blind-spot scan, and fan-out:

- The guard no longer blocks quoted prose containing `->` (e.g. `git commit -m "moved a.ts -> src/index.ts"`): overwrite targets are harvested from the quote-aware tokenizer, never from a raw-string regex. Read-mode `open('Main.java')` no longer matches the write-API pattern (the mode must be its own argument). Heredoc-fed interpreters (`python3 <<'EOF'`) and attached eval flags (`node --eval=…`, `python3 -c"…"`) are now detected.
- Angular components are matched by the `selector`/pipe-`name` string in their own decorator, so `ng generate component` defaults (`<app-hero-detail>`) no longer walk past `safe_delete_symbol`'s template refusal or `find_unused_exports`' likely-used warning.
- `safe_delete_symbol` under `dryRun` + `ignoreTemplateMentions` says "Would delete despite N template text match(es)" instead of claiming a deletion that never happened, and attaches `templateBlindSpot` to `--json` data on the success path too.
- Default fan-out no longer exits 1 when the target file or symbol lives in one referenced project and the others answer "not mine" — those are reported as `skipped` per project; merged arrays drop structurally identical duplicates from files shared between projects; tools outside the fan-out set are no longer accused of "mutating files".
- Template-environment detection follows every entry of a TS 5.0 array `extends`, and recognizes create-vue (`@vue/tsconfig`) and SvelteKit (`.svelte-kit/tsconfig.json`) scaffolds by their extends strings.
- The template scan keeps collecting invocation-shaped matches after generic noise exhausts its budget, searches every declaring file of a shared export name, and bounds the walk by directories visited.
- The hook's search answerer fans its batch out across a solution config's referenced projects instead of parsing the empty solution project and failing open.
