import { Lang, parse, type SgNode } from "@ast-grep/napi";
import type { Project, SourceFile } from "ts-morph";
import {
	getChangedFiles,
	saveProjectChanges,
} from "../ts-morph/_utils/ts-morph-project";

/**
 * Structural pattern search and rewrite, powered by ast-grep (tree-sitter).
 * These are the syntax-shape counterparts to the type-aware ts-morph tools:
 * find_references answers "who uses this symbol"; search_pattern answers
 * "where does this code shape appear"; rewrite_pattern applies the codemods
 * agents would otherwise hand-roll with sed.
 */

const LANG_BY_EXT: Record<string, Lang> = {
	".ts": Lang.TypeScript,
	".mts": Lang.TypeScript,
	".cts": Lang.TypeScript,
	".tsx": Lang.Tsx,
	".jsx": Lang.Tsx,
	".js": Lang.JavaScript,
	".mjs": Lang.JavaScript,
	".cjs": Lang.JavaScript,
};

function languageFor(filePath: string): Lang | undefined {
	const ext = filePath.slice(filePath.lastIndexOf("."));
	return LANG_BY_EXT[ext.toLowerCase()];
}

/** The project files a pattern operation runs over. */
function targetFiles(project: Project, filePaths?: string[]): SourceFile[] {
	const files = project
		.getSourceFiles()
		.filter((sf) => languageFor(sf.getFilePath()) !== undefined);
	if (!filePaths || filePaths.length === 0) {
		return files;
	}
	const wanted = new Set(filePaths);
	return files.filter((sf) => wanted.has(sf.getFilePath()));
}

function findMatches(sourceFile: SourceFile, pattern: string): SgNode[] {
	const filePath = sourceFile.getFilePath();
	const lang = languageFor(filePath);
	if (lang === undefined) {
		return [];
	}
	try {
		return parse(lang, sourceFile.getFullText()).root().findAll(pattern);
	} catch {
		// A file tree-sitter cannot parse is skipped, not fatal.
		return [];
	}
}

export interface PatternMatch {
	filePath: string;
	line: number;
	column: number;
	text: string;
}

export interface SearchPatternResult {
	matches: PatternMatch[];
	totalCount: number;
	truncated: boolean;
	scannedFiles: number;
}

/** Finds every occurrence of an ast-grep pattern across the project files. */
export function searchPattern(
	project: Project,
	{
		pattern,
		filePaths,
		maxResults = 200,
	}: { pattern: string; filePaths?: string[]; maxResults?: number },
): SearchPatternResult {
	const files = targetFiles(project, filePaths);
	const matches: PatternMatch[] = [];
	let totalCount = 0;
	for (const sourceFile of files) {
		for (const node of findMatches(sourceFile, pattern)) {
			totalCount++;
			if (matches.length < maxResults) {
				const { start } = node.range();
				matches.push({
					filePath: sourceFile.getFilePath(),
					line: start.line + 1,
					column: start.column + 1,
					text: node.text(),
				});
			}
		}
	}
	return {
		matches,
		totalCount,
		truncated: totalCount > matches.length,
		scannedFiles: files.length,
	};
}

/**
 * Substitutes $VAR and $$$VARS metavariables from a match into the rewrite
 * template. Multi-matches are reconstructed from the original source span so
 * separators survive verbatim.
 */
function substitute(template: string, node: SgNode, source: string): string {
	return template
		.replace(/\$\$\$([A-Z_][A-Z0-9_]*)/g, (whole, name: string) => {
			const nodes = node.getMultipleMatches(name);
			if (nodes.length === 0) {
				return "";
			}
			const start = nodes[0].range().start.index;
			const end = nodes[nodes.length - 1].range().end.index;
			return source.slice(start, end);
		})
		.replace(/\$([A-Z_][A-Z0-9_]*)/g, (whole, name: string) => {
			const match = node.getMatch(name);
			return match ? match.text() : whole;
		});
}

export interface RewritePatternResult {
	changedFiles: string[];
	matchCount: number;
}

/**
 * Rewrites every occurrence of an ast-grep pattern using a template with
 * $VAR / $$$VARS metavariables. Writes through the ts-morph project so the
 * in-memory AST stays in sync with disk (batch cache safe).
 */
export async function rewritePattern(
	project: Project,
	{
		pattern,
		rewrite,
		filePaths,
		dryRun = false,
	}: {
		pattern: string;
		rewrite: string;
		filePaths?: string[];
		dryRun?: boolean;
	},
): Promise<RewritePatternResult> {
	const files = targetFiles(project, filePaths);
	let matchCount = 0;
	for (const sourceFile of files) {
		const filePath = sourceFile.getFilePath();
		const lang = languageFor(filePath);
		if (lang === undefined) {
			continue;
		}
		const source = sourceFile.getFullText();
		let root: ReturnType<typeof parse>;
		try {
			root = parse(lang, source);
		} catch {
			continue;
		}
		const nodes = root.root().findAll(pattern);
		if (nodes.length === 0) {
			continue;
		}
		matchCount += nodes.length;
		const edits = nodes.map((node) =>
			node.replace(substitute(rewrite, node, source)),
		);
		const rewritten = root.root().commitEdits(edits);
		if (rewritten !== source) {
			sourceFile.replaceWithText(rewritten);
		}
	}
	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	if (!dryRun) {
		await saveProjectChanges(project);
	}
	return { changedFiles, matchCount };
}
