import { type Project, SyntaxKind, type Identifier, type Node } from "ts-morph";
// Import shared functions
import {
	initializeProject,
	getChangedFiles,
	saveProjectChanges,
} from "../_utils/ts-morph-project";

// --- Helper Functions ---

/**
 * Finds an Identifier node at the specified file and position
 */
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
	} catch (error) {
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

/**
 * Validates that an Identifier node matches the expected symbol name (and parent node kind)
 */
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
 * Returns all reference locations for the given Identifier node
 * (note: the definition site may be included)
 * @param identifier The Identifier node whose references to search
 * @returns Array of reference Node objects
 */
export function findAllReferencesAsNodes(identifier: Identifier): Node[] {
	return identifier.findReferencesAsNodes();
}

/**
 * Renames the specified symbol across the entire project
 */
export async function renameSymbol({
	tsconfigPath,
	targetFilePath,
	position,
	symbolName,
	newName,
	dryRun = false,
}: {
	tsconfigPath: string;
	targetFilePath: string;
	position: { line: number; column: number };
	symbolName: string;
	newName: string;
	dryRun?: boolean;
}): Promise<{ changedFiles: string[] }> {
	const project = initializeProject(tsconfigPath);
	const identifierNode = findIdentifierNode(project, targetFilePath, position);
	validateSymbol(identifierNode, symbolName);
	identifierNode.rename(newName);

	const changedFiles = getChangedFiles(project);

	if (!dryRun) {
		await saveProjectChanges(project);
	}
	return { changedFiles: changedFiles.map((f) => f.getFilePath()) };
}
