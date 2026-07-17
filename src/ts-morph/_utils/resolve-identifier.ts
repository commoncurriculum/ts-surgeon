import { type Identifier, type Project, SyntaxKind } from "ts-morph";

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

/** True when the identifier is the name node of its parent declaration. */
function isDeclarationName(identifier: Identifier): boolean {
	const parent = identifier.getParent();
	if (!parent) {
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
	const matches = findDeclarationIdentifiersByName(
		project,
		targetFilePath,
		symbolName,
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
