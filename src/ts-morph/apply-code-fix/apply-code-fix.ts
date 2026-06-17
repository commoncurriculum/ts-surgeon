import type { LanguageService, SourceFile } from "ts-morph";
import type { Project } from "ts-morph";
import logger from "../../utils/logger";
import { resolveTargetFiles } from "../_utils/resolve-target-files";
import {
	getChangedFiles,
	initializeProject,
	saveProjectChanges,
} from "../_utils/ts-morph-project";
import type {
	ApplyCodeFixParams,
	ApplyCodeFixResult,
	CodeFixName,
} from "./types";

/**
 * Friendly fix name → the TypeScript "fix all in file" combined-code-fix ids it
 * applies (in order). These ids are verified by the unit tests.
 */
const FIX_IDS: Record<CodeFixName, readonly string[]> = {
	remove_unused: ["unusedIdentifier_delete", "unusedIdentifier_deleteImports"],
	implement_interface: ["fixClassIncorrectlyImplementsInterface"],
	implement_abstract_members: [
		"fixClassDoesntImplementInheritedAbstractMember",
	],
	infer_types_from_usage: ["inferFromUsage"],
};

/**
 * Applies a TypeScript "fix all in file" code fix across the requested files —
 * or the whole project — and saves the result.
 *
 * Initializes a project from `tsconfigPath` and delegates to
 * `applyCodeFixOnProject`. Use that function directly when you already have a
 * `Project` (e.g. in tests).
 */
export async function applyCodeFix(
	params: ApplyCodeFixParams,
): Promise<ApplyCodeFixResult> {
	const project = initializeProject(params.tsconfigPath);
	return applyCodeFixOnProject(project, params);
}

/**
 * Internal API that applies a code fix on an existing `Project`.
 */
export async function applyCodeFixOnProject(
	project: Project,
	{ fix, filePaths, dryRun = false }: Omit<ApplyCodeFixParams, "tsconfigPath">,
): Promise<ApplyCodeFixResult> {
	const fixIds = FIX_IDS[fix];
	if (!fixIds) throw new Error(`Unknown fix: '${fix}'`);

	const targets = resolveTargetFiles(project, filePaths);
	logger.debug(
		{ fix, targetCount: targets.length, dryRun },
		"applyCodeFix start",
	);

	const languageService = project.getLanguageService();
	for (const sourceFile of targets) {
		applyFixIds(languageService, sourceFile, fixIds);
	}

	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	logger.debug({ changedFiles }, "applyCodeFix apply complete");

	if (!dryRun) {
		await saveProjectChanges(project);
		logger.info(
			{ fix, changedFileCount: changedFiles.length },
			"applyCodeFix saved",
		);
	}

	return { changedFiles, processedFileCount: targets.length };
}

function applyFixIds(
	languageService: LanguageService,
	sourceFile: SourceFile,
	fixIds: readonly string[],
): void {
	for (const fixId of fixIds) {
		try {
			languageService.getCombinedCodeFix(sourceFile, fixId).applyChanges();
		} catch (error) {
			// A fix id with no matching diagnostic in this file is a no-op; some
			// ids signal that by throwing, so swallow it.
			logger.debug(
				{ fixId, file: sourceFile.getFilePath(), err: error },
				"code fix not applicable",
			);
		}
	}
}
