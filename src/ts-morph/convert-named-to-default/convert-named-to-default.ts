import { Node, type Project, type SourceFile } from "ts-morph";
import logger from "../../utils/logger";
import {
	getChangedFiles,
	initializeProject,
	saveProjectChanges,
} from "../_utils/ts-morph-project";
import type {
	ConvertNamedExportToDefaultParams,
	ConvertNamedExportToDefaultResult,
} from "./types";

/**
 * Converts a file's named export into its default export and rewrites every
 * importing/re-exporting site across the project (named imports become default
 * imports; `export { name } from` becomes `export { default as name } from`).
 *
 * Initializes a project from `tsconfigPath` and delegates to
 * `convertNamedExportToDefaultOnProject`. Use that function directly when you
 * already have a `Project` (e.g. in tests).
 */
export async function convertNamedExportToDefault(
	params: ConvertNamedExportToDefaultParams,
): Promise<ConvertNamedExportToDefaultResult> {
	const project = initializeProject(params.tsconfigPath);
	return convertNamedExportToDefaultOnProject(project, params);
}

/**
 * Internal API that applies the conversion to an existing `Project`.
 */
export async function convertNamedExportToDefaultOnProject(
	project: Project,
	{
		targetFilePath,
		exportName,
		dryRun = false,
	}: Omit<ConvertNamedExportToDefaultParams, "tsconfigPath">,
): Promise<ConvertNamedExportToDefaultResult> {
	logger.debug(
		{ targetFilePath, exportName, dryRun },
		"convertNamedExportToDefault start",
	);

	const sourceFile = project.getSourceFile(targetFilePath);
	if (!sourceFile) throw new Error(`File not found: ${targetFilePath}`);

	convertTargetNamedExport(sourceFile, exportName);

	const { updatedImportSites, updatedReExportSites } = updateReferences(
		project,
		sourceFile,
		exportName,
	);

	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	logger.debug(
		{ updatedImportSites, updatedReExportSites, changedFiles },
		"convertNamedExportToDefault apply complete",
	);

	if (!dryRun) {
		await saveProjectChanges(project);
		logger.info(
			{ targetFilePath, exportName, changedFileCount: changedFiles.length },
			"convertNamedExportToDefault saved",
		);
	}

	return { changedFiles, updatedImportSites, updatedReExportSites };
}

function convertTargetNamedExport(
	sourceFile: SourceFile,
	exportName: string,
): void {
	if (sourceFile.getDefaultExportSymbol()) {
		throw new Error(
			`${sourceFile.getFilePath()} already has a default export; remove it before converting another export to default.`,
		);
	}

	const declarations = sourceFile.getExportedDeclarations().get(exportName);
	if (!declarations || declarations.length === 0) {
		throw new Error(
			`No exported declaration named '${exportName}' found in ${sourceFile.getFilePath()}.`,
		);
	}
	// A single exported name resolves to one value binding for the forms we
	// support; the interface/type guard below rejects type-side declarations.
	const declaration = declarations[0];

	if (declaration.getSourceFile() !== sourceFile) {
		throw new Error(
			`'${exportName}' is re-exported from another file; convert it in its source file instead.`,
		);
	}
	if (
		Node.isInterfaceDeclaration(declaration) ||
		Node.isTypeAliasDeclaration(declaration)
	) {
		throw new Error(
			`'${exportName}' is a type; a default export must be a value.`,
		);
	}

	// Strip the existing named export (inline `export` keyword or `export { }` specifier).
	removeNamedExport(sourceFile, declaration, exportName);

	// A named function/class declaration can carry `export default` directly.
	if (
		(Node.isFunctionDeclaration(declaration) ||
			Node.isClassDeclaration(declaration)) &&
		declaration.getName() === exportName
	) {
		declaration.setIsDefaultExport(true);
		return;
	}

	// Everything else (variables, enums, aliased re-exports) references the local
	// binding from a dedicated `export default <name>;` statement.
	sourceFile.addStatements(`export default ${getLocalName(declaration)};`);
}

