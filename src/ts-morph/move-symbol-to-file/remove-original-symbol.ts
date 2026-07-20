import type { SourceFile, Statement } from "ts-morph";
import logger from "../../utils/logger.js";
import { getDeclarationIdentifier } from "./get-declaration-identifier.js";

/**
 * Removes the specified declaration nodes (Statements) from the source file.
 * If multiple declarations are provided, all of them are removed.
 *
 * @param sourceFile - The target source file.
 * @param declarationsToRemove - Array of declaration nodes to remove.
 */
export function removeOriginalSymbol(
	sourceFile: SourceFile,
	declarationsToRemove: Statement[],
): void {
	if (declarationsToRemove.length === 0) {
		logger.warn("No declarations provided to removeOriginalSymbol.");
		return;
	}

	for (const declaration of declarationsToRemove) {
		const symbolIdentifier =
			getDeclarationIdentifier(declaration)?.getText() ?? "(unknown)";

		if (declaration.getParent() !== sourceFile) {
			logger.warn(
				{ symbol: symbolIdentifier, filePath: sourceFile.getFilePath() },
				"Attempted to remove a declaration that is not a direct child of the source file. Skipping.",
			);
			continue;
		}

		logger.trace({ symbol: symbolIdentifier }, "Removing declaration");
		declaration.remove();
	}
}
