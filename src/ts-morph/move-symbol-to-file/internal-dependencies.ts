import { SyntaxKind, type Statement, type Node } from "ts-morph";
import { getDeclarationIdentifier } from "./get-declaration-identifier.js";
import logger from "../../utils/logger.js";

/**
 * Finds the top-level Statement that contains the given node.
 * Returns the node itself if it is already a top-level Statement.
 * Returns undefined if none is found.
 */
function findContainingTopLevelStatement(
	node: Node,
	sourceFile: Node, // SourceFile is a subtype of Node
	isTopLevelStatementFn: (n: Node) => n is Statement,
): Statement | undefined {
	if (isTopLevelStatementFn(node)) {
		return node;
	}

	let current: Node | undefined = node;
	while (current && !isTopLevelStatementFn(current)) {
		current = current.getParent();
		if (!current || current === sourceFile) {
			// Stop searching when SourceFile is reached or there is no parent
			return undefined;
		}
	}
	// current should be a Statement satisfying isTopLevelStatementFn
	return current as Statement | undefined;
}

/**
 * Checks whether a declaration satisfies the conditions for an internal dependency,
 * and if so, returns the top-level Statement.
 */
function getValidTopLevelDependency(
	declaration: Node,
	sourceFile: Node,
	isTopLevelStatementFn: (n: Node) => n is Statement,
	targetDeclaration: Statement,
): Statement | undefined {
	logger.trace(
		`Checking declaration: ${declaration.getKindName()} starting with '${declaration
			.getText()
			.substring(0, 30)}...'`,
	);
	if (declaration.getSourceFile() !== sourceFile) {
		logger.trace("Skipping declaration from different source file.");
		return undefined;
	}

	const containingTopLevelStmt = findContainingTopLevelStatement(
		declaration,
		sourceFile,
		isTopLevelStatementFn,
	);
	logger.trace(
		`Containing top level statement: ${containingTopLevelStmt?.getKindName() ?? "None"}`,
	);

	// Guard Clauses
	if (!containingTopLevelStmt || containingTopLevelStmt === targetDeclaration) {
		return undefined;
	}

	const kind = containingTopLevelStmt.getKind();
	const isRelevantKind = [
		SyntaxKind.VariableStatement,
		SyntaxKind.FunctionDeclaration,
		SyntaxKind.ClassDeclaration,
		SyntaxKind.InterfaceDeclaration,
		SyntaxKind.TypeAliasDeclaration,
		SyntaxKind.EnumDeclaration,
	].includes(kind);

	if (!isRelevantKind) {
		logger.trace(
			`Skipping dependency of kind: ${containingTopLevelStmt.getKindName()}`,
		);
		return undefined;
	}

	return containingTopLevelStmt;
}

/**
 * Recursively searches for internal dependencies from the given node and adds them to the dependency set.
 */
function findDependenciesRecursive(
	currentNode: Statement, // Node from which to start the search (top-level Statement)
	dependencies: Set<Statement>, // Set to accumulate results
	visited: Set<Statement>, // Set to record already-visited nodes
	sourceFile: Node,
	isTopLevelStatementFn: (n: Node) => n is Statement,
	targetDeclaration: Statement, // The original move-target node
) {
	// Do not process if already visited (prevents circular references)
	if (visited.has(currentNode)) {
		return;
	}
	visited.add(currentNode);
	logger.trace(
		`Recursively finding dependencies for: ${currentNode.getKindName()} starting with '${currentNode
			.getText()
			.substring(0, 30)}...'`,
	);

	const identifiers = currentNode.getDescendantsOfKind(SyntaxKind.Identifier);
	const currentIdentifierNode = getDeclarationIdentifier(currentNode);

	for (const identifier of identifiers) {
		// Skip self-references and internal definitions (handle as needed during dependency traversal)
		if (currentIdentifierNode && identifier === currentIdentifierNode) {
			continue;
		}

		const symbol = identifier.getSymbol();
		if (!symbol) continue;

		const declarations = symbol.getDeclarations();
		for (const declaration of declarations) {
			const validDependency = getValidTopLevelDependency(
				declaration,
				sourceFile,
				isTopLevelStatementFn,
				targetDeclaration, // The original move target is the reference point for dependency evaluation
			);

			if (validDependency && !dependencies.has(validDependency)) {
				logger.trace(
					`Adding dependency: ${validDependency.getKindName()} starting with '${validDependency
						.getText()
						.substring(0, 30)}...'`,
				);
				dependencies.add(validDependency);
				// Recursively search the newly found dependency
				findDependenciesRecursive(
					validDependency,
					dependencies,
					visited,
					sourceFile,
					isTopLevelStatementFn,
					targetDeclaration,
				);
			}
		}
	}
}

/**
 * Identifies other top-level declaration nodes within the file that the given declaration node depends on
 * (including both direct and indirect dependencies).
 */
export function getInternalDependencies(
	targetDeclaration: Statement,
): Statement[] {
	logger.debug(
		`Getting internal dependencies for: ${targetDeclaration.getKindName()} starting with '${targetDeclaration
			.getText()
			.substring(0, 30)}...'`,
	);
	const dependencies = new Set<Statement>();
	const visited = new Set<Statement>();
	const sourceFile = targetDeclaration.getSourceFile();
	const allTopLevelStatements = sourceFile.getStatements();

	const isTopLevelStatement = (node: Node): node is Statement => {
		return (
			node.getParentIfKind(SyntaxKind.SourceFile) === sourceFile &&
			allTopLevelStatements.includes(node as Statement)
		);
	};

	// Start recursive search from targetDeclaration itself as the entry point
	findDependenciesRecursive(
		targetDeclaration,
		dependencies,
		visited,
		sourceFile,
		isTopLevelStatement,
		targetDeclaration,
	);

	logger.debug(
		`Found ${dependencies.size} internal dependencies (including indirect) for target declaration.`,
	);
	return Array.from(dependencies);
}
