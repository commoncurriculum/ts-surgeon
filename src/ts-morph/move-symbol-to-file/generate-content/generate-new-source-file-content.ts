import type { Statement } from "ts-morph";
import { Node } from "ts-morph";
import logger from "../../../utils/logger.js";
import type {
	DependencyClassification,
	NeededExternalImports,
} from "../../types.js";
import {
	buildImportSectionStringFromMap,
	calculateRequiredImportMap,
} from "./build-new-file-import-section.js";

// --- Type definitions ---
// --- Internal helper functions ---

/**
 * Gets a Statement and returns it as a string, adding the export keyword if necessary.
 * If isInternalOnly is true, the export keyword is not added.
 */
function getPotentiallyExportedStatement(
	stmt: Statement,
	isInternalOnly: boolean,
): string {
	const stmtText = stmt.getText();
	if (Node.isExportable(stmt) && stmt.isDefaultExport()) {
		return stmtText;
	}
	if (isInternalOnly) {
		if (Node.isExportable(stmt) && stmt.isExported()) {
			return stmtText.replace(/^export\s+/, "");
		}
		return stmtText;
	}
	if (Node.isExportable(stmt) && !stmt.isExported()) {
		return `export ${stmtText}`;
	}
	return stmtText;
}

// --- Exported helper functions ---

/**
 * Generates an array of declaration strings (with appropriate export keywords) for the
 * target declaration and its accompanying internal dependencies (of type `moveToNewFile`).
 */
export function prepareDeclarationStrings(
	targetDeclaration: Statement,
	classifiedDependencies: DependencyClassification[],
): string[] {
	logger.debug("Generating declaration section strings...");
	const declarationStrings: string[] = [];

	for (const dep of classifiedDependencies) {
		if (dep.type === "moveToNewFile") {
			declarationStrings.push(
				getPotentiallyExportedStatement(dep.statement, true),
			);
		}
	}

	declarationStrings.push(
		getPotentiallyExportedStatement(targetDeclaration, false),
	);

	logger.debug(`Generated ${declarationStrings.length} declaration strings.`);
	return declarationStrings;
}

// --- Main function (for creating a new file) ---

/**
 * Generates the full content of a new file from the target declaration and its dependencies.
 *
 * @param targetDeclaration Statement of the symbol being moved
 * @param classifiedDependencies Array of classified internal dependencies
 * @param originalFilePath Absolute path of the original file
 * @param newFilePath Absolute path of the new file
 * @param neededExternalImports Pre-collected external import information
 * @returns Source code string for the new file
 */
export function generateNewSourceFileContent(
	targetDeclaration: Statement,
	classifiedDependencies: DependencyClassification[],
	originalFilePath: string,
	newFilePath: string,
	neededExternalImports: NeededExternalImports,
): string {
	logger.debug("Generating new source file content...");

	const importMap = calculateRequiredImportMap(
		neededExternalImports,
		classifiedDependencies,
		newFilePath,
		originalFilePath,
	);

	const importSection = buildImportSectionStringFromMap(importMap);

	const declarationStrings = prepareDeclarationStrings(
		targetDeclaration,
		classifiedDependencies,
	);
	const declarationSection = `${declarationStrings.join("\n\n")}\n`;

	const finalContent = `${importSection}${declarationSection}`;
	logger.debug("Final generated content length:", finalContent.length);

	return finalContent;
}
