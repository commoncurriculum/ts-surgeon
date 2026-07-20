import {
	type Diagnostic,
	DiagnosticCategory,
	type DiagnosticMessageChain,
	type Project,
} from "ts-morph";
import { initializeProject } from "../_utils/ts-morph-project.js";
import type {
	DiagnosticCategoryLabel,
	DiagnosticInfo,
	GetDiagnosticsParams,
	GetDiagnosticsResult,
} from "./types.js";

/**
 * Returns the TypeScript pre-emit diagnostics (syntactic + semantic type errors,
 * warnings, and suggestions) for the requested files — or the whole project —
 * using the same ts-morph project the refactoring tools operate on.
 *
 * Initializes a project from `tsconfigPath` and delegates to
 * `getDiagnosticsOnProject`. Use that function directly when you already have a
 * `Project` (e.g. in tests).
 */
export function getDiagnostics(
	params: GetDiagnosticsParams,
): GetDiagnosticsResult {
	const project = initializeProject(params.tsconfigPath);
	return getDiagnosticsOnProject(project, params);
}

/**
 * Internal API that computes diagnostics for an existing `Project`.
 */
export function getDiagnosticsOnProject(
	project: Project,
	{ filePaths, maxResults = 100 }: Omit<GetDiagnosticsParams, "tsconfigPath">,
): GetDiagnosticsResult {
	const raw = collectDiagnostics(project, filePaths);
	const all = raw.map(toDiagnosticInfo).sort(compareDiagnostics);

	const errorCount = all.filter((d) => d.category === "error").length;
	const warningCount = all.filter((d) => d.category === "warning").length;

	return {
		diagnostics: all.slice(0, maxResults),
		totalCount: all.length,
		errorCount,
		warningCount,
		truncated: all.length > maxResults,
	};
}

function collectDiagnostics(
	project: Project,
	filePaths: string[] | undefined,
): Diagnostic[] {
	if (!filePaths || filePaths.length === 0) {
		return project.getPreEmitDiagnostics();
	}
	return filePaths.flatMap((filePath) => {
		const sourceFile = project.getSourceFile(filePath);
		if (!sourceFile) throw new Error(`File not found: ${filePath}`);
		return sourceFile.getPreEmitDiagnostics();
	});
}

// Single source of truth: the tuple order is also the sort rank (most
// actionable first), and `CATEGORY_LABELS` maps the ts-morph enum onto it.
const CATEGORY_SORT_ORDER = [
	"error",
	"warning",
	"suggestion",
	"message",
] as const satisfies readonly DiagnosticCategoryLabel[];

const CATEGORY_LABELS: Record<DiagnosticCategory, DiagnosticCategoryLabel> = {
	[DiagnosticCategory.Error]: "error",
	[DiagnosticCategory.Warning]: "warning",
	[DiagnosticCategory.Suggestion]: "suggestion",
	[DiagnosticCategory.Message]: "message",
};

function toDiagnosticInfo(diagnostic: Diagnostic): DiagnosticInfo {
	const sourceFile = diagnostic.getSourceFile();
	const start = diagnostic.getStart();

	let line: number | undefined;
	let column: number | undefined;
	if (sourceFile && start !== undefined) {
		const pos = sourceFile.getLineAndColumnAtPos(start);
		line = pos.line;
		column = pos.column;
	}

	return {
		filePath: sourceFile?.getFilePath(),
		line,
		column,
		category: CATEGORY_LABELS[diagnostic.getCategory()],
		code: diagnostic.getCode(),
		message: flattenMessageText(diagnostic.getMessageText()),
	};
}

function flattenMessageText(
	messageText: string | DiagnosticMessageChain,
): string {
	if (typeof messageText === "string") return messageText;

	const parts: string[] = [];
	const walk = (chain: DiagnosticMessageChain): void => {
		parts.push(chain.getMessageText());
		for (const next of chain.getNext() ?? []) {
			walk(next);
		}
	};
	walk(messageText);
	return parts.join(" ");
}

function compareDiagnostics(a: DiagnosticInfo, b: DiagnosticInfo): number {
	const byCategory =
		CATEGORY_SORT_ORDER.indexOf(a.category) -
		CATEGORY_SORT_ORDER.indexOf(b.category);
	if (byCategory !== 0) return byCategory;
	const byFile = (a.filePath ?? "").localeCompare(b.filePath ?? "");
	if (byFile !== 0) return byFile;
	return (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0);
}
