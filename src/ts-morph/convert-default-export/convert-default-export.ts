import {
	type ClassDeclaration,
	type ExportAssignment,
	type ExportSpecifier,
	type FunctionDeclaration,
	type ImportDeclaration,
	Node,
	type Project,
	type SourceFile,
} from "ts-morph";
import logger from "../../utils/logger";
import {
	getChangedFiles,
	initializeProject,
	saveProjectChanges,
} from "../_utils/ts-morph-project";
import type {
	ConvertDefaultExportToNamedParams,
	ConvertDefaultExportToNamedResult,
} from "./types";

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Reserved words (plus strict-mode future-reserved words and `eval`/`arguments`)
// that cannot be used as a binding name in a module (modules are always strict).
const RESERVED_WORDS = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"implements",
	"interface",
	"let",
	"package",
	"private",
	"protected",
	"public",
	"static",
	"yield",
	"await",
	"eval",
	"arguments",
]);

function assertValidNewName(newName: string): void {
	if (!IDENTIFIER_RE.test(newName) || RESERVED_WORDS.has(newName)) {
		throw new Error(
			`Invalid newName: '${newName}' is not a usable identifier (reserved words and non-identifier text are rejected).`,
		);
	}
}

/**
 * Throws when the target file already exports a symbol named `name`, which would
 * make the conversion emit a duplicate/conflicting export.
 */
function assertExportNameAvailable(sourceFile: SourceFile, name: string): void {
	// The default export symbol is named "default", so it never collides here.
	const clash = sourceFile
		.getExportSymbols()
		.some((symbol) => symbol.getName() === name);
	if (clash) {
		throw new Error(
			`Cannot create a named export '${name}': ${sourceFile.getFilePath()} already exports a symbol with that name. Resolve the name clash first.`,
		);
	}
}

/**
 * Replaces `node` with `newText`, re-emitting any leading comments/JSDoc that
 * `replaceWithText` would otherwise drop (it replaces only the node's own range).
 */
function replacePreservingLeadingComments(
	node: ExportAssignment | FunctionDeclaration | ClassDeclaration,
	newText: string,
): void {
	const comments = node.getLeadingCommentRanges();
	if (comments.length === 0) {
		node.replaceWithText(newText);
		return;
	}
	const commentText = comments.map((comment) => comment.getText()).join("\n");
	node.replaceWithText(`${commentText}\n${newText}`);
}

/**
 * Converts a file's `export default` into a named export and rewrites every
 * importing/re-exporting site across the project.
 *
 * Initializes a project from `tsconfigPath` and delegates to
 * `convertDefaultExportToNamedOnProject`. Use that function directly when you
 * already have a `Project` (e.g. in tests).
 */
export async function convertDefaultExportToNamed(
	params: ConvertDefaultExportToNamedParams,
): Promise<ConvertDefaultExportToNamedResult> {
	const project = initializeProject(params.tsconfigPath);
	return convertDefaultExportToNamedOnProject(project, params);
}

/**
 * Internal API that applies the conversion to an existing `Project`.
 */
export async function convertDefaultExportToNamedOnProject(
	project: Project,
	{
		targetFilePath,
		newName,
		dryRun = false,
	}: Omit<ConvertDefaultExportToNamedParams, "tsconfigPath">,
): Promise<ConvertDefaultExportToNamedResult> {
	logger.debug(
		{ targetFilePath, newName, dryRun },
		"convertDefaultExportToNamed start",
	);

	const sourceFile = project.getSourceFile(targetFilePath);
	if (!sourceFile) throw new Error(`File not found: ${targetFilePath}`);

	if (newName !== undefined) assertValidNewName(newName);

	// Phase 1: convert the default export in the target file and learn its name.
	const exportName = convertTargetDefaultExport(sourceFile, newName);

	// Phase 2: rewrite default imports / default re-exports across the project.
	const { updatedImportSites, updatedReExportSites } = updateReferences(
		project,
		sourceFile,
		exportName,
	);

	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	logger.debug(
		{ exportName, updatedImportSites, updatedReExportSites, changedFiles },
		"convertDefaultExportToNamed apply complete",
	);

	if (!dryRun) {
		await saveProjectChanges(project);
		logger.info(
			{ targetFilePath, exportName, changedFileCount: changedFiles.length },
			"convertDefaultExportToNamed saved",
		);
	}

	return { changedFiles, exportName, updatedImportSites, updatedReExportSites };
}

/**
 * Converts the default export of `sourceFile` in place and returns the name of
 * the resulting named export. Throws for unsupported or anonymous-without-name
 * forms.
 */
