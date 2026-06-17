import { type CallExpression, type Identifier, Node } from "ts-morph";

/**
 * Determines whether an Identifier is in the callee position of a call expression
 * and returns the corresponding CallExpression, or undefined if not applicable
 * (e.g. assignment target, type annotation, comment).
 *
 * Supported forms:
 *   foo()                       -> identifier 'foo' parent is CallExpression
 *   obj.foo()                   -> identifier 'foo' parent is PropertyAccess, whose parent is CallExpression
 *   obj?.foo()                  -> via PropertyAccess (optional chain)
 *   a.b.foo()                   -> walks up chained PropertyAccess
 */
export function getEnclosingCallExpression(
	identifier: Identifier,
): CallExpression | undefined {
	let current: Node = identifier;

	while (true) {
		const parent = current.getParent();
		if (!parent) return undefined;

		if (Node.isPropertyAccessExpression(parent)) {
			// If identifier is the property name (right-hand side), walk up into PropertyAccess
			if (parent.getNameNode() === current) {
				current = parent;
				continue;
			}
			return undefined;
		}

		if (Node.isCallExpression(parent)) {
			if (parent.getExpression() === current) {
				return parent;
			}
			return undefined;
		}

		return undefined;
	}
}

/**
 * Filters a set of reference Nodes to only those that are call expressions.
 */
export function filterCallSites(references: Node[]): CallExpression[] {
	const calls: CallExpression[] = [];
	for (const ref of references) {
		if (!Node.isIdentifier(ref)) continue;
		const call = getEnclosingCallExpression(ref);
		if (call) calls.push(call);
	}
	return calls;
}
