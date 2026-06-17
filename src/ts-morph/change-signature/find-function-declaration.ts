import { type Identifier, Node, type ParameteredNode } from "ts-morph";

/** A function-like node that has a parameter list */
export type FunctionLikeWithParameters = Node & ParameteredNode;

/**
 * Returns the function-like declaration (FunctionDeclaration / MethodDeclaration /
 * ArrowFunction / FunctionExpression / GetAccessor / SetAccessor) that the Identifier belongs to.
 */
export function findFunctionLikeDeclaration(
	identifier: Identifier,
): FunctionLikeWithParameters {
	const parent = identifier.getParent();
	if (!parent) {
		throw new Error("Identifier has no parent");
	}

	if (
		Node.isFunctionDeclaration(parent) &&
		parent.getNameNode() === identifier
	) {
		return parent;
	}
	if (Node.isMethodDeclaration(parent) && parent.getNameNode() === identifier) {
		return parent;
	}
	if (Node.isMethodSignature(parent) && parent.getNameNode() === identifier) {
		return parent;
	}
	if (
		Node.isGetAccessorDeclaration(parent) &&
		parent.getNameNode() === identifier
	) {
		return parent;
	}
	if (
		Node.isSetAccessorDeclaration(parent) &&
		parent.getNameNode() === identifier
	) {
		return parent;
	}
	if (
		Node.isFunctionExpression(parent) &&
		parent.getNameNode() === identifier
	) {
		return parent;
	}

	// const foo = () => {} / const foo = function() {}
	if (
		Node.isVariableDeclaration(parent) &&
		parent.getNameNode() === identifier
	) {
		const initializer = parent.getInitializer();
		if (
			initializer &&
			(Node.isArrowFunction(initializer) ||
				Node.isFunctionExpression(initializer))
		) {
			return initializer;
		}
	}

	// foo: () => {}  (property assignment in object literal)
	if (
		Node.isPropertyAssignment(parent) &&
		parent.getNameNode() === identifier
	) {
		const initializer = parent.getInitializer();
		if (
			initializer &&
			(Node.isArrowFunction(initializer) ||
				Node.isFunctionExpression(initializer))
		) {
			return initializer;
		}
	}

	const parentKind = parent.getKindName();
	throw new Error(
		`The symbol '${identifier.getText()}' at the specified position is not a function declaration/method/function expression (detected parent node kind: ${parentKind}). Constructors are not supported. Make sure you are not pointing at a parameter itself or an import site.`,
	);
}

/**
 * For overloaded functions/methods, returns all related declarations
 * (overload signatures + implementation). Otherwise returns just the received declaration.
 *
 * This prevents only one overload signature from being changed during `change_signature`,
 * which would cause type inconsistencies.
 */
export function getAllRelatedFunctionDeclarations(
	fn: FunctionLikeWithParameters,
): FunctionLikeWithParameters[] {
	if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
		const implementation = fn.isImplementation() ? fn : fn.getImplementation();
		if (implementation) {
			const overloads = implementation.getOverloads();
			if (overloads.length > 0) {
				return [...overloads, implementation];
			}
		}
		// Even without overloads, calling getOverloads() does not handle duplicate
		// MethodSignature definitions — that is an unsupported edge case.
	}
	return [fn];
}
