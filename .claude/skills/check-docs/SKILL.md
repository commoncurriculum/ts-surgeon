---
name: check-docs
description: Checks consistency between registered tools (src/tools/register-*.ts) and the tool table in README.md and the module list in CLAUDE.md. Detects missing entries and drift after adding tools or reorganizing documentation. Use for "check doc consistency", "verify README matches code", "check tool list", or similar.
---

# Documentation Consistency Check

In the past, the README tool table (drifted by 6→8 entries) and the CLAUDE.md module list diverged from reality. This skill mechanically cross-references registered tools against documentation and reports missing entries and surplus entries.

This skill is **read-only inspection**. It may suggest fixes but will not modify files on its own (the user confirms before changes are applied).

## Steps

### 1. Extract Registered Tool Names

The CLI itself is the source of truth:

```bash
pnpm build >/dev/null && node dist/index.js list --json | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8")).forEach(t=>console.log(t.name))' | sort
```

Also cross-reference with the registration functions actually called inside `registerTsMorphTools` in `ts-morph-tools.ts` (to detect: imported but not called / called but missing import):

```bash
grep -E 'register[A-Za-z]+Tool' src/tools/ts-morph-tools.ts
```

### 2. Cross-reference the README Tool Table

Extract the "Available Tools" table (`| [\`xxx\`]... |`) and each detail section (`### \`xxx\``) from `README.md`. Tool names are unsuffixed snake_case, so compare against the names emitted by `list --json` rather than a suffix pattern:

```bash
grep -oE '^### `[a-z_]+`' README.md | grep -oE '[a-z_]+' | grep -v '^$' | sort -u
```

- In the table but not in code → surplus (candidate for removal)
- In code but not in the table → **missing entry** (needs to be added)
- In the table but the corresponding `### ` section is missing → broken link

### 3. Cross-reference the CLAUDE.md Module List

Compare the actual directories and files under `src/ts-morph/` against the "ts-morph layer" and "Key Features and Implementation Files" sections of CLAUDE.md:

```bash
ls src/ts-morph/
```

- A module that exists but is missing from CLAUDE.md → missing entry
- An entry in CLAUDE.md that no longer exists → stale entry (should be removed)

### 4. Report Format

```
## Documentation Consistency Check Results

### Registered Tools (N items)
- ...

### README
- [OK] Table and detail sections match
- [MISSING] xxx is not in the table
- [BROKEN LINK] anchor target section for yyy is missing

### CLAUDE.md
- [MISSING] src/ts-morph/zzz/ is not in the module list
- [STALE] aaa no longer exists

### Suggested Fixes
(Summary of the diff. Apply after user confirmation.)
```

If there are no discrepancies, state "consistent" explicitly.
