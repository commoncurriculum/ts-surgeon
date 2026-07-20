import logger from "../../utils/logger.js";
import { calculateRelativePath } from "../_utils/calculate-relative-path.js";
import type { DeclarationToUpdate, RenameOperation } from "../types.js";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

const PRESERVE_EXTENSIONS = [".js", ".jsx", ".json", ".mjs", ".cjs"];

export function updateModuleSpecifiers(
	allDeclarationsToUpdate: DeclarationToUpdate[],
	renameOperations: RenameOperation[],
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const startTime = performance.now();
	const oldToNewPath = new Map(
		renameOperations.map((op) => [op.oldPath, op.newPath]),
	);
	logger.debug(
		{ count: allDeclarationsToUpdate.length },
		"Starting module specifier updates",
	);

	let updatedCount = 0;
	let skippedCount = 0;

	for (const {
		declaration,
		resolvedPath,
		referencingFilePath,
		originalSpecifierText,
		wasPathAlias,
	} of allDeclarationsToUpdate) {
		signal?.throwIfAborted();
		const moduleSpecifier = declaration.getModuleSpecifier();
		if (!moduleSpecifier) {
			skippedCount++;
			logger.trace(
				{ referencingFilePath, kind: declaration.getKindName() },
				"Skipping declaration with no module specifier",
			);
			continue;
		}

		const newReferencingFilePath =
			oldToNewPath.get(referencingFilePath) ?? referencingFilePath;
		const newResolvedPath = oldToNewPath.get(resolvedPath);

		if (!newResolvedPath) {
			skippedCount++;
			logger.warn(
				{ resolvedPath, referencingFilePath: newReferencingFilePath },
				"Could not determine new path for resolved path - Skipping update.",
			);
			continue;
		}

		// Determine whether the index filename was omitted in the original import style
		// (e.g. './utils', '../', '@/')
		const wasIndexSimplified =
			/(\/|\/[^/.]+)$/.test(originalSpecifierText) ||
			!path.extname(originalSpecifierText);

		// TODO: When wasPathAlias is true, recalculating the alias path from tsconfig paths/baseUrl
		// is not yet implemented. Currently falls back to a relative path.
		if (wasPathAlias) {
			logger.warn(
				{
					refFile: newReferencingFilePath,
					newResolved: newResolvedPath,
					originalSpecifier: originalSpecifierText,
				},
				"Path alias preservation not fully implemented yet. Calculating relative path as fallback.",
			);
		}

		const newSpecifier = calculateRelativePath(
			newReferencingFilePath,
			newResolvedPath,
			{
				removeExtensions: !PRESERVE_EXTENSIONS.includes(
					path.extname(originalSpecifierText),
				),
				simplifyIndex: wasIndexSimplified,
			},
		);

		try {
			declaration.setModuleSpecifier(newSpecifier);
			updatedCount++;
		} catch (err) {
			skippedCount++;
			logger.error(
				{
					err,
					refFile: newReferencingFilePath,
					newResolved: newResolvedPath,
					originalSpecifier: originalSpecifierText,
					wasPathAlias,
					newSpecifier,
				},
				"Error setting module specifier, skipping update",
			);
		}
	}

	const durationMs = (performance.now() - startTime).toFixed(2);
	logger.debug(
		{ updated: updatedCount, skipped: skippedCount, durationMs },
		"Finished module specifier updates",
	);
}
