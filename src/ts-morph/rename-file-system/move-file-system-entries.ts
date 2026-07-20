import { performance } from "node:perf_hooks";
import type { Project } from "ts-morph";
import logger from "../../utils/logger.js";
import type { PathMapping, RenameOperation } from "../types.js";
import { withSkippedTsMorphReferenceUpdates } from "./_utils/skip-ts-morph-ref-update.js";

/**
 * The old implementation expanded all renames into per-file `sourceFile.move()` calls, but
 * ts-morph's API runs a "search the entire project for referencing literals and rewrite them"
 * step on every move. This explodes as N files × O(project), causing directory renames in
 * large monorepos to take over 6 minutes (measured: 369s for 34 files).
 *
 * Speed-up approach in this implementation:
 *  1. Directory renames are batched using `Directory.move()` (leveraging internal batch optimization)
 *  2. A monkey-patch is applied to no-op ts-morph's internal reference-update during that time.
 *     Updates remain the responsibility of the caller's `updateModuleSpecifiers` (eliminating double execution)
 *
 * Result: 369s → ~35s (approximately 10x faster); total: 379s → 44s (approximately 8.6x faster).
 *
 * Fallback: when `directoryExistsSync` returns false (e.g., in-memory FS tests),
 * `Directory.move()`'s queueMoveDirectory fails at flush time, so those directory renames
 * fall back to per-file move.
 */
export function moveFileSystemEntries(
	project: Project,
	renameOperations: RenameOperation[],
	directoryRenames: PathMapping[],
	signal?: AbortSignal,
) {
	const startTime = performance.now();
	signal?.throwIfAborted();
	const fs = project.getFileSystem();

	const filesCoveredByDirMove = new Set<string>();
	const dirRenamesViaBatch: PathMapping[] = [];

	for (const { oldPath, newPath } of directoryRenames) {
		const dir = project.getDirectory(oldPath);
		if (!dir) continue;
		if (fs.directoryExistsSync(oldPath)) {
			dirRenamesViaBatch.push({ oldPath, newPath });
			for (const sf of dir.getDescendantSourceFiles()) {
				filesCoveredByDirMove.add(sf.getFilePath());
			}
		}
	}

	logger.debug(
		{
			totalOperations: renameOperations.length,
			directoryRenameCount: directoryRenames.length,
			directoryBatchCount: dirRenamesViaBatch.length,
			filesCoveredByDirMove: filesCoveredByDirMove.size,
		},
		"Starting file system moves",
	);

	withSkippedTsMorphReferenceUpdates(project, () => {
		for (const { oldPath, newPath } of dirRenamesViaBatch) {
			signal?.throwIfAborted();
			const dir = project.getDirectory(oldPath);
			if (!dir) continue;
			try {
				dir.move(newPath);
			} catch (err) {
				logger.error(
					{ err, from: oldPath, to: newPath },
					"Error during directory.move()",
				);
				throw err;
			}
		}

		for (const { sourceFile, newPath, oldPath } of renameOperations) {
			signal?.throwIfAborted();
			if (filesCoveredByDirMove.has(oldPath)) continue;
			logger.trace({ from: oldPath, to: newPath }, "Moving file");
			try {
				sourceFile.move(newPath);
			} catch (err) {
				logger.error(
					{ err, from: oldPath, to: newPath },
					"Error during sourceFile.move()",
				);
				throw err;
			}
		}
	});

	const durationMs = (performance.now() - startTime).toFixed(2);
	logger.debug({ durationMs }, "Finished file system moves");
}
