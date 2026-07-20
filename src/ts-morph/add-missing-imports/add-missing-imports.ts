import type { Project } from "ts-morph";
import logger from "../../utils/logger.js";
import { resolveTargetFiles } from "../_utils/resolve-target-files.js";
import {
	getChangedFiles,
	initializeProject,
	saveProjectChanges,
} from "../_utils/ts-morph-project.js";
import type {
	AddMissingImportsParams,
	AddMissingImportsResult,
} from "./types.js";

/**
 * Adds import statements for unresolved identifiers (the editor "Add all missing
 * imports" action) in the requested files — or the whole project — and saves the
 * result.
 *
 * Initializes a project from `tsconfigPath` and delegates to
 * `addMissingImportsOnProject`. Use that function directly when you already have
 * a `Project` (e.g. in tests).
 */
export async function addMissingImports(
	params: AddMissingImportsParams,
): Promise<AddMissingImportsResult> {
	const project = initializeProject(params.tsconfigPath);
	return addMissingImportsOnProject(project, params);
}

/**
 * Internal API that adds missing imports on an existing `Project`.
 */
export async function addMissingImportsOnProject(
	project: Project,
	{ filePaths, dryRun = false }: Omit<AddMissingImportsParams, "tsconfigPath">,
): Promise<AddMissingImportsResult> {
	const targets = resolveTargetFiles(project, filePaths);
	logger.debug(
		{ targetCount: targets.length, dryRun },
		"addMissingImports start",
	);

	for (const sourceFile of targets) {
		sourceFile.fixMissingImports();
	}

	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	logger.debug({ changedFiles }, "addMissingImports apply complete");

	if (!dryRun) {
		await saveProjectChanges(project);
		logger.info(
			{ changedFileCount: changedFiles.length },
			"addMissingImports saved",
		);
	}

	return { changedFiles, processedFileCount: targets.length };
}