function convertTargetDefaultExport(
	sourceFile: SourceFile,
	newName: string | undefined,
): string {
	const defaultSymbol = sourceFile.getDefaultExportSymbol();
	if (!defaultSymbol) {
		throw new Error(`No default export found in ${sourceFile.getFilePath()}`);
	}

	const declarations = defaultSymbol.getDeclarations();
	const declaration = declarations[0];
	if (!declaration) {
		throw new Error(
			`Could not resolve the default export declaration in ${sourceFile.getFilePath()}`,
		);
	}
	// More than one declaration means inline overloads or declaration merging
	// (e.g. function + namespace). Converting only the first would leave the file
	// still default-exporting with contradictory modifiers, so refuse instead of
	// silently emitting broken output.
	if (declarations.length > 1) {
		throw new Error(
			`The default export of ${sourceFile.getFilePath()} resolves to ${declarations.length} declarations (overloads or declaration merging); convert it manually.`,
		);
	}

	// `export default function foo() {}` / `export default class Foo {}`
	// (named or anonymous).
	if (
		Node.isFunctionDeclaration(declaration) ||
		Node.isClassDeclaration(declaration)
	) {
		return convertDeclaration(declaration, newName);
	}

	// `export default <expr>;`
	if (Node.isExportAssignment(declaration)) {
		return convertExportAssignment(declaration, newName);
	}

	// `export { foo as default };`
	if (Node.isExportSpecifier(declaration)) {
		return convertExportSpecifierDefault(declaration, newName);
	}

	throw new Error(
		`Unsupported default export form (${declaration.getKindName()}) in ${sourceFile.getFilePath()}`,
	);
}

function convertDeclaration(
	declaration: FunctionDeclaration | ClassDeclaration,
	newName: string | undefined,
): string {
	const currentName = declaration.getName();
	const sourceFile = declaration.getSourceFile();

	if (currentName) {
		if (newName !== undefined && newName !== currentName) {
			throw new Error(
				`The default export is already named '${currentName}'. Omit newName to keep it, or rename it first with rename_symbol_by_tsmorph (then convert).`,
			);
		}
		assertExportNameAvailable(sourceFile, currentName);
		// `removeDefaultExport` (triggered by setIsDefaultExport(false)) strips BOTH
		// `default` and `export`, so re-add `export` to keep it exported by name.
		declaration.setIsDefaultExport(false);
		declaration.setIsExported(true);
		return currentName;
	}

	// Anonymous function/class declaration: it needs a name to be a named export.
	if (newName === undefined) {
		throw new Error(
			"The default export is anonymous; provide newName for the resulting named export.",
		);
	}
	// An abstract class has no valid expression form, so the `const` rewrite below
	// would emit invalid TypeScript — require a named declaration instead.
	if (Node.isClassDeclaration(declaration) && declaration.isAbstract()) {
		throw new Error(
			"Cannot convert an anonymous abstract class default export; give the class a name first, then convert.",
		);
	}
	assertExportNameAvailable(sourceFile, newName);
	// Reinterpret the anonymous declaration as an initializer so we can bind a
	// name without fragile in-place name insertion (handles generics/`extends`).
	// `getText()` excludes leading comments/JSDoc, which we re-emit below.
	const fullText = declaration.getText();
	const initializer = fullText.replace(/^export\s+default\s+/, "");
	if (initializer === fullText) {
		throw new Error(
			`Unsupported anonymous default export form (${declaration.getKindName()}); declare it with a name first, then convert.`,
		);
	}
	replacePreservingLeadingComments(
		declaration,
		`export const ${newName} = ${initializer};`,
	);
	return newName;
}

function convertExportAssignment(
	exportAssignment: ExportAssignment,
	newName: string | undefined,
): string {
	if (exportAssignment.isExportEquals()) {
		throw new Error(
			"`export =` is a CommonJS export assignment, not a default export; not supported.",
		);
	}

	const sourceFile = exportAssignment.getSourceFile();
	const expression = exportAssignment.getExpression();

	// `export default foo;` — re-export the existing binding by name.
	if (Node.isIdentifier(expression)) {
		const localName = expression.getText();
		const finalName = newName ?? localName;
		assertExportNameAvailable(sourceFile, finalName);
		const specifier =
			finalName === localName ? localName : `${localName} as ${finalName}`;
		replacePreservingLeadingComments(
			exportAssignment,
			`export { ${specifier} };`,
		);
		return finalName;
	}

	// `export default <expr>;` (arrow function, object literal, call, literal, ...).
	if (newName === undefined) {
		throw new Error(
			"The default export is an anonymous expression; provide newName for the resulting named export.",
		);
	}
	assertExportNameAvailable(sourceFile, newName);
	replacePreservingLeadingComments(
		exportAssignment,
		`export const ${newName} = ${expression.getText()};`,
	);
	return newName;
}

