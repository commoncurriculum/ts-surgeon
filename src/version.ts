import { readFileSync } from "node:fs";

// package.json "version" is the single source of truth, managed by changesets
// (never bump it by hand — merging the "Version Packages" PR does). Reading it
// at runtime works identically from dist/ (published package) and src/
// (tsx/vitest): both sit one level below the package root, and package.json is
// always shipped ("files" includes it).
export const VERSION: string = (
	JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
	) as { version: string }
).version;
