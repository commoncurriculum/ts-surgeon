import type { Lang, SgNode } from "@ast-grep/napi";
import type { Project, SourceFile } from "ts-morph";
import { addMissingImportsOnProject } from "../ts-morph/add-missing-imports/add-missing-imports";
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

type AstGrepModule = typeof import("@ast-grep/napi");

export interface AstGrep {
	parse: AstGrepModule["parse"];
	langByExt: Record<string, Lang>;
}

let astGrep: AstGrep | undefined;

/**
 * Loads @ast-grep/napi on first use rather than at import time. The module is
 * a native (napi) binary: on a platform without a prebuilt build, a top-level
 * import would crash every command (list, guide, hook) through the registry's
 * import chain. Lazy loading degrades that to "the pattern tools error;
 * everything else works".
 */
export async function loadAstGrep(): Promise<AstGrep> {
	if (astGrep) {
		return astGrep;
	}
	let mod: AstGrepModule;
	try {
		mod = await import("@ast-grep/napi");
	} catch (error) {
		throw new Error(
			`The @ast-grep/napi native binary failed to load on this platform (${process.platform}-${process.arch}): ${
				error instanceof Error ? error.message : String(error)
			}. search_pattern and rewrite_pattern are unavailable here; every other ts-surgeon tool still works.`,
		);
	}
	const { Lang } = mod;
	astGrep = {
		parse: mod.parse,
		langByExt: {
			".ts": Lang.TypeScript,
			".mts": Lang.TypeScript,
			".cts": Lang.TypeScript,
			".tsx": Lang.Tsx,
			".jsx": Lang.Tsx,
			".js": Lang.JavaScript,
			".mjs": Lang.JavaScript,
			".cjs": Lang.JavaScript,
		},
	};
	return astGrep;
}

/**
 * Reports whether the @ast-grep/napi native binary loads on this platform
 * (used by `ts-surgeon doctor`). Never throws.
 */
export async function probeAstGrep(): Promise<
	{ ok: true } | { ok: false; error: string }
> {
	try {
		await loadAstGrep();
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function languageFor(ast: AstGrep, filePath: string): Lang | undefined {
	const ext = filePath.slice(filePath.lastIndexOf("."));
	return ast.langByExt[ext.toLowerCase()];
}

/** The project files a pattern operation runs over. */
export function targetFiles(
	ast: AstGrep,
	project: Project,
	filePaths?: string[],
): SourceFile[] {
	const files = project
		.getSourceFiles()
		.filter((sf) => languageFor(ast, sf.getFilePath()) !== undefined);
	if (!filePaths || filePaths.length === 0) {
		return files;
	}
	const wanted = new Set(filePaths);
	return files.filter((sf) => wanted.has(sf.getFilePath()));
}

function findMatches(
	ast: AstGrep,
	sourceFile: SourceFile,
	pattern: string,
): SgNode[] {
	const filePath = sourceFile.getFilePath();
	const lang = languageFor(ast, filePath);
	if (lang === undefined) {
		return [];
	}
	try {
		return ast.parse(lang, sourceFile.getFullText()).root().findAll(pattern);
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
export async function searchPattern(
	project: Project,
	{
		pattern,
		filePaths,
		maxResults = 200,
	}: { pattern: string; filePaths?: string[]; maxResults?: number },
): Promise<SearchPatternResult> {
	const ast = await loadAstGrep();
	const files = targetFiles(ast, project, filePaths);
	const matches: PatternMatch[] = [];
	let totalCount = 0;
	for (const sourceFile of files) {
		for (const node of findMatches(ast, sourceFile, pattern)) {
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
export function substitute(
	template: string,
	node: SgNode,
	source: string,
): string {
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
	/** Files the fixImports pass ran over (the rewrite-changed set). */
	importsFixedIn?: string[];
}

/**
 * Shared tail of the rewrite tools: optionally add missing imports for the
 * files the rewrite changed (within the same Project, so the batch cache
 * stays coherent), then save once unless dryRun. Only imports the language
 * service can resolve are added — the target module must already be in the
 * project graph.
 */
export async function finishRewrite(
	project: Project,
	{ dryRun, fixImports }: { dryRun: boolean; fixImports: boolean },
): Promise<{ changedFiles: string[]; importsFixedIn?: string[] }> {
	const rewriteChanged = getChangedFiles(project).map((sf) => sf.getFilePath());
	let importsFixedIn: string[] | undefined;
	if (fixImports && rewriteChanged.length > 0) {
		// dryRun:true here means "don't save yet" — the import mutations stay in
		// memory and are saved (or discarded) together with the rewrite below.
		await addMissingImportsOnProject(project, {
			filePaths: rewriteChanged,
			dryRun: true,
		});
		importsFixedIn = rewriteChanged;
	}
	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	if (!dryRun) {
		await saveProjectChanges(project);
	}
	return { changedFiles, importsFixedIn };
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
		fixImports = false,
	}: {
		pattern: string;
		rewrite: string;
		filePaths?: string[];
		dryRun?: boolean;
		fixImports?: boolean;
	},
): Promise<RewritePatternResult> {
	const ast = await loadAstGrep();
	const files = targetFiles(ast, project, filePaths);
	let matchCount = 0;
	for (const sourceFile of files) {
		const filePath = sourceFile.getFilePath();
		const lang = languageFor(ast, filePath);
		if (lang === undefined) {
			continue;
		}
		const source = sourceFile.getFullText();
		let root: ReturnType<AstGrepModule["parse"]>;
		try {
			root = ast.parse(lang, source);
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
	const { changedFiles, importsFixedIn } = await finishRewrite(project, {
		dryRun,
		fixImports,
	});
	return { changedFiles, matchCount, importsFixedIn };
}
