import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { Project } from "ts-morph";
import logger from "../../utils/logger.js";
import {
	getChangedFiles,
	getTsConfigAliasKeys,
	saveProjectChanges,
} from "../_utils/ts-morph-project.js";
import type {
	DeclarationToUpdate,
	PathMapping,
	RenameOperation,
} from "../types.js";
import { isPathAlias } from "../_utils/path-alias.js";
import { cleanupEmptyOldDirectories } from "./cleanup-empty-old-directories.js";
import { findDeclarationsForRenameOperation } from "./_utils/find-declarations-for-rename-operation.js";
import { moveFileSystemEntries } from "./move-file-system-entries.js";
import { prepareRenames } from "./prepare-renames.js";
import { updateModuleSpecifiers } from "./update-module-specifiers.js";

/**
 * [Experimental] Identifies all declarations that reference exported symbols of the files
 * being moved, and returns them as a deduplicated list of DeclarationToUpdate.
 */
async function findAllDeclarationsToUpdate(
	project: Project,
	renameOperations: RenameOperation[],
	signal?: AbortSignal,
): Promise<DeclarationToUpdate[]> {
	signal?.throwIfAborted();
	const startTime = performance.now();
	const allFoundDeclarationsMap = new Map<string, DeclarationToUpdate>();
	const aliasKeys = getTsConfigAliasKeys(project);

	logger.debug(
		{
			count: renameOperations.length,
			paths: renameOperations.map((op) => op.oldPath),
		},
		"[Experimental] Finding declarations referencing exported symbols of renamed items",
	);

	for (const renameOperation of renameOperations) {
		signal?.throwIfAborted();
		const { oldPath } = renameOperation;

		const declarationsFound = findDeclarationsForRenameOperation(
			renameOperation,
			signal,
		);

		for (const declaration of declarationsFound) {
			const referencingFilePath = declaration.getSourceFile().getFilePath();

			const mapKey = `${referencingFilePath}-${declaration.getPos()}-${declaration.getEnd()}`;
			if (allFoundDeclarationsMap.has(mapKey)) {
				continue;
			}

			const originalSpecifierText = declaration.getModuleSpecifierValue();
			if (!originalSpecifierText) continue;

			const wasPathAlias = isPathAlias(originalSpecifierText, aliasKeys);

			const importPath = declaration
				.getModuleSpecifierSourceFile()
				?.getFilePath();

			if (oldPath !== importPath) {
				// Skip if the file is not directly imported (e.g., re-exported via a barrel file)
				continue;
			}

			allFoundDeclarationsMap.set(mapKey, {
				declaration,
				resolvedPath: oldPath,
				referencingFilePath,
				originalSpecifierText,
				wasPathAlias,
			});
		}
	}

	const uniqueDeclarationsToUpdate = Array.from(
		allFoundDeclarationsMap.values(),
	);

	if (logger.isLevelEnabled("debug")) {
		const logData = uniqueDeclarationsToUpdate.map((decl) => ({
			referencingFile: decl.referencingFilePath,
			originalSpecifier: decl.originalSpecifierText,
			resolvedPath: decl.resolvedPath,
			kind: decl.declaration.getKindName(),
		}));
		const durationMs = (performance.now() - startTime).toFixed(2);
		logger.debug(
			{ declarationCount: uniqueDeclarationsToUpdate.length, durationMs },
			"[Experimental] Finished finding declarations to update via symbols",
		);
		if (uniqueDeclarationsToUpdate.length > 0) {
			logger.trace(
				{ declarations: logData },
				"Detailed declarations found via symbols",
			);
		}
	}

	return uniqueDeclarationsToUpdate;
}

/**
 * Renames one or more files or folders and updates all references in the project.
 *
 * @param project ts-morph project instance
 * @param renames Array of path pairs ({ oldPath: string, newPath: string }) to rename
 * @param dryRun If true, returns only the list of files that would be changed without saving to the file system
 * @param signal Optional AbortSignal that can be used to cancel the operation
 * @returns List of absolute paths of changed files
 * @throws If an error occurs during the rename process, or if cancelled via signal
 */
export async function renameFileSystemEntry({
	project,
	renames,
	dryRun = false,
	signal,
}: {
	project: Project;
	renames: PathMapping[];
	dryRun?: boolean;
	signal?: AbortSignal;
}): Promise<{ changedFiles: string[] }> {
	const mainStartTime = performance.now();
	const logProps = {
		renames: renames.map((r) => ({
			old: path.basename(r.oldPath),
			new: path.basename(r.newPath),
		})),
		dryRun,
	};
	logger.info({ props: logProps }, "renameFileSystemEntry started");

	let changedFilePaths: string[] = [];
	let errorOccurred = false;
	let errorMessage = "";

	try {
		signal?.throwIfAborted();

		const { operations: renameOperations, directoryRenames } = prepareRenames(
			project,
			renames,
			signal,
		);
		signal?.throwIfAborted();

		const allDeclarationsToUpdate = await findAllDeclarationsToUpdate(
			project,
			renameOperations,
			signal,
		);
		signal?.throwIfAborted();

		moveFileSystemEntries(project, renameOperations, directoryRenames, signal);
		signal?.throwIfAborted();

		updateModuleSpecifiers(allDeclarationsToUpdate, renameOperations, signal);

		const saveStart = performance.now();
		const changed = getChangedFiles(project);
		changedFilePaths = changed.map((f) => f.getFilePath());

		if (!dryRun && changed.length > 0) {
			signal?.throwIfAborted();
			await saveProjectChanges(project, signal);
			logger.debug(
				{
					count: changed.length,
					durationMs: (performance.now() - saveStart).toFixed(2),
				},
				"Saved project changes",
			);
			// Must wait until persistence to the FS is complete; otherwise the old directory
			// still holds pre-move files and readDirSync will not return empty
			cleanupEmptyOldDirectories(project, directoryRenames, signal);
		} else if (dryRun) {
			logger.info({ count: changed.length }, "Dry run: Skipping save");
		} else {
			logger.info("No changes detected to save");
		}
	} catch (error) {
		errorOccurred = true;
		errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(
			{ err: error, props: logProps },
			`Error during rename process: ${errorMessage}`,
		);
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
	} finally {
		const durationMs = (performance.now() - mainStartTime).toFixed(2);
		const status = errorOccurred ? "Failure" : "Success";
		logger.info(
			{ status, durationMs, changedFileCount: changedFilePaths.length },
			"renameFileSystemEntry finished",
		);
	}

	if (errorOccurred) {
		throw new Error(
			`Rename process failed: ${errorMessage}. See logs for details.`,
		);
	}

	return { changedFiles: changedFilePaths };
}
