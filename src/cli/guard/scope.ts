/**
 * Stage 4 of the guard pipeline: is this search aimed at project TS/JS
 * sources at all? Explicit --include/--glob/--type filters win; otherwise
 * the path arguments decide. "unknown" (bare directories, no paths) counts
 * as source — that is where project code lives.
 */

export const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)\b/;

export const RG_SOURCE_TYPES = new Set([
	"ts",
	"typescript",
	"js",
	"javascript",
]);

/** Directory names that never hold project TS/JS sources worth guarding. */
const NON_SOURCE_DIRS = new Set([
	"docs",
	"doc",
	"documentation",
	"logs",
	"log",
	"tmp",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	".git",
	"etc",
	"var",
	"usr",
	"opt",
	"proc",
	"sys",
	"dev",
]);

export function hasFileExtension(p: string): boolean {
	return /\.[A-Za-z0-9]{1,8}$/.test(p) || SOURCE_EXT_RE.test(p);
}

export function isNonSourcePath(p: string): boolean {
	if (SOURCE_EXT_RE.test(p)) {
		return false;
	}
	const top = p.replace(/^\.?\//, "").split("/")[0];
	return NON_SOURCE_DIRS.has(top) || hasFileExtension(p);
}

/** A path token that names one concrete file (an extension, no glob chars). */
export function isExplicitFile(p: string): boolean {
	return !/[*?[]/.test(p) && hasFileExtension(p);
}

export type SearchScope = "source" | "non-source" | "unknown";

export function resolveSearchScope(inv: {
	includeGlobs: string[];
	rgTypes: string[];
	paths: string[];
}): SearchScope {
	const filterSource =
		inv.includeGlobs.some((g) => SOURCE_EXT_RE.test(g)) ||
		inv.rgTypes.some((t) => RG_SOURCE_TYPES.has(t));
	// A glob only narrows scope away from sources when it names a concrete
	// non-source extension; wildcards like `*.*` or `src/**` cover sources too.
	const filterNeutral = inv.includeGlobs.some(
		(g) => !SOURCE_EXT_RE.test(g) && !/\.[A-Za-z0-9]{1,8}$/.test(g),
	);
	if (filterSource) {
		return "source";
	}
	if (
		(inv.includeGlobs.length > 0 || inv.rgTypes.length > 0) &&
		!filterNeutral
	) {
		return "non-source";
	}
	if (inv.paths.some((p) => SOURCE_EXT_RE.test(p))) {
		return "source";
	}
	if (inv.paths.length > 0 && inv.paths.every(isNonSourcePath)) {
		return "non-source";
	}
	return "unknown";
}
