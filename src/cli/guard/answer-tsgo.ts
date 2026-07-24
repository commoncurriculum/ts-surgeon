import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { findNearestTsconfig } from "../paths.js";
import { findReferencesViaTsgo } from "../../tsgo/find-references.js";
import {
	type PerSymbolResult,
	type SearchAnswer,
	type SearchAnswerRequest,
	formatSearchAnswer,
} from "./answer.js";
import { hasFileExtension } from "./scope.js";

/**
 * Answers an intercepted identifier search with tsgo instead of ts-morph.
 *
 * Same question, same answer, a fraction of the time: ts-morph has to parse
 * the project and load its dependency type graph on every call, which is
 * ~1.2s on a real repo. tsgo answers in ~250ms from a process that starts,
 * answers and exits — no daemon, no cache, nothing that can go stale. The
 * agreement between the two engines is pinned in
 * src/tsgo/find-references.test.ts; this file only adapts the result.
 */

const ANSWER_TIMEOUT_MS = Number(
	process.env.TS_SURGEON_ANSWER_TIMEOUT_MS ?? "10000",
);

/** The source line a location points at, for the answer's context column. */
function lineText(filePath: string, line: number): string {
	try {
		return (
			readFileSync(filePath, "utf-8").split(/\r?\n/)[line - 1]?.trim() ?? ""
		);
	} catch {
		return "";
	}
}

/** Reduces a search root (which may be a glob or a file) to a directory. */
export function searchRootDirectory(cwd: string, searchRoot?: string): string {
	let rootDir = existsSync(cwd) ? cwd : process.cwd();
	if (searchRoot === undefined) {
		return rootDir;
	}
	let dir = path.resolve(rootDir, searchRoot.split(/[*?[]/)[0]);
	if (hasFileExtension(dir)) {
		dir = path.dirname(dir);
	}
	while (dir !== path.dirname(dir) && !existsSync(dir)) {
		dir = path.dirname(dir);
	}
	if (existsSync(dir)) {
		rootDir = dir;
	}
	return rootDir;
}

export async function answerSearchViaTsgo(
	req: SearchAnswerRequest,
): Promise<SearchAnswer> {
	if (req.symbolNames.length === 0) {
		return { ok: false };
	}
	const rootDir = searchRootDirectory(req.cwd, req.searchRoot);
	const tsconfigPath = findNearestTsconfig(rootDir);
	if (tsconfigPath === undefined) {
		return { ok: false };
	}
	// The project root the language server should load is the tsconfig's
	// directory, not the (possibly deeper) directory being searched.
	const projectDir = path.dirname(tsconfigPath);

	const results: PerSymbolResult[] = [];
	for (const symbolName of req.symbolNames) {
		const found = await findReferencesViaTsgo({
			rootDir: projectDir,
			symbolName,
			timeoutMs: ANSWER_TIMEOUT_MS,
		});
		if (found.status === "unavailable") {
			// tsgo could not be run at all — say nothing rather than half an answer.
			return { ok: false };
		}
		if (found.status === "not-found") {
			results.push({ symbolName, status: "not-found" });
			continue;
		}
		if (found.status === "ambiguous") {
			const candidates = found.candidates
				.map((c) => `  - ${c.filePath}:${c.line}:${c.column}`)
				.join("\n");
			results.push({
				symbolName,
				status: "ambiguous",
				message: `'${symbolName}' has ${found.candidates.length} declarations in the project; pass targetFilePath (and position if needed) to disambiguate:\n${candidates}`,
			});
			continue;
		}
		const declaration = {
			...found.declaration,
			text: lineText(found.declaration.filePath, found.declaration.line),
		};
		results.push({
			symbolName,
			status: "found",
			definition: declaration,
			// tsgo includes the declaration in its reference list; the answer shows
			// it separately, so it must not appear twice. Match the full position —
			// file, line and column — so a real reference sharing the declaration's
			// line (e.g. `const a = f(), b = f()`) is not dropped with it.
			references: found.references
				.filter(
					(r) =>
						!(
							r.filePath === found.declaration.filePath &&
							r.line === found.declaration.line &&
							r.column === found.declaration.column
						),
				)
				.map((r) => ({ ...r, text: lineText(r.filePath, r.line) })),
		});
	}

	if (!results.some((r) => r.status === "found" || r.status === "ambiguous")) {
		return { ok: false };
	}
	return { ok: true, text: formatSearchAnswer(tsconfigPath, results) };
}
