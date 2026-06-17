import {
	type SourceFile,
	type Statement,
	type SyntaxKind,
	Node,
	type Identifier,
} from "ts-morph";

/**
 * Finds the first top-level declaration in a SourceFile that matches the given name and (optionally) kind.
 *
 * If multiple declarations with the same name exist (e.g., a type and a value, or function overloads),
 * the one that appears first in the file is returned.
 * If a VariableStatement contains multiple VariableDeclarations, the first VariableStatement
 * that contains a Declaration matching the given name is returned.
 */
export function findTopLevelDeclarationByName(
	sourceFile: SourceFile,
	name: string,
	kind?: SyntaxKind,
): Statement | undefined {
	const allStatements = sourceFile.getStatements();

	for (const statement of allStatements) {
		const currentKind = statement.getKind();

		if (kind !== undefined && currentKind !== kind) {
			continue;
		}

		let foundMatch = false;

		if (Node.isVariableStatement(statement)) {
			// Check each inner declaration for cases like `const a = 1, b = 2;`
			for (const varDecl of statement.getDeclarations()) {
				if (varDecl.getName() === name) {
					foundMatch = true;
					break;
				}
			}
		} else {
			const identifier = getIdentifierFromDeclaration(statement);
			if (identifier?.getText() === name) {
				foundMatch = true;
			}
		}

		if (foundMatch) {
			return statement;
		}
	}

	return undefined;
}

export function getIdentifierFromDeclaration(
	declaration: Statement | undefined,
): Identifier | undefined {
	if (!declaration) {
		return undefined;
	}

	if (
		Node.isFunctionDeclaration(declaration) ||
		Node.isClassDeclaration(declaration) ||
		Node.isInterfaceDeclaration(declaration) ||
		Node.isTypeAliasDeclaration(declaration) ||
		Node.isEnumDeclaration(declaration)
	) {
		// Default-exported anonymous functions/classes may not have a getNameNode()
		if (declaration.isDefaultExport() && !declaration.getNameNode()) {
			return undefined;
		}
		return declaration.getNameNode();
	}

	if (Node.isVariableStatement(declaration)) {
		for (const varDecl of declaration.getDeclarations()) {
			const nameNode = varDecl.getNameNode();
			if (nameNode && Node.isIdentifier(nameNode)) {
				return nameNode;
			}
		}
	}

	if (Node.isExportAssignment(declaration)) {
		const expression = declaration.getExpression();
		if (Node.isIdentifier(expression)) {
			return expression;
		}
		return undefined;
	}

	return undefined;
}
