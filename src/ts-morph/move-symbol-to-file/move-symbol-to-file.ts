import type { Project, SourceFile, Statement, SyntaxKind } from "ts-morph";
import { Node } from "ts-morph";
import logger from "../../utils/logger.js";
import type {
	DependencyClassification,
	NeededExternalImports,
} from "../types.js";
import { classifyDependencies } from "./classify-dependencies.js";
import { collectNeededExternalImports } from "./collect-external-imports.js";
import { ensureExportsInOriginalFile } from "./ensure-exports-in-original-file.js";
import { findTopLevelDeclarationByName } from "./find-declaration.js";
import {
	generateNewSourceFileContent,
	prepareDeclarationStrings,
} from "./generate-content/generate-new-source-file-content.js";
import { getInternalDependencies } from "./internal-dependencies.js";
import {
	addBackImportsToOriginalFile,
	collectSymbolsNeedingBackImport,
} from "./add-back-imports-to-original-file.js";
import { removeOriginalSymbol } from "./remove-original-symbol.js";
import { updateImportsInReferencingFiles } from "./update-imports-in-referencing-files.js";
import { updateTargetFile } from "./update-target-file.js";
import { calculateRequiredImportMap } from "./generate-content/build-new-file-import-section.js";

/**
 * Collects the information required to move a symbol.
 * Returns the original source file, the target declaration, classified dependencies, and external import info.
 */
async function gatherMovePrerequisites(
	project: Project,
	originalFilePath: string,
	symbolToMove: string,
	declarationKind?: SyntaxKind,
): Promise<{
	originalSourceFile: SourceFile;
	declaration: Statement;
	classifiedDependencies: DependencyClassification[];
	neededExternalImports: NeededExternalImports;
}> {
	const originalSourceFile = project.getSourceFile(originalFilePath);
	if (!originalSourceFile) {
		throw new Error(`Original source file not found: ${originalFilePath}`);
	}
	logger.debug(`Original file found: ${originalFilePath}`);

	const declaration = findTopLevelDeclarationByName(
		originalSourceFile,
		symbolToMove,
		declarationKind,
	);
	if (!declaration) {
		throw new Error(
			`Symbol "${symbolToMove}" not found in ${originalFilePath}`,
		);
	}
	logger.debug(`Symbol declaration found: ${symbolToMove}`);

	let isDefaultExported = false;
	if (
		Node.isFunctionDeclaration(declaration) ||
		Node.isClassDeclaration(declaration) ||
		Node.isInterfaceDeclaration(declaration) ||
		Node.isEnumDeclaration(declaration)
	) {
		isDefaultExported = declaration.isDefaultExport();
	}
	if (isDefaultExported) {
		throw new Error(
			"Default exports cannot be moved using this function. Please refactor manually or use file moving tools.",
		);
	}

	const internalDependencies = getInternalDependencies(declaration);
	logger.debug(`Found ${internalDependencies.length} internal dependencies.`);

	const classifiedDependencies = classifyDependencies(
		declaration,
		internalDependencies,
	);

	const allDepsToMove = [
		declaration,
		...classifiedDependencies.map((dep) => dep.statement),
	];
	const neededExternalImports = collectNeededExternalImports(
		allDepsToMove,
		originalSourceFile,
	);
	logger.debug(
		`Collected ${neededExternalImports.size} required external imports.`,
	);

	return {
		originalSourceFile,
		declaration,
		classifiedDependencies,
		neededExternalImports,
	};
}

/**
 * Updates import paths in referencing files, removes the symbol from the original file, and fixes imports in the original file.
 */
