import type { Identifier, Node } from "ts-morph";
import { resolveTargetIdentifier } from "../_utils/resolve-identifier";
import {
	initializeProject,
	getChangedFiles,
	saveProjectChanges,
} from "../_utils/ts-morph-project";

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
	position?: { line: number; column: number };
	symbolName: string;
	newName: string;
	dryRun?: boolean;
}): Promise<{ changedFiles: string[] }> {
	const project = initializeProject(tsconfigPath);
	const identifierNode = resolveTargetIdentifier(project, targetFilePath, {
		position,
		symbolName,
	});
	identifierNode.rename(newName);

	const changedFiles = getChangedFiles(project);

	if (!dryRun) {
		await saveProjectChanges(project);
	}
	return { changedFiles: changedFiles.map((f) => f.getFilePath()) };
}
