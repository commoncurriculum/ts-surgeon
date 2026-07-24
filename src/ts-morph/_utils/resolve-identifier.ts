import { type Identifier, type Node, type Project, SyntaxKind } from "ts-morph";

/**
 * Locating the Identifier a tool should operate on — by explicit position,
 * by declaration name, or both. Shared by rename_symbol, find_references,
 * change_signature, and get_type_at_position.
 */

/** Finds an Identifier node at the specified file and position (1-based). */
export function findIdentifierNode(
	project: Project,
	targetFilePath: string,
	position: { line: number; column: number },
): Identifier {
	const sourceFile = project.getSourceFile(targetFilePath);
	if (!sourceFile) throw new Error(`File not found: ${targetFilePath}`);

	let positionOffset: number;
	try {
		positionOffset = sourceFile.compilerNode.getPositionOfLineAndCharacter(
			position.line - 1,
			position.column - 1,
		);
	} catch (_error) {
		throw new Error(
			`The specified position (${position.line}:${position.column}) is out of range or invalid`,
		);
	}

	const node = sourceFile.getDescendantAtPos(positionOffset);

	if (!node) {
		throw new Error(
			`No node found at the specified position (${position.line}:${position.column})`,
		);
	}

	const identifier = node.asKind(SyntaxKind.Identifier);

	if (
		identifier &&
		identifier.getStart() <= positionOffset &&
		positionOffset < identifier.getEnd()
	) {
		return identifier;
	}

	throw new Error(
		`The node at the specified position (${position.line}:${position.column}) is not an Identifier`,
	);
}

/** Validates that an Identifier node matches the expected symbol name. */
export function validateSymbol(
	identifier: Identifier,
	expectedSymbolName: string,
): void {
	if (identifier.getText() === expectedSymbolName) {
		return;
	}
	throw new Error(
		`Symbol name mismatch (expected: ${expectedSymbolName}, actual: ${identifier.getText()})`,
	);
}

/**
 * Access syntax whose `getNameNode()` returns the identifier being *read*, not
 * a declared name: `styles.lessonTitle`, `Outer.Inner`. Without this, every
 * property read looks like a declaration — harmless while the property has a
 * resolvable symbol to dedupe on, but a CSS-module import (an index signature)
 * has none, so each read counted as its own declaration and the lookup
 * demanded a disambiguation that resolved to nothing.
 */
const ACCESS_EXPRESSION_PARENTS = new Set<SyntaxKind>([
	SyntaxKind.PropertyAccessExpression,
	SyntaxKind.QualifiedName,
]);

/** True when the identifier is the name node of its parent declaration. */
function isDeclarationName(identifier: Identifier): boolean {
	const parent = identifier.getParent();
	if (!parent) {
		return false;
	}
	if (ACCESS_EXPRESSION_PARENTS.has(parent.getKind())) {
		return false;
	}
	const getNameNode = (parent as { getNameNode?: () => unknown }).getNameNode;
	if (typeof getNameNode !== "function") {
		return false;
	}
	try {
		return getNameNode.call(parent) === identifier;
	} catch {
		return false;
	}
}

/**
 * The declaration a name ultimately stands for: itself for a primary
 * declaration, something else for the alias-like names TypeScript resolves
 * through — an object-literal key contextually typed by an interface, a
 * destructured binding, an overload signature. Grouping candidates by this
 * collapses those onto the one declaration a caller means, instead of
 * reporting each spelling as a rival declaration.
 */
function canonicalDeclaration(identifier: Identifier): Node {
	const fallback = identifier.getParent() ?? identifier;
	try {
		return identifier.getDefinitionNodes()[0] ?? fallback;
	} catch {
		return fallback;
	}
}

/**
 * One entry per declaration, represented by the name that declares it directly
 * when there is one: an interface's property beats the object literal that
 * fills it in, an implementation beats its overload signatures. Both resolvers
 * dedupe this way, so widening a search to the project and narrowing it to a
 * file agree on how many declarations exist.
 */
function dedupeByDeclaration(matches: Identifier[]): Identifier[] {
	const byDeclaration = new Map<Node, Identifier>();
	for (const match of matches) {
		const canonical = canonicalDeclaration(match);
		if (!byDeclaration.has(canonical) || match.getParent() === canonical) {
			byDeclaration.set(canonical, match);
		}
	}
	return [...byDeclaration.values()];
}

/**
 * Finds every declaration-name Identifier with the given text in a file
 * (function/class/interface/type/enum/variable/method/property/parameter
 * names — not usage sites).
 */