function convertExportSpecifierDefault(
	specifier: ExportSpecifier,
	newName: string | undefined,
): string {
	// `export { foo as default }` → name node is `foo`, alias is `default`.
	const localName = specifier.getName();
	const finalName = newName ?? localName;
	assertExportNameAvailable(specifier.getSourceFile(), finalName);
	if (finalName === localName) {
		specifier.removeAlias();
	} else {
		specifier.setAlias(finalName);
	}
	return finalName;
}

/**
 * Rewrites every default import and default re-export of `targetSourceFile`
 * across the project to reference `exportName` instead.
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

		// 1. Imports of the default: `import Foo from "target"` and the
		//    named-specifier form `import { default as Foo } from "target"`.
		for (const importDecl of sourceFile.getImportDeclarations()) {
			if (importDecl.getModuleSpecifierSourceFile() !== targetSourceFile) {
				continue;
			}

			// (a) Default imported via a named specifier: `{ default as Foo }`.
			for (const named of importDecl.getNamedImports()) {
				if (named.getName() !== "default") continue;
				const alias = named.getAliasNode()?.getText();
				named.setName(exportName);
				// `{ default as Foo }` → `{ exportName as Foo }`; collapse a
				// redundant `{ exportName as exportName }` back to `{ exportName }`.
				if (alias === exportName) named.removeAlias();
				updatedImportSites++;
			}

			// (b) Default import clause: `import Foo from "target"`.
			const defaultImport = importDecl.getDefaultImport();
			if (defaultImport) {
				rewriteDefaultImport(importDecl, defaultImport.getText(), exportName);
				updatedImportSites++;
			}
		}

		// 2. Re-exports: `export { default } from "target"` /
		//    `export { default as X } from "target"`.
		for (const exportDecl of sourceFile.getExportDeclarations()) {
			if (exportDecl.getModuleSpecifierSourceFile() !== targetSourceFile) {
				continue;
			}
			for (const specifier of exportDecl.getNamedExports()) {
				if (specifier.getName() !== "default") continue;
				// Keeps any alias intact: `{ default as X }` → `{ exportName as X }`,
				// and `{ default }` → `{ exportName }`.
				specifier.setName(exportName);
				updatedReExportSites++;
			}
		}
	}

	return { updatedImportSites, updatedReExportSites };
}

function rewriteDefaultImport(
	importDecl: ImportDeclaration,
	localName: string,
	exportName: string,
): void {
	const namedImport =
		localName === exportName
			? { name: exportName }
			: { name: exportName, alias: localName };

	// A namespace import cannot share a declaration with named imports, so the
	// default must move into a separate named-import declaration.
	if (importDecl.getNamespaceImport()) {
		const sourceFile = importDecl.getSourceFile();
		const moduleSpecifier = importDecl.getModuleSpecifierValue();
		const isTypeOnly = importDecl.isTypeOnly();
		importDecl.removeDefaultImport();
		// Prefer merging into an existing named-import declaration for the same
		// module + type-only-ness; otherwise create a new declaration.
		const mergeTarget = sourceFile
			.getImportDeclarations()
			.find(
				(decl) =>
					decl !== importDecl &&
					decl.getModuleSpecifierValue() === moduleSpecifier &&
					decl.isTypeOnly() === isTypeOnly &&
					!decl.getNamespaceImport(),
			);
		if (mergeTarget) {
			addNamedImportIfAbsent(mergeTarget, namedImport);
		} else {
			sourceFile.addImportDeclaration({
				moduleSpecifier,
				namedImports: [namedImport],
				isTypeOnly,
			});
		}
		return;
	}

	importDecl.removeDefaultImport();
	addNamedImportIfAbsent(importDecl, namedImport);
}

/** Adds a named import unless an identical specifier (name + alias) is present. */
function addNamedImportIfAbsent(
	importDecl: ImportDeclaration,
	namedImport: { name: string; alias?: string },
): void {
	const exists = importDecl.getNamedImports().some((specifier) => {
		const alias = specifier.getAliasNode()?.getText();
		return (
			specifier.getName() === namedImport.name && alias === namedImport.alias
		);
	});
	if (!exists) importDecl.addNamedImport(namedImport);
}
