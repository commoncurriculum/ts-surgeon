import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/**
 * Locates the tsgo executable shipped by @typescript/native-preview.
 *
 * The binary lives in a per-platform optional dependency
 * (@typescript/native-preview-darwin-arm64 and friends) at lib/tsgo. The
 * package's own resolver, lib/getExePath.js, is not reachable by subpath
 * because the "exports" map does not list lib/ — so the platform package is
 * resolved directly, which stays synchronous and costs nothing on a path that
 * runs before every answered search.
 */

let cached: string | null | undefined;

export function resolveTsgoExe(): string | undefined {
	if (cached !== undefined) {
		return cached ?? undefined;
	}
	cached = null;
	try {
		const require = createRequire(import.meta.url);
		// The platform binary is an optional dependency *of* native-preview, not
		// of this package. Under pnpm's isolated layout it therefore is not
		// resolvable from here — only from native-preview's own directory. (This
		// is why resolving it directly works under Vitest, whose resolver is
		// laxer, and fails in the published package.)
		const hostPackageJson = require.resolve(
			"@typescript/native-preview/package.json",
		);
		const fromHost = createRequire(hostPackageJson);
		const platformPackage = `@typescript/native-preview-${process.platform}-${process.arch}`;
		const packageRoot = path.dirname(
			fromHost.resolve(`${platformPackage}/package.json`),
		);
		const exePath = path.join(
			packageRoot,
			"lib",
			process.platform === "win32" ? "tsgo.exe" : "tsgo",
		);
		if (existsSync(exePath)) {
			cached = exePath;
		}
	} catch {
		cached = null;
	}
	return cached ?? undefined;
}

/** Test seam: forget a previously resolved path. */
export function resetTsgoExeCache(): void {
	cached = undefined;
}