export function findDeclarationIdentifiersByName(
	project: Project,
	targetFilePath: string,
	symbolName: string,
): Identifier[] {
	const sourceFile = project.getSourceFile(targetFilePath);
	if (!sourceFile) throw new Error(`File not found: ${targetFilePath}`);
	return sourceFile
		.getDescendantsOfKind(SyntaxKind.Identifier)
		.filter((id) => id.getText() === symbolName && isDeclarationName(id));
}

/**
 * Declaration-name parents that are not what a project-wide lookup means:
 * parameters are purely local, and import/export specifiers re-declare a
 * symbol that is really declared elsewhere.
 */
const NON_PRIMARY_DECLARATION_PARENTS = new Set<SyntaxKind>([
	SyntaxKind.Parameter,
	SyntaxKind.ImportSpecifier,
	SyntaxKind.ImportClause,
	SyntaxKind.NamespaceImport,
	SyntaxKind.ImportEqualsDeclaration,
	SyntaxKind.ExportSpecifier,
]);

/**
 * Resolves a declaration by name across the whole project — no file needed.
 * Parameter names and import/export bindings are skipped, and multiple
 * declaration identifiers of one symbol (overloads, merged declarations)
 * count once. Throws when nothing is found or when several distinct symbols
 * share the name; the ambiguity error lists every candidate's
 * file:line:column.
 */
export function resolveProjectWideDeclaration(
	project: Project,
	symbolName: string,
): Identifier {
	const matches: Identifier[] = [];
	for (const sourceFile of project.getSourceFiles()) {
		if (sourceFile.isDeclarationFile() || sourceFile.isInNodeModules()) {
			continue;
		}
		if (!sourceFile.getFullText().includes(symbolName)) {
			continue;
		}
		for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
			const parentKind = id.getParent()?.getKind();
			if (
				id.getText() === symbolName &&
				isDeclarationName(id) &&
				parentKind !== undefined &&
				!NON_PRIMARY_DECLARATION_PARENTS.has(parentKind)
			) {
				matches.push(id);
			}
		}
	}
	const unique = dedupeByDeclaration(matches);
	if (unique.length === 1) {
		return unique[0];
	}
	if (unique.length === 0) {
		throw new Error(
			`No declaration named '${symbolName}' found in the project. Pass targetFilePath (and position if needed) to target a symbol this lookup cannot see.`,
		);
	}
	const locations = unique
		.map((match) => {
			const { line, column } = getIdentifierPosition(match);
			return `  - ${match.getSourceFile().getFilePath()}:${line}:${column}`;
		})
		.join("\n");
	throw new Error(
		`'${symbolName}' has ${unique.length} declarations in the project; pass targetFilePath (and position if needed) to disambiguate:\n${locations}`,
	);
}

/** The 1-based {line, column} of an identifier's start. */
export function getIdentifierPosition(identifier: Identifier): {
	line: number;
	column: number;
} {
	const { line, column } = identifier
		.getSourceFile()
		.getLineAndColumnAtPos(identifier.getStart());
	return { line, column };
}

/**
 * Resolves the target Identifier from whichever of position / symbolName the
 * caller has:
 * - position only → the identifier at that position
 * - position + symbolName → same, validated against the name
 * - symbolName only → the declaration with that name, which must be
 *   unambiguous in the file (the error lists every candidate otherwise)
 * - neither → error
 */
export function resolveTargetIdentifier(
	project: Project,
	targetFilePath: string,
	{
		position,
		symbolName,
	}: {
		position?: { line: number; column: number };
		symbolName?: string;
	},
): Identifier {
	if (position) {
		const identifier = findIdentifierNode(project, targetFilePath, position);
		if (symbolName !== undefined) {
			validateSymbol(identifier, symbolName);
		}
		return identifier;
	}
	if (symbolName === undefined) {
		throw new Error("Pass position {line, column}, symbolName, or both.");
	}
	const matches = dedupeByDeclaration(
		findDeclarationIdentifiersByName(project, targetFilePath, symbolName),
	);
	if (matches.length === 1) {
		return matches[0];
	}
	if (matches.length === 0) {
		throw new Error(
			`No declaration named '${symbolName}' found in ${targetFilePath}. Pass position {line, column} to target it explicitly.`,
		);
	}
	const locations = matches
		.map((match) => {
			const { line, column } = getIdentifierPosition(match);
			return `  - ${targetFilePath}:${line}:${column}`;
		})
		.join("\n");
	throw new Error(
		`'${symbolName}' has ${matches.length} declarations in ${targetFilePath}; disambiguate with position {line, column}:\n${locations}`,
	);
}
