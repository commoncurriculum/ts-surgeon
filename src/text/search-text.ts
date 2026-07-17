import type { Project, SourceFile } from "ts-morph";

/**
 * Project-scoped plain-text / regex search. Deliberately not in src/ast-grep:
 * this is the "last legitimate grep" (TODOs, string literals, config keys) —
 * no AST involved — but it shares search_pattern's corpus (the tsconfig
 * project's source files), so it never wanders into node_modules, dist, or
 * lockfiles the way a recursive grep does.
 */

export interface TextMatch {
	filePath: string;
	line: number;
	column: number;
	/** The full text of the line containing the match (no trailing newline). */
	text: string;
}

export interface SearchTextResult {
	matches: TextMatch[];
	totalCount: number;
	truncated: boolean;
	scannedFiles: number;
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileQuery(
	query: string,
	regex: boolean,
	caseSensitive: boolean,
): RegExp {
	const source = regex ? query : escapeRegExp(query);
	const flags = caseSensitive ? "g" : "gi";
	try {
		return new RegExp(source, flags);
	} catch (error) {
		throw new Error(
			`Invalid regular expression '${query}': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Offset of the first character of every line, for offset -> line/col mapping. */
function lineStartOffsets(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			starts.push(i + 1);
		}
	}
	return starts;
}

/** Index of the line (0-based) containing the given offset, via binary search. */
function lineIndexOf(starts: number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (starts[mid] <= offset) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return low;
}

function lineTextAt(text: string, starts: number[], lineIndex: number): string {
	const start = starts[lineIndex];
	const end =
		lineIndex + 1 < starts.length ? starts[lineIndex + 1] - 1 : text.length;
	return text.slice(start, end).replace(/\r$/, "");
}

/**
 * Finds every occurrence of a literal string (or regex) across the project's
 * source files. Positions are 1-based; `text` carries the matched line.
 */
export function searchText(
	project: Project,
	{
		query,
		regex = false,
		caseSensitive = true,
		filePaths,
		maxResults = 200,
	}: {
		query: string;
		regex?: boolean;
		caseSensitive?: boolean;
		filePaths?: string[];
		maxResults?: number;
	},
): SearchTextResult {
	const pattern = compileQuery(query, regex, caseSensitive);
	let files: SourceFile[] = project.getSourceFiles();
	if (filePaths && filePaths.length > 0) {
		const wanted = new Set(filePaths);
		files = files.filter((sf) => wanted.has(sf.getFilePath()));
	}

	const matches: TextMatch[] = [];
	let totalCount = 0;
	for (const sourceFile of files) {
		const text = sourceFile.getFullText();
		const starts = lineStartOffsets(text);
		pattern.lastIndex = 0;
		let m = pattern.exec(text);
		while (m !== null) {
			totalCount++;
			if (matches.length < maxResults) {
				const lineIndex = lineIndexOf(starts, m.index);
				matches.push({
					filePath: sourceFile.getFilePath(),
					line: lineIndex + 1,
					column: m.index - starts[lineIndex] + 1,
					text: lineTextAt(text, starts, lineIndex),
				});
			}
			// A zero-length match (e.g. the regex 'a*') must still advance.
			if (m[0].length === 0) {
				pattern.lastIndex++;
			}
			m = pattern.exec(text);
		}
	}
	return {
		matches,
		totalCount,
		truncated: totalCount > matches.length,
		scannedFiles: files.length,
	};
}