async function updateReferencesAndOriginalFile(
	project: Project,
	originalSourceFile: SourceFile,
	declaration: Statement,
	classifiedDependencies: DependencyClassification[],
	originalFilePath: string,
	newFilePath: string,
	symbolToMove: string,
): Promise<void> {
	await updateImportsInReferencingFiles(
		project,
		originalFilePath,
		newFilePath,
		symbolToMove,
	);
	logger.debug("Updated imports in referencing files.");

	const dependenciesToRemoveDeclarations = classifiedDependencies
		.filter(
			(
				dep: DependencyClassification,
			): dep is Extract<DependencyClassification, { type: "moveToNewFile" }> =>
				dep.type === "moveToNewFile",
		)
		.map((dep) => dep.statement);
	const allDeclarationsToRemove = [
		declaration,
		...dependenciesToRemoveDeclarations,
	];

	const symbolsNeedingBackImport = collectSymbolsNeedingBackImport(
		allDeclarationsToRemove,
	);

	removeOriginalSymbol(originalSourceFile, allDeclarationsToRemove);
	logger.debug("Removed symbol and its dependencies from the original file.");

	addBackImportsToOriginalFile(
		originalSourceFile,
		newFilePath,
		symbolsNeedingBackImport,
	);
	// addBackImports only adds missing imports. Removing imports that became unnecessary
	// after deletion is handled by organizeImports, which is required both for cleanliness and correctness.
	originalSourceFile.organizeImports();
	logger.debug("Organized imports in the original file.");
}

/**
 * Generates the content for the new file, then either creates it or appends to an existing file.
 */
function generateAndAppendToNewFile(
	project: Project,
	declaration: Statement,
	classifiedDependencies: DependencyClassification[],
	originalFilePath: string,
	newFilePath: string,
	neededExternalImports: NeededExternalImports,
): void {
	logger.debug(
		`Generate/Append symbol to file: ${newFilePath} (from ${originalFilePath})`,
	);

	const requiredImportMap = calculateRequiredImportMap(
		neededExternalImports,
		classifiedDependencies,
		newFilePath,
		originalFilePath,
	);

	const declarationStrings = prepareDeclarationStrings(
		declaration,
		classifiedDependencies,
	);

	const targetSourceFile = project.getSourceFile(newFilePath);

	if (targetSourceFile) {
		logger.debug(`Target file exists. Updating: ${newFilePath}`);
		updateTargetFile(targetSourceFile, requiredImportMap, declarationStrings);
		return;
	}

	logger.debug(`Target file does not exist. Creating: ${newFilePath}`);
	const newFileContent = generateNewSourceFileContent(
		declaration,
		classifiedDependencies,
		originalFilePath,
		newFilePath,
		neededExternalImports,
	);
	const newSourceFile = project.createSourceFile(newFilePath, newFileContent);
	newSourceFile.organizeImports();
}

/**
 * Moves the specified symbol from its current file to another file (creating it if it does not exist).
 * Helper functions return a value on success and throw an exception on failure.
 *
 * @param project ts-morph project instance
 * @param originalFilePath Absolute path to the source file
 * @param newFilePath Absolute path to the destination file
 * @param symbolToMove Name of the symbol to move
 * @param declarationKind Kind of the declaration to move (optional)
 * @returns Promise<void> A Promise that resolves when processing is complete
 * @throws Error - if the symbol is not found, is a default export, or an AST operation error occurs
 */
export async function moveSymbolToFile(
	project: Project,
	originalFilePath: string,
	newFilePath: string,
	symbolToMove: string,
	declarationKind?: SyntaxKind,
): Promise<void> {
	logger.debug(
		`moveSymbolToFile start: Symbol='${symbolToMove}', From='${originalFilePath}', To='${newFilePath}'`,
	);

	const {
		originalSourceFile,
		declaration,
		classifiedDependencies,
		neededExternalImports,
	} = await gatherMovePrerequisites(
		project,
		originalFilePath,
		symbolToMove,
		declarationKind,
	);

	ensureExportsInOriginalFile(classifiedDependencies, originalFilePath);

	generateAndAppendToNewFile(
		project,
		declaration,
		classifiedDependencies,
		originalFilePath,
		newFilePath,
		neededExternalImports,
	);

	await updateReferencesAndOriginalFile(
		project,
		originalSourceFile,
		declaration,
		classifiedDependencies,
		originalFilePath,
		newFilePath,
		symbolToMove,
	);

	logger.info(
		`Successfully moved symbol '${symbolToMove}' from '${originalFilePath}' to '${newFilePath}'.`,
	);
}
