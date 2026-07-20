import type {
	Statement,
	SourceFile,
	ImportSpecifier,
	Identifier,
	ImportDeclaration,
} from "ts-morph";
import { SyntaxKind, Node } from "ts-morph";
import type { NeededExternalImports } from "../types.js";
import logger from "../../utils/logger.js";

interface ImportSourceInfo {
	moduleSpecifier: string;
	importedName?: string; // Named import (original or alias), or 'default'. Undefined for namespace.
	isDefaultImport: boolean;
	isNamespaceImport: boolean;
	namespaceImportName?: string;
	originalImportDeclaration: ImportDeclaration;
}

// --- Extended return type for getImportDetailsFromDeclarationNode ---
type ImportDetailsResult =
	| {
			importDeclaration: ImportDeclaration;
			importSpecifierNode?: ImportSpecifier;
			isDefault: boolean;
			isNamespaceImport: false;
			namespaceImportName?: undefined; // Not needed for non-namespace imports
	  }
	| {
			importDeclaration: ImportDeclaration;
			importSpecifierNode?: undefined; // No specifier for namespace imports
			isDefault: false;
			isNamespaceImport: true;
			namespaceImportName: string;
	  };

/**
 * Helper function that checks whether a declaration node is import-related and returns its details.
 */
function getImportDetailsFromDeclarationNode(
	declarationNode: Node,
	originalSourceFile: SourceFile,
): ImportDetailsResult | undefined {
	// Updated return type
	let importDeclaration: ImportDeclaration | undefined;
	let importSpecifierNode: ImportSpecifier | undefined;
	let isDefault = false;
	let isNamespaceImport = false;
	let namespaceImportName: string | undefined;

	if (Node.isImportSpecifier(declarationNode)) {
		importSpecifierNode = declarationNode;
		importDeclaration = declarationNode.getImportDeclaration();
		isDefault = false;
	} else if (
		Node.isImportClause(declarationNode) &&
		declarationNode.getDefaultImport()
	) {
		importDeclaration = declarationNode.getParentIfKind(
			SyntaxKind.ImportDeclaration,
		);
		isDefault = true;
	} else if (Node.isNamespaceImport(declarationNode)) {
		isNamespaceImport = true;
		const importClause = declarationNode.getParentIfKind(
			SyntaxKind.ImportClause,
		);
		if (!importClause) {
			logger.error(
				"NamespaceImport detected, but its parent is not an ImportClause. AST structure might be unexpected.",
			);
			return undefined;
		}
		importDeclaration = importClause.getParentIfKind(
			SyntaxKind.ImportDeclaration,
		);
		namespaceImportName = declarationNode.getName();
	} else {
		// Not an import-related declaration node
		return undefined;
	}

	// Exclude if no import declaration was found, or if it doesn't belong to the original file
	if (
		!importDeclaration ||
		importDeclaration.getSourceFile() !== originalSourceFile
	) {
		return undefined;
	}

	return {
		importDeclaration,
		importSpecifierNode,
		isDefault,
		isNamespaceImport,
		namespaceImportName,
	} as ImportDetailsResult; // Type assertion to guarantee the return type
}

/**
 * Checks whether the given identifier corresponds to a symbol imported in the original file,
 * and if so, returns the import information.
 */
function findImportSourceForIdentifier(
	identifier: Identifier,
	originalSourceFile: SourceFile,
): ImportSourceInfo | undefined {
	const symbol = identifier.getSymbol();
	if (!symbol) {
		return undefined;
	}

	const declarations = symbol.getDeclarations();

	for (const declarationNode of declarations) {
		const importDetails = getImportDetailsFromDeclarationNode(
			declarationNode,
			originalSourceFile,
		);

		if (!importDetails) continue;

		// ImportDeclaration is required
		if (!importDetails.importDeclaration) continue;

		const { importDeclaration } = importDetails;
		const moduleSpecifier = importDeclaration.getModuleSpecifierValue();

		// Namespace import case
		if (importDetails.isNamespaceImport) {
			return {
				moduleSpecifier,
				isDefaultImport: false,
				isNamespaceImport: true,
				namespaceImportName: importDetails.namespaceImportName,
				originalImportDeclaration: importDeclaration,
			};
		}

		// Named or default import case
		let importedName: string | undefined;
		if (importDetails.isDefault) {
			importedName = "default";
		} else if (importDetails.importSpecifierNode) {
			const specifier = importDetails.importSpecifierNode;
			importedName = specifier.getAliasNode()?.getText() ?? specifier.getName();
		} else {
			logger.warn(
				`Unexpected state: Non-namespace and non-default import without specifier for ${identifier.getText()}`,
			);
			continue;
		}

		return {
			moduleSpecifier,
			importedName,
			isDefaultImport: importDetails.isDefault,
			isNamespaceImport: false,
			originalImportDeclaration: importDeclaration,
		};
	}

	return undefined;
}

// --- New helper function: update the neededImports map ---
function updateNeededImportsMap(
	neededImports: NeededExternalImports,
	importInfo: ImportSourceInfo,
): void {
	const { moduleSpecifier, originalImportDeclaration } = importInfo;

	// If the module path hasn't been recorded yet, create a new entry
	if (!neededImports.has(moduleSpecifier)) {
		neededImports.set(moduleSpecifier, {
			names: new Set(), // Set to store imported names (including 'default')
			declaration: originalImportDeclaration, // Original ImportDeclaration node
			// isNamespaceImport, namespaceImportName will be set later
		});
	}

	// Add the required import information for the relevant module
	const existingEntry = neededImports.get(moduleSpecifier);
	if (existingEntry) {
		if (importInfo.isNamespaceImport) {
			// Namespace import case
			existingEntry.isNamespaceImport = true;
			existingEntry.namespaceImportName = importInfo.namespaceImportName;
		} else if (importInfo.importedName) {
			// Named or default import case (importedName should exist)
			existingEntry.names.add(importInfo.importedName);
		}
	}
}

/**
 * Receives an array of Statements and collects information about identifiers used within them
 * that were imported from outside in the original file (originalSourceFile).
 * The result is returned as a Map keyed by the module path of the import source.
 *
 * @param statements - Statements to process (the move target and its internal dependencies classified as moveToNewFile)
 * @param originalSourceFile - The file from which the symbol is being moved
 * @returns Map<import source module path, { Set of imported names (or 'default'), original ImportDeclaration }> (NeededExternalImports)
 */
export function collectNeededExternalImports(
	statements: Statement[],
	originalSourceFile: SourceFile,
): NeededExternalImports {
	const neededImports: NeededExternalImports = new Map();
	// Set to record already-processed Identifiers and prevent duplicate processing
	const processedIdentifiers = new Set<Identifier>();

	// Process each statement (the move target and its moveToNewFile dependencies) one by one
	for (const stmt of statements) {
		// Get all Identifiers (variable names, function names, etc.) within the statement
		const identifiers = stmt.getDescendantsOfKind(SyntaxKind.Identifier);

		// Check each Identifier
		for (const id of identifiers) {
			// Skip already-processed Identifiers
			if (processedIdentifiers.has(id)) continue;

			// Check whether this Identifier was imported from outside in the original file
			const importInfo = findImportSourceForIdentifier(id, originalSourceFile);

			if (importInfo) {
				updateNeededImportsMap(neededImports, importInfo);
			}
			processedIdentifiers.add(id);
		}
	}
	return neededImports;
}
