import { Node } from "ts-morph";
import type { Identifier } from "ts-morph";

/**
 * Retrieves the primary name (identifier) node from various declaration node types
 * (variable declarations, function declarations, class declarations, default exports, etc.).
 *
 * For example, given `const foo = 1;`, returns the Identifier node for `foo`.
 * Given `export default myIdentifier;`, returns the Identifier node for `myIdentifier`.
 *
 * Returns undefined if no identifier is found (e.g., anonymous exports) or
 * if the declaration type is not supported.
 *
 * @param node - The target ts-morph declaration node (Node type).
 * @returns The identifier node (Identifier) or undefined.
 */
export function getIdentifierNodeFromDeclaration(
	node: Node,
): Identifier | undefined {
	// 1. Directly check the primary declaration types
	if (Node.isVariableDeclaration(node)) {
		// For VariableDeclaration, get the identifier via getNameNode()
		// e.g., const foo = ...; -> foo
		const nameNode = node.getNameNode();
		// Check because destructuring patterns yield non-Identifier name nodes
		if (Node.isIdentifier(nameNode)) {
			return nameNode;
		}
		return undefined;
	}
	if (Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node)) {
		// For function/class declarations, get the identifier via getNameNode()
		// e.g., function foo() {} -> foo, class Bar {} -> Bar
		// Returns undefined for anonymous functions/classes
		return node.getNameNode();
	}
	if (
		Node.isInterfaceDeclaration(node) ||
		Node.isTypeAliasDeclaration(node) ||
		Node.isEnumDeclaration(node)
	) {
		// For interface/type alias/enum declarations, get the identifier via getNameNode()
		return node.getNameNode();
	}

	// 2. Handle default exports (`export default ...`)
	if (Node.isExportAssignment(node)) {
		const expression = node.getExpression();
		// For the form `export default identifier;`
		if (Node.isIdentifier(expression)) {
			return expression;
		}
		// For the form `export default function foo() {}` or `export default class Bar {}`
		// (getNameNode() returns undefined for anonymous cases)
		if (
			Node.isFunctionDeclaration(expression) ||
			Node.isClassDeclaration(expression)
		) {
			return expression.getNameNode();
		}
		// For expressions without a direct identifier, such as `export default () => {}` or
		// `export default {}`, we cannot retrieve an identifier here
	}

	// 3. Fallback handling
	//    (handles rare cases where symbol.getDeclarations() directly returns an Identifier)
	if (Node.isIdentifier(node)) {
		return node;
	}

	// 4. Further fallback (potentially less stable)
	//    Try other node types that have a getNameNode() method, such as ExportSpecifier
	//    e.g., the aliasName in: export { originalName as aliasName };
	if ("getNameNode" in node && typeof node.getNameNode === "function") {
		const nameNode = node.getNameNode();
		if (Node.isIdentifier(nameNode)) {
			return nameNode;
		}
	}
	//    Get the name from a node that has getName() and search descendants for an Identifier with that name
	if ("getName" in node && typeof node.getName === "function") {
		const name = node.getName();
		if (typeof name === "string") {
			const identifier = node.getFirstDescendant(
				(descendant: Node) =>
					Node.isIdentifier(descendant) && descendant.getText() === name,
			);
			if (identifier && Node.isIdentifier(identifier)) return identifier;
		}
	}

	return undefined;
}
