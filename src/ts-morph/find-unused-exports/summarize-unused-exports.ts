import type { UnusedExport } from "./find-unused-exports.js";

export interface KindCount {
	kind: string;
	count: number;
}

export interface DirectoryCount {
	directory: string;
	count: number;
}

export interface UnusedExportsSummary {
	/** Total number of candidates */
	total: number;
	/** Count of entries where `sameFileReferenceCount === 0` = truly dead (safe to delete the whole declaration) */
	deletable: number;
	/** Count of entries where `sameFileReferenceCount >= 1` = over-exported (only the export keyword is unnecessary) */
	unexportOnly: number;
	/** Count of `[default]` candidates (prone to false positives) */
	defaultExports: number;
	/** Count per declaration kind (descending by count, then ascending by kind name) */
	byKind: KindCount[];
	/** Count per directory (file name stripped) (descending by count, then ascending by path) */
	byDirectory: DirectoryCount[];
}

function dirnameOf(filePath: string): string {
	const idx = filePath.lastIndexOf("/");
	return idx <= 0 ? "/" : filePath.slice(0, idx);
}

/**
 * Returns a stable-sorted `[key, count]` array in descending count order, ties broken by ascending key.
 */
function rank(counts: Map<string, number>): { key: string; count: number }[] {
	return [...counts.entries()]
		.map(([key, count]) => ({ key, count }))
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Pure function that aggregates the candidate array from `findUnusedExports` into a summary
 * suitable for a high-level overview even on large repositories.
 *
 * Listing every candidate line-by-line can easily exceed an agent's token budget, so this function
 * returns only aggregate counts by "deletable / unexportOnly", "by kind", and "by directory"
 * so the agent can quickly assess scope.
 */
export function summarizeUnusedExports(
	entries: UnusedExport[],
): UnusedExportsSummary {
	const byKind = new Map<string, number>();
	const byDirectory = new Map<string, number>();
	let deletable = 0;
	let unexportOnly = 0;
	let defaultExports = 0;

	for (const e of entries) {
		if (e.sameFileReferenceCount === 0) deletable++;
		else unexportOnly++;
		if (e.isDefaultExport) defaultExports++;
		byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
		const dir = dirnameOf(e.filePath);
		byDirectory.set(dir, (byDirectory.get(dir) ?? 0) + 1);
	}

	return {
		total: entries.length,
		deletable,
		unexportOnly,
		defaultExports,
		byKind: rank(byKind).map(({ key, count }) => ({ kind: key, count })),
		byDirectory: rank(byDirectory).map(({ key, count }) => ({
			directory: key,
			count,
		})),
	};
}
