import type {
	ExportDeclaration,
	ImportDeclaration,
	Project,
	SourceFile,
} from "ts-morph";

export interface ReferenceVisitor {
	/** Called for each import declaration that resolves to `target`. Returns the number of sites updated. */
	onImport?: (importDecl: ImportDeclaration) => number;
	/** Called for each re-export declaration (`... from`) that resolves to `target`. Returns the number of sites updated. */
	onReExport?: (exportDecl: ExportDeclaration) => number;
}

/**
 * Visits every import / re-export declaration across the project whose module
 * specifier resolves to `target` (the target file itself is skipped), and sums
 * the per-visit update counts.
 *
 * This is the shared scaffold for cross-file reference rewriting; the callbacks
 * own the direction-specific specifier mutations.
 */
export function forEachReferenceTo(
	project: Project,
	target: SourceFile,
	{ onImport, onReExport }: ReferenceVisitor,
): { updatedImportSites: number; updatedReExportSites: number } {
	let updatedImportSites = 0;
	let updatedReExportSites = 0;

	for (const sourceFile of project.getSourceFiles()) {
		if (sourceFile === target) continue;

		if (onImport) {
			for (const importDecl of sourceFile.getImportDeclarations()) {
				if (importDecl.getModuleSpecifierSourceFile() === target) {
					updatedImportSites += onImport(importDecl);
				}
			}
		}

		if (onReExport) {
			for (const exportDecl of sourceFile.getExportDeclarations()) {
				if (exportDecl.getModuleSpecifierSourceFile() === target) {
					updatedReExportSites += onReExport(exportDecl);
				}
			}
		}
	}

	return { updatedImportSites, updatedReExportSites };
}
