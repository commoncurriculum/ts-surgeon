import type { Project } from "ts-morph";
import logger from "../../utils/logger";
import { resolveTargetFiles } from "../_utils/resolve-target-files";
import {
	getChangedFiles,
	initializeProject,
	saveProjectChanges,
} from "../_utils/ts-morph-project";
import type { OrganizeImportsParams, OrganizeImportsResult } from "./types";

/**
 * Runs the "Organize Imports" action (remove unused imports, sort, and coalesce
 * same-module imports) on the requested files — or the whole project — and saves
 * the result.
 *
 * Initializes a project from `tsconfigPath` and delegates to
 * `organizeImportsOnProject`. Use that function directly when you already have a
 * `Project` (e.g. in tests).
 */
export async function organizeImports(
	params: OrganizeImportsParams,
): Promise<OrganizeImportsResult> {
	const project = initializeProject(params.tsconfigPath);
	return organizeImportsOnProject(project, params);
}

/**
 * Internal API that organizes imports on an existing `Project`.
 */
export async function organizeImportsOnProject(
	project: Project,
	{ filePaths, dryRun = false }: Omit<OrganizeImportsParams, "tsconfigPath">,
): Promise<OrganizeImportsResult> {
	const targets = resolveTargetFiles(project, filePaths);
	logger.debug(
		{ targetCount: targets.length, dryRun },
		"organizeImports start",
	);

	for (const sourceFile of targets) {
		sourceFile.organizeImports();
	}

	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	logger.debug({ changedFiles }, "organizeImports apply complete");

	if (!dryRun) {
		await saveProjectChanges(project);
		logger.info(
			{ changedFileCount: changedFiles.length },
			"organizeImports saved",
		);
	}

	return { changedFiles, organizedFileCount: targets.length };
}
