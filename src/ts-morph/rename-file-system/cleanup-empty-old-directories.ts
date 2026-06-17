import type { Project } from "ts-morph";
import logger from "../../utils/logger";
import type { PathMapping } from "../types";

/**
 * After a directory rename, clean up the old directory hierarchy that remains
 * once all files have been moved — working bottom-up (issue #27).
 *
 * sourceFile.move() does not clean up parent directories, so on the real FS
 * empty directories are left behind, and stale entries remain in the project's
 * Directory tracking.
 *
 * Safety rules:
 *  - Do not touch any directory that still has entries on the FS (protects untracked files)
 *  - Delete one level at a time. `Directory.delete()` recurses and would sweep up untracked files
 *  - If cleanup fails, do not fail the overall rename — just emit a warn log (treat as side-effect)
 */
export function cleanupEmptyOldDirectories(
	project: Project,
	directoryRenames: PathMapping[],
	signal?: AbortSignal,
): void {
	if (directoryRenames.length === 0) return;
	const fs = project.getFileSystem();

	for (const { oldPath } of directoryRenames) {
		signal?.throwIfAborted();
		const oldDir = project.getDirectory(oldPath);
		if (!oldDir) continue;

		// Sort deepest-first (children before parents); otherwise when checking a parent
		// the children have not been removed yet → entries still present → parent also survives
		const candidates = [oldDir, ...oldDir.getDescendantDirectories()].sort(
			(a, b) => b.getPath().length - a.getPath().length,
		);

		for (const dir of candidates) {
			signal?.throwIfAborted();
			const dirPath = dir.getPath();
			try {
				if (!fs.directoryExistsSync(dirPath)) {
					dir.forget();
					continue;
				}
				const entries = fs.readDirSync(dirPath);
				if (entries.length > 0) {
					// Untracked files or unexpected subdirectories are still present.
					// Stopping here automatically suppresses cascading deletion toward parent directories
					logger.trace(
						{ dirPath, remaining: entries.length },
						"Skipping cleanup: directory not empty (untracked content)",
					);
					continue;
				}
				fs.deleteSync(dirPath);
				dir.forget();
			} catch (err) {
				logger.warn({ err, dirPath }, "Failed to cleanup empty old directory");
			}
		}
	}
}
