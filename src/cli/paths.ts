import { existsSync } from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

/**
 * Keys whose string values are filesystem paths to resolve against cwd.
 * Convention: path fields end in "Path"/"Paths" (entryPoints is the one
 * grandfathered exception) — a drift-guard test walks every registered
 * schema and fails if a new path-shaped field escapes this heuristic.
 */
export function isPathKey(key: string): boolean {
	return /paths?$/i.test(key) || key === "entryPoints";
}

/**
 * Resolves every relative path in the params against `cwd`, recursively
 * (covers nested shapes like renames[].oldPath). Glob-pattern fields
 * (e.g. excludeFilePatterns) are left untouched.
 */
export function resolvePathParams(value: unknown, cwd: string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => resolvePathParams(item, cwd));
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		if (isPathKey(key) && typeof v === "string") {
			out[key] = path.resolve(cwd, v);
		} else if (
			isPathKey(key) &&
			Array.isArray(v) &&
			v.every((item) => typeof item === "string")
		) {
			out[key] = v.map((item) => path.resolve(cwd, item));
		} else {
			out[key] = resolvePathParams(v, cwd);
		}
	}
	return out;
}

/**
 * Referenced tsconfig paths of a solution-style tsconfig (one with a
 * "references" array), resolved to concrete tsconfig.json files. Empty for
 * ordinary configs, unreadable files, and configs without references.
 * Uses the TypeScript reader because tsconfig JSON allows comments.
 */
export function solutionReferences(tsconfigPath: string): string[] {
	try {
		const { config } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
		const references: unknown = config?.references;
		if (!Array.isArray(references)) {
			return [];
		}
		return references
			.map((ref) =>
				typeof (ref as { path?: unknown })?.path === "string"
					? path.resolve(
							path.dirname(tsconfigPath),
							(ref as { path: string }).path,
						)
					: undefined,
			)
			.filter((p): p is string => p !== undefined)
			.map((p) => (p.endsWith(".json") ? p : path.join(p, "tsconfig.json")));
	} catch {
		return [];
	}
}

/** Walks up from `startDir` to find the nearest tsconfig.json. */
export function findNearestTsconfig(startDir: string): string | undefined {
	let dir = path.resolve(startDir);
	for (;;) {
		const candidate = path.join(dir, "tsconfig.json");
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/** Picks the directory tsconfig discovery should start from. */
function tsconfigSearchStart(
	params: Record<string, unknown>,
	cwd: string,
): string {
	const fileHint =
		params.targetFilePath ??
		params.originalFilePath ??
		params.targetPath ??
		(Array.isArray(params.filePaths) ? params.filePaths[0] : undefined) ??
		(Array.isArray(params.renames)
			? (params.renames[0] as Record<string, unknown> | undefined)?.oldPath
			: undefined);
	return typeof fileHint === "string" ? path.dirname(fileHint) : cwd;
}

/**
 * Prepares raw params for a tool call: resolves relative paths against cwd
 * and fills in tsconfigPath from the nearest tsconfig.json when omitted.
 */
export function prepareParams(
	raw: Record<string, unknown>,
	cwd: string = process.cwd(),
): Record<string, unknown> {
	const resolved = resolvePathParams(raw, cwd) as Record<string, unknown>;
	if (resolved.tsconfigPath === undefined) {
		const found = findNearestTsconfig(tsconfigSearchStart(resolved, cwd));
		if (found) {
			resolved.tsconfigPath = found;
		}
	}
	return resolved;
}
