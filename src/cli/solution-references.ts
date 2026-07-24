import * as path from "node:path";
import * as ts from "typescript";

/**
 * Split out of paths.ts so the guard's fast path never reaches the TypeScript
 * compiler. paths.ts is on the hook's import graph; loading typescript there
 * cost ~160ms on every tool call to decide a command was harmless.
 */

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
