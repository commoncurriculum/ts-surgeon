import { Node, type Statement, type Identifier } from "ts-morph";

/**
 * Gets the primary Identifier node from a Statement (mainly declarations).
 * Based on the self-reference check logic in internal-dependencies.ts.
 */
export function getDeclarationIdentifier(
	statement: Statement,
): Identifier | undefined {
	let nameNode: Node | undefined;

	if (Node.isVariableStatement(statement)) {
		// For VariableStatement, look at the first VariableDeclaration
		nameNode = statement.getDeclarations()[0]?.getNameNode();
	} else if (
		Node.isFunctionDeclaration(statement) ||
		Node.isClassDeclaration(statement) ||
		Node.isInterfaceDeclaration(statement) ||
		Node.isTypeAliasDeclaration(statement) ||
		Node.isEnumDeclaration(statement)
	) {
		nameNode = statement.getNameNode();
	} else if (Node.isVariableDeclaration(statement)) {
		// When a VariableDeclaration itself is passed (uncommon)
		nameNode = statement.getNameNode();
	}
	// Other cases (EnumMember, Parameter, etc.) can be added as needed

	if (nameNode && Node.isIdentifier(nameNode)) {
		return nameNode;
	}

	return undefined;
}
