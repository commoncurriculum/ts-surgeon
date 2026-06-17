import {
	type Project,
	Node,
	type SourceFile,
	type ImportSpecifier,
	type ExportSpecifier,
	type ImportDeclaration,
	type ExportDeclaration,
} from "ts-morph";
import * as path from "node:path";
import { calculateRelativePath } from "../_utils/calculate-relative-path";
import logger from "../../utils/logger";
import { findDeclarationsReferencingFile } from "../_utils/find-declarations-to-update";

// Interface for helper function
interface TargetSpecifierInfo {
	specifier: ImportSpecifier | ExportSpecifier | undefined;
	isOnlySpecifier: boolean;
	isTypeOnlyImport: boolean; // only meaningful for import declarations
}

/**
 * Helper function that searches for a Specifier matching the given symbol name in an import/export
 * declaration, and returns it along with accompanying information (whether it is the only Specifier,
 * and whether it is type-only).
 */
function findTargetSpecifierInfo(
	declaration: ImportDeclaration | ExportDeclaration,
	symbolName: string,
): TargetSpecifierInfo {
	let specifier: ImportSpecifier | ExportSpecifier | undefined;
	let isOnlySpecifier = false;
	let isTypeOnlyImport = false;

	if (Node.isImportDeclaration(declaration)) {
		isTypeOnlyImport = declaration.isTypeOnly();
		const namedImports = declaration.getNamedImports();
		specifier = namedImports.find(
			(spec) =>
				spec.getNameNode().getText() === symbolName ||
				spec.getAliasNode()?.getText() === symbolName,
		);
		if (specifier && namedImports.length === 1) {
			isOnlySpecifier = true;
		}
	} else if (Node.isExportDeclaration(declaration)) {
		const namedExports = declaration.getNamedExports();
		specifier = namedExports.find(
			(spec) =>
				spec.getNameNode().getText() === symbolName ||
				spec.getAliasNode()?.getText() === symbolName,
		);
		if (
			specifier &&
			namedExports.length === 1 &&
			!declaration.isNamespaceExport()
		) {
			isOnlySpecifier = true;
		}
	}

	return { specifier, isOnlySpecifier, isTypeOnlyImport };
}

/**
 * Splits the declaration and adds a new import/export declaration for the specified symbol
 * pointing to the new path. Removes the original declaration if it becomes empty.
 */
function splitAndUpdateDeclaration(
	declaration: ImportDeclaration | ExportDeclaration,
	symbolSpecifier: ImportSpecifier | ExportSpecifier,
	sourceFile: SourceFile,
	newRelativePath: string,
	symbolName: string,
	isTypeOnlyImport: boolean,
	referencingFilePath: string,
): void {
	logger.trace(
		{
			file: referencingFilePath,
			symbol: symbolName,
			from: declaration.getModuleSpecifier()?.getLiteralText(),
			to: newRelativePath,
			kind: declaration.getKindName(),
			action: "Split Declaration",
		},
		"Splitting declaration for target symbol",
	);

	symbolSpecifier.remove();

	if (Node.isImportDeclaration(declaration)) {
		sourceFile.addImportDeclaration({
			moduleSpecifier: newRelativePath,
			namedImports: [symbolName],
			isTypeOnly: isTypeOnlyImport,
		});
	} else if (Node.isExportDeclaration(declaration)) {
		sourceFile.addExportDeclaration({
			moduleSpecifier: newRelativePath,
			namedExports: [symbolName],
		});
	}

	if (
		Node.isImportDeclaration(declaration) &&
		declaration.getNamedImports().length === 0
	) {
		declaration.remove();
		logger.trace(
			{ file: referencingFilePath },
			"Removed empty original import declaration after split.",
		);
	} else if (
		Node.isExportDeclaration(declaration) &&
		declaration.getNamedExports().length === 0 &&
		!declaration.isNamespaceExport()
	) {
		declaration.remove();
		logger.trace(
			{ file: referencingFilePath },
			"Removed empty original export declaration after split.",
		);
	}
}

/**
 * Among the import/export statements that reference the specified file path (oldFilePath),
 * updates the paths of those containing the specified symbol (symbolName) to reference
 * the new file path (newFilePath).
 * If a declaration contains multiple symbols, it is split.
 * Any errors encountered are re-thrown as-is.
 *
 * @param project ts-morph project instance.
 * @param oldFilePath Absolute path of the source file being moved from.
 * @param newFilePath Absolute path of the destination file being moved to.
 * @param symbolName Name of the symbol that was moved.
 * @throws Error - if the file is not found or an error occurs during AST manipulation
 */
export async function updateImportsInReferencingFiles(
	project: Project,
	oldFilePath: string,
	newFilePath: string,
	symbolName: string,
): Promise<void> {
	const oldSourceFile = project.getSourceFile(oldFilePath);
	if (!oldSourceFile) {
		throw new Error(`Source file not found at old path: ${oldFilePath}`);
	}

	const declarationsToUpdate =
		await findDeclarationsReferencingFile(oldSourceFile);
	logger.debug(
		{ count: declarationsToUpdate.length, oldFile: oldFilePath },
		"Found declarations potentially referencing the old file path.",
	);

	for (const {
		declaration,
		referencingFilePath,
		originalSpecifierText,
	} of declarationsToUpdate) {
		const moduleSpecifier = declaration.getModuleSpecifier();
		const sourceFile = declaration.getSourceFile();
		if (!moduleSpecifier || !sourceFile) continue;

		const {
			specifier: symbolSpecifier,
			isOnlySpecifier,
			isTypeOnlyImport,
		} = findTargetSpecifierInfo(declaration, symbolName);

		if (!symbolSpecifier) {
			logger.trace(
				{
					file: referencingFilePath,
					symbol: symbolName,
					kind: declaration.getKindName(),
				},
				"Declaration does not reference the target symbol (or is not a named import/export). Skipping.",
			);
			continue;
		}

		if (referencingFilePath === newFilePath) {
			logger.trace(
				{
					file: referencingFilePath,
					symbol: symbolName,
					kind: declaration.getKindName(),
					action: isOnlySpecifier ? "Remove Declaration" : "Remove Specifier",
				},
				"Removing import/export of moved symbol from its new file (self-reference prevention)",
			);
			if (isOnlySpecifier) {
				declaration.remove();
			} else {
				symbolSpecifier.remove();
			}
			continue;
		}

		const newRelativePath = calculateRelativePath(
			referencingFilePath,
			newFilePath,
			{
				removeExtensions: ![".js", ".jsx", ".json", ".mjs", ".cjs"].includes(
					path.extname(originalSpecifierText),
				),
				simplifyIndex: true,
			},
		);

		const currentSpecifier = moduleSpecifier.getLiteralText();

		if (isOnlySpecifier) {
			if (currentSpecifier !== newRelativePath) {
				logger.trace(
					{
						file: referencingFilePath,
						symbol: symbolName,
						from: currentSpecifier,
						to: newRelativePath,
						kind: declaration.getKindName(),
						action: "Update Path (Only Named Symbol)",
					},
					"Updating module specifier for single named import/export declaration",
				);
				moduleSpecifier.setLiteralValue(newRelativePath);
			}
		} else if (symbolSpecifier) {
			splitAndUpdateDeclaration(
				declaration,
				symbolSpecifier,
				sourceFile,
				newRelativePath,
				symbolName,
				isTypeOnlyImport,
				referencingFilePath,
			);
		}
	}
}
