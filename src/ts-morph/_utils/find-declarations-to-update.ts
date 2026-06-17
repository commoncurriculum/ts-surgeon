import type { SourceFile } from "ts-morph";
import type { DeclarationToUpdate } from "../types";
import { isPathAlias } from "./path-alias";
import { getTsConfigAliasKeys } from "./ts-morph-project";
import logger from "../../utils/logger";

/**
 * Searches for all Import/Export declarations that reference the target file.
 * Uses ts-morph's getReferencingSourceFiles.
 * Note: References via re-exports through barrel files (e.g. index.ts) may not be found.
 */
export async function findDeclarationsReferencingFile(
	targetFile: SourceFile,
	signal?: AbortSignal,
): Promise<DeclarationToUpdate[]> {
	signal?.throwIfAborted();
	const results: DeclarationToUpdate[] = [];
	const targetFilePath = targetFile.getFilePath();
	const project = targetFile.getProject();
	const aliasKeys = getTsConfigAliasKeys(project);

	logger.trace(
		{ targetFile: targetFilePath },
		"Starting findDeclarationsReferencingFile using getReferencingSourceFiles",
	);

	// Use the built-in ts-morph method to find referencing source files
	const referencingSourceFiles = targetFile.getReferencingSourceFiles();

	logger.trace(
		{ count: referencingSourceFiles.length },
		"Found referencing source files via ts-morph",
	);

	for (const referencingFile of referencingSourceFiles) {
		signal?.throwIfAborted();
		const referencingFilePath = referencingFile.getFilePath();
		// Intentional warn+continue to avoid halting the full reference scan due to a single file parse failure
		try {
			const declarations = [
				...referencingFile.getImportDeclarations(),
				...referencingFile.getExportDeclarations(),
			];

			for (const declaration of declarations) {
				signal?.throwIfAborted();
				const moduleSpecifier = declaration.getModuleSpecifier();
				if (!moduleSpecifier) continue;

				// Verify that the declaration actually resolves to the target file
				const specifierSourceFile = declaration.getModuleSpecifierSourceFile();
				if (specifierSourceFile?.getFilePath() !== targetFilePath) continue;

				const originalSpecifierText = moduleSpecifier.getLiteralText();
				if (!originalSpecifierText) continue;

				const wasPathAlias = isPathAlias(originalSpecifierText, aliasKeys);
				results.push({
					declaration,
					resolvedPath: targetFilePath,
					referencingFilePath,
					originalSpecifierText,
					wasPathAlias,
				});
			}
		} catch (err) {
			logger.warn(
				{ file: referencingFilePath, err },
				"Error processing referencing file",
			);
		}
	}

	logger.trace(
		{ foundCount: results.length },
		"Finished findDeclarationsReferencingFile",
	);
	return results;
}
