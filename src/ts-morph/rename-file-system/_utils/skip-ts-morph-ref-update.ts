import type { Project, SourceFile } from "ts-morph";
import logger from "../../../utils/logger.js";

/**
 * In ts-morph (v25.x), `SourceFile.move()` / `Directory.move()` internally calls
 * `_updateReferencesForMoveInternal`, which searches the entire project for referencing
 * literals per moved file and rewrites module specifiers.
 *
 * In this repository, `updateModuleSpecifiers` already performs the same work, causing
 * double execution. Moreover, ts-morph's reference resolution runs per-file × O(project),
 * causing cascade slowdown — renaming a directory in a large monorepo (3000+ files) can
 * take over 6 minutes (measured: 369s for 34 files in src/types/).
 *
 * This util temporarily no-ops the reference-resolution pair on the SourceFile prototype
 * while move is executed. A try/finally block always restores the originals after fn returns.
 *
 * Notes:
 *  - This monkey-patches private API (`_underscore` members), so it depends on ts-morph 25.x.
 *    If the private names change in a future version, the patch will not apply and behavior
 *    will automatically fall back to the original (slower but correct) auto-ref-update path.
 *  - The patch **temporarily overwrites at the prototype level**, so other code in the same
 *    process that calls move() concurrently will also be affected. Serial execution is assumed.
 */
export function withSkippedTsMorphReferenceUpdates<T>(
	project: Project,
	fn: () => T,
): T {
	const proto = pickSourceFilePrototype(project);
	if (!proto) {
		logger.warn(
			"Could not locate SourceFile.prototype for skip-ref-update patch; falling back to default (slow) ts-morph behavior",
		);
		return fn();
	}

	const protoAny = proto as unknown as Record<string, unknown>;
	const originalGetRefs = protoAny._getReferencesForMoveInternal;
	const originalUpdateRefs = protoAny._updateReferencesForMoveInternal;

	if (
		typeof originalGetRefs !== "function" ||
		typeof originalUpdateRefs !== "function"
	) {
		logger.warn(
			{
				hasGetRefs: typeof originalGetRefs,
				hasUpdateRefs: typeof originalUpdateRefs,
			},
			"ts-morph internal reference-update API not found on SourceFile.prototype; skip patch (falling back to slow path)",
		);
		return fn();
	}

	protoAny._getReferencesForMoveInternal = () => ({
		literalReferences: [],
		referencingLiterals: [],
	});
	protoAny._updateReferencesForMoveInternal = () => {
		/* no-op: updateModuleSpecifiers handles the equivalent processing */
	};

	try {
		return fn();
	} finally {
		protoAny._getReferencesForMoveInternal = originalGetRefs;
		protoAny._updateReferencesForMoveInternal = originalUpdateRefs;
	}
}

/**
 * Retrieves one existing SourceFile from the Project and returns its prototype.
 * Returns undefined if the Project has no SourceFiles.
 */
function pickSourceFilePrototype(project: Project): object | undefined {
	const sourceFiles = project.getSourceFiles();
	if (sourceFiles.length === 0) return undefined;
	const sf: SourceFile = sourceFiles[0];
	return Object.getPrototypeOf(sf);
}
