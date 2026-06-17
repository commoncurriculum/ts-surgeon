import type { SourceFile, ImportDeclarationStructure } from "ts-morph";
import { StructureKind } from "ts-morph";
import * as path from "node:path";
import logger from "../../utils/logger";
import type { ImportMap } from "./generate-content/build-new-file-import-section";

/**
 * Adds (merges) pre-computed import information and declaration strings into an existing SourceFile.
 *
 * @param targetSourceFile The SourceFile instance to modify
 * @param requiredImportMap Import information that needs to be added or merged
 * @param declarationStrings Array of declaration strings to add
 */
export function updateTargetFile(
	targetSourceFile: SourceFile,
	requiredImportMap: ImportMap,
	declarationStrings: string[],
): void {
	logger.debug(`Updating existing file: ${targetSourceFile.getFilePath()}`);
	const targetFilePath = targetSourceFile.getFilePath();

	// 1. Add/merge imports
	for (const [moduleSpecifier, importInfo] of requiredImportMap.entries()) {
		logger.debug(`Processing imports for module: ${moduleSpecifier}`);

		try {
			const absoluteImportPath = path.resolve(
				path.dirname(targetFilePath),
				moduleSpecifier,
			);
			if (absoluteImportPath === targetFilePath) {
				logger.debug(`Skipping self-referential import: ${moduleSpecifier}`);
				continue;
			}
		} catch (e) {
			logger.trace(
				`Could not resolve path for ${moduleSpecifier}, assuming not self-referential.`,
			);
		}

		const existingImportDecl = targetSourceFile.getImportDeclaration(
			(decl) => decl.getModuleSpecifierValue() === moduleSpecifier,
		);

		if (existingImportDecl) {
			// --- An existing import declaration exists ---
			logger.debug(`Found existing import for ${moduleSpecifier}. Merging...`);

			// Check for namespace import conflict
			const existingNamespaceImport = existingImportDecl.getNamespaceImport();
			if (importInfo.isNamespaceImport && !existingNamespaceImport) {
				logger.warn(
					`Cannot add namespace import for ${moduleSpecifier} because a non-namespace import already exists. Skipping namespace import.`, // Prefer existing named/default
				);
				continue; // Skip namespace import
			}
			if (!importInfo.isNamespaceImport && existingNamespaceImport) {
				logger.warn(
					`Cannot add named/default imports for ${moduleSpecifier} because a namespace import already exists. Skipping named/default imports.`, // Prefer existing namespace
				);
				continue; // Skip named/default imports
			}

			// Merge default import
			if (importInfo.defaultName && !existingImportDecl.getDefaultImport()) {
				logger.debug(`Adding default import: ${importInfo.defaultName}`);
				existingImportDecl.setDefaultImport(importInfo.defaultName);
			} else if (
				importInfo.defaultName &&
				existingImportDecl.getDefaultImport()?.getText() !==
					importInfo.defaultName
			) {
				// Warning when a different default import already exists
				logger.warn(
					`Existing default import ${existingImportDecl.getDefaultImport()?.getText()} differs from requested ${importInfo.defaultName} for ${moduleSpecifier}. Keeping the existing one.`, // Prefer existing
				);
			}

			// Merge named imports
			const existingNamedImports = new Set(
				existingImportDecl.getNamedImports().map((ni) => ni.getName()),
			);
			const namedImportsToAdd = [...importInfo.namedImports].filter(
				(name) => !existingNamedImports.has(name),
			);

			if (namedImportsToAdd.length > 0) {
				logger.debug(`Adding named imports: ${namedImportsToAdd.join(", ")}`);
				existingImportDecl.addNamedImports(namedImportsToAdd);
			}
		} else {
			// --- Adding a new import declaration ---
			logger.debug(
				`No existing import for ${moduleSpecifier}. Adding new declaration.`,
			);
			const importStructure: ImportDeclarationStructure = {
				kind: StructureKind.ImportDeclaration,
				moduleSpecifier: moduleSpecifier,
			};

			if (importInfo.isNamespaceImport && importInfo.namespaceImportName) {
				importStructure.namespaceImport = importInfo.namespaceImportName;
			} else {
				if (importInfo.defaultName) {
					importStructure.defaultImport = importInfo.defaultName;
				}
				if (importInfo.namedImports.size > 0) {
					importStructure.namedImports = [...importInfo.namedImports].sort();
				}
			}
			// If neither default nor named imports exist, becomes a side-effect import: import "module";
			targetSourceFile.addImportDeclaration(importStructure);
		}
	}

	// 2. Add declarations
	if (declarationStrings.length > 0) {
		logger.debug(`Adding ${declarationStrings.length} declaration statements.`);
		// Append to the end of the existing file, separated by a blank line
		targetSourceFile.addStatements(`\n${declarationStrings.join("\n\n")}`);
	} else {
		logger.debug("No declaration strings to add.");
	}

	// 3. Organize imports
	logger.debug("Organizing imports...");
	targetSourceFile.organizeImports();

	logger.debug(`File update complete: ${targetSourceFile.getFilePath()}`);
}
