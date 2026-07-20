import type { SourceFile, Statement } from "ts-morph";
import { calculateRelativePath } from "../_utils/calculate-relative-path.js";
import logger from "../../utils/logger.js";
import { getDeclarationIdentifier } from "./get-declaration-identifier.js";

/**
 * Among the declarations being removed as move targets, collects the names of symbols
 * that are still referenced by code remaining in the source file.
 *
 * Must be called before removal (while the declarations still exist for reference resolution).
 * The returned names are symbols that require a "back-import" from the destination file.
 */
export function collectSymbolsNeedingBackImport(
	declarationsToRemove: Statement[],
): string[] {
	if (declarationsToRemove.length === 0) {
		return [];
	}

	const sourceFile = declarationsToRemove[0].getSourceFile();
	const filePath = sourceFile.getFilePath();
	const removedRanges = declarationsToRemove.map(
		(decl) => [decl.getStart(), decl.getEnd()] as const,
	);

	const names: string[] = [];
	for (const declaration of declarationsToRemove) {
		const identifier = getDeclarationIdentifier(declaration);
		if (!identifier) {
			continue;
		}
		const name = identifier.getText();

		const referencedByRemainingCode = identifier
			.findReferencesAsNodes()
			.some((ref) => {
				if (ref.getSourceFile().getFilePath() !== filePath) {
					return false;
				}
				const pos = ref.getStart();
				const insideRemovedDeclaration = removedRanges.some(
					([start, end]) => pos >= start && pos < end,
				);
				return !insideRemovedDeclaration;
			});

		if (referencedByRemainingCode && !names.includes(name)) {
			names.push(name);
		}
	}

	return names;
}

/**
 * Adds an import declaration to the source file that imports the specified symbols
 * from the destination file. Merges with an existing import for the same module if present.
 *
 * ts-morph's `fixMissingImports()` performs text replacement via the language service,
 * which can cause AST inconsistencies ("children ... same count"), so the import is
 * added explicitly using the structural `addImportDeclaration`.
 */
export function addBackImportsToOriginalFile(
	originalSourceFile: SourceFile,
	newFilePath: string,
	names: string[],
): void {
	if (names.length === 0) {
		return;
	}

	const moduleSpecifier = calculateRelativePath(
		originalSourceFile.getFilePath(),
		newFilePath,
		{ removeExtensions: true, simplifyIndex: true },
	);

	const existing = originalSourceFile.getImportDeclaration(
		(decl) => decl.getModuleSpecifierValue() === moduleSpecifier,
	);

	if (existing) {
		const existingNames = new Set(
			existing.getNamedImports().map((spec) => spec.getNameNode().getText()),
		);
		for (const name of names) {
			if (!existingNames.has(name)) {
				existing.addNamedImport(name);
			}
		}
	} else {
		originalSourceFile.addImportDeclaration({
			moduleSpecifier,
			namedImports: names,
		});
	}

	logger.debug(
		{ names, moduleSpecifier, file: originalSourceFile.getFilePath() },
		"Added back-import to original file.",
	);
}
