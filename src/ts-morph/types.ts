import type {
	SourceFile,
	ImportDeclaration,
	ExportDeclaration,
	Statement,
} from "ts-morph";

export type PathMapping = {
	oldPath: string;
	newPath: string;
};

/**
 * Represents a file or folder rename operation.
 * @property sourceFile - The target SourceFile instance (for file renames)
 * @property oldPath - The absolute path before renaming
 * @property newPath - The absolute path after renaming
 */
export type RenameOperation = {
	sourceFile: SourceFile;
	oldPath: string;
	newPath: string;
};

/**
 * Information about an import/export declaration that needs to be updated when a file is renamed or moved.
 * @property declaration - The target ImportDeclaration or ExportDeclaration node
 * @property resolvedPath - The absolute path of the file that the original import/export resolved to
 * @property referencingFilePath - The absolute path of the file containing this declaration
 * @property originalSpecifierText - The original module specifier text (e.g. './utils', '@/components')
 * @property wasPathAlias - Whether the original specifier was a path alias (optional)
 */
export interface DeclarationToUpdate {
	declaration: ImportDeclaration | ExportDeclaration;
	resolvedPath: string;
	referencingFilePath: string;
	originalSpecifierText: string;
	wasPathAlias?: boolean;
}

/**
 * Classification result for internal dependencies of a symbol being moved.
 */
export type DependencyClassification =
	// The dependency is also moved to the new file and used only internally (not exported)
	| { type: "moveToNewFile"; statement: Statement }
	// The dependency stays in the original file and will be imported from there by the new file
	| { type: "importFromOriginal"; statement: Statement; name: string }
	// The dependency stays in the original file but needs an export added so the new file can import it
	| { type: "addExport"; statement: Statement; name: string };

/**
 * Type alias for external import information passed to generateNewSourceFileContent
 */
export type NeededExternalImports = Map<
	string, // moduleSpecifier (computed relative path or original)
	{
		names: Set<string>; // named imports, default ('default'), or aliases
		declaration?: ImportDeclaration;
		isNamespaceImport?: boolean; // flag indicating a namespace import
		namespaceImportName?: string; // identifier for the namespace import (e.g. 'path')
	}
>;
