import {
	Node,
	type Project,
	type Statement,
	type VariableDeclaration,
} from "ts-morph";
import logger from "../../utils/logger.js";
import {
	findTopLevelDeclarationByName,
	getIdentifierFromDeclaration,
} from "../move-symbol-to-file/find-declaration.js";
import {
	getChangedFiles,
	initializeProject,
	saveProjectChanges,
} from "../_utils/ts-morph-project.js";
import type {
	BlockingReference,
	SafeDeleteSymbolParams,
	SafeDeleteSymbolResult,
} from "./types.js";

/** A node that will be removed: a whole statement, or one declarator of a multi-variable statement. */
type RemovalTarget = Statement | VariableDeclaration;

/**
 * Deletes a top-level symbol's declaration(s) only when it has no references
 * outside its own declaration; otherwise reports the blocking references and
 * leaves the file untouched.
 *
 * Initializes a project from `tsconfigPath` and delegates to
 * `safeDeleteSymbolOnProject`. Use that function directly when you already have
 * a `Project` (e.g. in tests).
 */
export async function safeDeleteSymbol(
	params: SafeDeleteSymbolParams,
): Promise<SafeDeleteSymbolResult> {
	const project = initializeProject(params.tsconfigPath);
	return safeDeleteSymbolOnProject(project, params);
}

/**
 * Internal API that runs the safe delete against an existing `Project`.
 */
export async function safeDeleteSymbolOnProject(
	project: Project,
	{
		targetFilePath,
		symbolName,
		dryRun = false,
	}: Omit<SafeDeleteSymbolParams, "tsconfigPath">,
): Promise<SafeDeleteSymbolResult> {
	const sourceFile = project.getSourceFile(targetFilePath);
	if (!sourceFile) throw new Error(`File not found: ${targetFilePath}`);

	const primary = findTopLevelDeclarationByName(sourceFile, symbolName);
	if (!primary) {
		throw new Error(
			`No top-level declaration named '${symbolName}' found in ${targetFilePath}.`,
		);
	}

	const nameNode = getNameNodeFor(primary, symbolName);
	if (!nameNode) {
		throw new Error(
			`Could not resolve an identifier for '${symbolName}' in ${targetFilePath}.`,
		);
	}
	const symbol = nameNode.getSymbol();

	// Every top-level declaration that resolves to the SAME symbol — i.e. a
	// function's overload signatures plus its implementation. Note: a declaration
	// *merge* across declaration spaces (e.g. `function Foo` + `type Foo`, or
	// `function Foo` + `namespace Foo`) surfaces as DISTINCT symbols in ts-morph,
	// so only one half matches here. Each half is therefore reference-checked and
	// deleted independently: we never remove the value half while a value
	// reference survives, nor the type half while a type reference survives.
	const removalTargets = sourceFile.getStatements().flatMap((statement) => {
		const id = getNameNodeFor(statement, symbolName);
		if (id === undefined || id.getSymbol() !== symbol) return [];
		return [resolveRemovalTarget(statement, symbolName)];
	});

	// A reference blocks deletion unless it sits inside something we are removing
	// (a declaration's own name, or a self-reference within its body). For an
	// overload group every signature resolves to one symbol, so references found
	// from the primary name node already cover the whole group.
	const blockers = nameNode
		.findReferencesAsNodes()
		.filter((ref) => !isWithinAny(ref, removalTargets));

	logger.debug(
		{
			symbolName,
			removalCount: removalTargets.length,
			blockers: blockers.length,
		},
		"safeDeleteSymbol classified references",
	);

	if (blockers.length > 0) {
		return {
			deleted: false,
			blockingReferences: blockers.map(toBlockingReference),
			changedFiles: [],
		};
	}

	for (const target of removalTargets) {
		target.remove();
	}

	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	if (!dryRun) {
		await saveProjectChanges(project);
		logger.info(
			{ symbolName, changedFileCount: changedFiles.length },
			"safeDeleteSymbol saved",
		);
	}

	return { deleted: true, blockingReferences: [], changedFiles };
}

/** Resolves the name identifier for `symbolName` in a statement (handling multi-variable statements). */
function getNameNodeFor(statement: Statement, symbolName: string) {
	if (Node.isVariableStatement(statement)) {
		const declaration = statement
			.getDeclarations()
			.find((d) => d.getName() === symbolName);
		const nameNode = declaration?.getNameNode();
		return nameNode && Node.isIdentifier(nameNode) ? nameNode : undefined;
	}
	return getIdentifierFromDeclaration(statement);
}

/** The node to remove: a single declarator when the statement declares several, otherwise the statement. */
function resolveRemovalTarget(
	statement: Statement,
	symbolName: string,
): RemovalTarget {
	if (Node.isVariableStatement(statement)) {
		const declarations = statement.getDeclarations();
		if (declarations.length > 1) {
			const match = declarations.find((d) => d.getName() === symbolName);
			if (match) return match;
		}
	}
	return statement;
}

function isWithinAny(ref: Node, targets: readonly RemovalTarget[]): boolean {
	const refFile = ref.getSourceFile();
	const start = ref.getStart();
	const end = ref.getEnd();
	return targets.some(
		(target) =>
			target.getSourceFile() === refFile &&
			start >= target.getStart() &&
			end <= target.getEnd(),
	);
}

function toBlockingReference(ref: Node): BlockingReference {
	const sourceFile = ref.getSourceFile();
	const { line, column } = sourceFile.getLineAndColumnAtPos(ref.getStart());
	const snippet = (ref.getParent() ?? ref)
		.getText()
		.replace(/\s+/g, " ")
		.trim();
	return {
		filePath: sourceFile.getFilePath(),
		line,
		column,
		text: snippet.length > 80 ? `${snippet.slice(0, 80)}…` : snippet,
	};
}
