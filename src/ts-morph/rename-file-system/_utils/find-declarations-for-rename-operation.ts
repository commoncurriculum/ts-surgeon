import type { ExportDeclaration, ImportDeclaration } from "ts-morph";
import logger from "../../../utils/logger.js";
import type { RenameOperation } from "../../types.js";
import { findReferencingDeclarationsForIdentifier } from "./find-referencing-declarations-for-identifier.js";
import { getIdentifierNodeFromDeclaration } from "./get-identifier-node-from-declaration.js";

export function findDeclarationsForRenameOperation(
	renameOperation: RenameOperation,
	signal?: AbortSignal,
): Set<ImportDeclaration | ExportDeclaration> {
	const { sourceFile } = renameOperation;
	const targetFilePath = sourceFile.getFilePath();
	const declarationsForThisOperation = new Set<
		ImportDeclaration | ExportDeclaration
	>();

	const exportSymbols = sourceFile.getExportSymbols();
	logger.trace(
		{ file: targetFilePath, count: exportSymbols.length },
		"Found export symbols for rename operation",
	);

	for (const symbol of exportSymbols) {
		signal?.throwIfAborted();
		const symbolDeclarations = symbol.getDeclarations();

		for (const symbolDeclaration of symbolDeclarations) {
			signal?.throwIfAborted();
			const identifierNode =
				getIdentifierNodeFromDeclaration(symbolDeclaration);

			if (!identifierNode) {
				continue;
			}

			const foundDecls = findReferencingDeclarationsForIdentifier(
				identifierNode,
				signal,
			);

			for (const decl of foundDecls) {
				declarationsForThisOperation.add(decl);
			}
		}
	}

	// Namespace imports (`import * as X from "..."` / `import type * as X from "..."`)
	// do not expose referenced symbol names in the import declaration, so they are
	// missed by the symbol → findReferencesAsNodes path. Supplement by directly
	// collecting declarations from referencing source files whose module specifier
	// resolves to the target file.
	const referencingFiles = sourceFile.getReferencingSourceFiles();
	for (const referencingFile of referencingFiles) {
		signal?.throwIfAborted();
		const declarations = [
			...referencingFile.getImportDeclarations(),
			...referencingFile.getExportDeclarations(),
		];
		for (const declaration of declarations) {
			signal?.throwIfAborted();
			if (!declaration.getModuleSpecifier()) continue;
			if (
				declaration.getModuleSpecifierSourceFile()?.getFilePath() !==
				targetFilePath
			) {
				continue;
			}
			declarationsForThisOperation.add(declaration);
		}
	}

	return declarationsForThisOperation;
}