function removeNamedExport(
	sourceFile: SourceFile,
	declaration: Node,
	exportName: string,
): void {
	// Variable declarations carry the `export` keyword on their VariableStatement,
	// and are not matched by `Node.isExportable`.
	if (Node.isVariableDeclaration(declaration)) {
		const statement = declaration.getVariableStatement();
		if (statement?.hasExportKeyword()) {
			if (statement.getDeclarations().length > 1) {
				throw new Error(
					`'${exportName}' is part of a multi-variable export statement; split it into its own statement before converting.`,
				);
			}
			statement.setIsExported(false);
			return;
		}
		removeExportSpecifier(sourceFile, exportName);
		return;
	}

	if (Node.isExportable(declaration) && declaration.hasExportKeyword()) {
		declaration.setIsExported(false);
		return;
	}
	removeExportSpecifier(sourceFile, exportName);
}

function removeExportSpecifier(
	sourceFile: SourceFile,
	exportName: string,
): void {
	for (const exportDecl of sourceFile.getExportDeclarations()) {
		// Only local `export { ... }` statements, not re-exports (`... from "x"`).
		if (exportDecl.getModuleSpecifier()) continue;
		for (const specifier of exportDecl.getNamedExports()) {
			const exportedAs =
				specifier.getAliasNode()?.getText() ?? specifier.getName();
			if (exportedAs !== exportName) continue;
			specifier.remove();
			if (exportDecl.getNamedExports().length === 0) exportDecl.remove();
			return;
		}
	}
	throw new Error(
		`Could not locate the export of '${exportName}' in ${sourceFile.getFilePath()} to convert.`,
	);
}

function getLocalName(declaration: Node): string {
	if (
		Node.isVariableDeclaration(declaration) ||
		Node.isFunctionDeclaration(declaration) ||
		Node.isClassDeclaration(declaration) ||
		Node.isEnumDeclaration(declaration)
	) {
		const name = declaration.getName();
		if (name) return name;
	}
	throw new Error(
		`Unsupported declaration kind (${declaration.getKindName()}) for default-export conversion.`,
	);
}

/**
 * Rewrites every named import and named re-export of `exportName` from
 * `targetSourceFile` across the project to reference the default export instead.
 */
function updateReferences(
	project: Project,
	targetSourceFile: SourceFile,
	exportName: string,
): { updatedImportSites: number; updatedReExportSites: number } {
	let updatedImportSites = 0;
	let updatedReExportSites = 0;

	for (const sourceFile of project.getSourceFiles()) {
		if (sourceFile === targetSourceFile) continue;

		// 1. Named imports: `import { name } from "target"` → default import.
		for (const importDecl of sourceFile.getImportDeclarations()) {
			if (importDecl.getModuleSpecifierSourceFile() !== targetSourceFile) {
				continue;
			}
			const named = importDecl
				.getNamedImports()
				.find((specifier) => specifier.getName() === exportName);
			if (!named) continue;

			// `setDefaultImport` rebuilds the import clause and drops a
			// statement-level `type` modifier, so preserve it explicitly.
			const wasTypeOnly = importDecl.isTypeOnly();
			const localName = named.getAliasNode()?.getText() ?? named.getName();
			named.remove();
			if (importDecl.getNamedImports().length === 0) {
				importDecl.removeNamedImports();
			}
			importDecl.setDefaultImport(localName);
			if (wasTypeOnly) importDecl.setIsTypeOnly(true);
			updatedImportSites++;
		}

		// 2. Re-exports: `export { name } from "target"` →
		//    `export { default as name } from "target"`.
		for (const exportDecl of sourceFile.getExportDeclarations()) {
			if (exportDecl.getModuleSpecifierSourceFile() !== targetSourceFile) {
				continue;
			}
			for (const specifier of exportDecl.getNamedExports()) {
				if (specifier.getName() !== exportName) continue;
				const externalName =
					specifier.getAliasNode()?.getText() ?? specifier.getName();
				// `setName("default")` would quote the reserved word; write the
				// specifier text directly to get a bare `default as <name>`.
				specifier.replaceWithText(`default as ${externalName}`);
				updatedReExportSites++;
			}
		}
	}

	return { updatedImportSites, updatedReExportSites };
}
