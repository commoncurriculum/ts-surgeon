---
name: release
description: Release @commoncurriculum/ts-surgeon via changesets — add/verify changesets, drive the Version Packages PR, and confirm the npm publish. Use when the user says "release", "publish to npm", "cut a version", or similar.
metadata:
  internal: true
---

# Release a new version (changesets)

Releases are fully automated by [changesets](https://changesets.dev) +
`.github/workflows/release.yml`. There is no manual tagging and no manual
version bump: **merging the bot's "Version Packages" PR is the release.**
`package.json` "version" is the single source of truth (bumped only by
changesets); `src/version.ts` reads it at runtime.

## How it flows

1. Feature PRs each carry a `.changeset/*.md` describing their bump.
2. Every push to main runs `release.yml`:
   - pending changesets exist → the action opens/updates the
     **"Version Packages" PR** (`chore: version package`) which applies them
     (bumps `package.json`, prepends `CHANGELOG.md`).
   - no pending changesets and `package.json` is ahead of npm → it publishes
     (`pnpm run release` = build + `changeset publish`, npm Trusted
     Publishing / OIDC + provenance) and pushes the `vX.Y.Z` tag.
3. So a release = merge the Version Packages PR, then verify.

## When the user says "release"

1. **Check for pending changesets**: `pnpm changeset status`. If the work to
   release has no changeset, add one now (`pnpm changeset`, or write
   `.changeset/<slug>.md` directly) on a PR — bump type per semver:
   `feat:` → minor, `fix:` → patch, breaking → major. Confirm bump type with
   the user when in doubt.
2. **Find the Version Packages PR** (title `chore: version package`, author
   github-actions[bot]). If it doesn't exist yet, the changesets landed on
   main only just now — wait for the release.yml run on main to open it.
3. **Review it** (version + CHANGELOG entries look right), then **merge it**.
4. **Watch the release.yml run on main** until the publish step succeeds.
5. **Confirm**: `npm view @commoncurriculum/ts-surgeon version` shows the new
   version, and the `vX.Y.Z` tag exists on origin.

## Failure recovery

- Publish failed after the Version PR merged → **fix forward**: re-run the
  failed workflow (`changeset publish` is idempotent — it skips versions npm
  already has). Never try to unpublish or overwrite; npm versions are
  immutable.
- The action didn't open the Version PR → check the repo Actions setting
  "Allow GitHub Actions to create and approve pull requests" is enabled, and
  read the release.yml run logs.

## Things to NOT do

- Do not edit `package.json` "version" or `CHANGELOG.md` by hand.
- Do not create or push `vX.Y.Z` tags manually — `changeset publish` does.
- Do not rename `release.yml` — npm Trusted Publishing pins the workflow
  filename.
