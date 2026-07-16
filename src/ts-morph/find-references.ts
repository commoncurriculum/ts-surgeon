import type { Node, SourceFile } from "ts-morph";
import { initializeProject } from "./_utils/ts-morph-project";
import { resolveTargetIdentifier } from "./_utils/resolve-identifier";

// --- Data Structure for Result ---

export interface ReferenceLocation {
	filePath: string;
	line: number;
	column: number;
	text: string;
}

// --- Main Function ---

/**
 * Searches the entire project for all references to a symbol, targeted either
 * by position or by (unambiguous) declaration name.
 */
export async function findSymbolReferences({
	tsconfigPath,
	targetFilePath,
	position,
	symbolName,
}: {
	tsconfigPath: string;
	targetFilePath: string;
	position?: { line: number; column: number };
	symbolName?: string;
}): Promise<{
	references: ReferenceLocation[];
	definition: ReferenceLocation | null;
}> {
	const project = initializeProject(tsconfigPath);

	// targetFilePath is expected to be an absolute path
	const identifierNode = resolveTargetIdentifier(project, targetFilePath, {
		position,
		symbolName,
	});

	// findReferencesAsNodes() may not include the definition site itself
	const referenceNodes: Node[] = identifierNode.findReferencesAsNodes();

	let definitionLocation: ReferenceLocation | null = null;
	const definitions = identifierNode.getDefinitionNodes();
	if (definitions.length > 0) {
		const defNode = definitions[0];
		const defSourceFile = defNode.getSourceFile();
		const defStartPos = defNode.getStart();
		const { line: defLine, column: defColumn } =
			defSourceFile.getLineAndColumnAtPos(defStartPos);
		const lineText = getLineText(defSourceFile, defLine);
		definitionLocation = {
			filePath: defSourceFile.getFilePath(),
			line: defLine,
			column: defColumn,
			text: lineText.trim(),
		};
	}

	const references: ReferenceLocation[] = [];
	for (const refNode of referenceNodes) {
		const refSourceFile = refNode.getSourceFile();
		const refStartPos = refNode.getStart();
		const { line: refLine, column: refColumn } =
			refSourceFile.getLineAndColumnAtPos(refStartPos);

		if (
			definitionLocation &&
			refLine !== undefined &&
			refColumn !== undefined &&
			refSourceFile.getFilePath() === definitionLocation.filePath &&
			refLine === definitionLocation.line &&
			refColumn === definitionLocation.column
		) {
			continue; // skip if this reference is at the same position as the definition
		}

		if (refLine === undefined || refColumn === undefined) continue;

		const filePath = refSourceFile.getFilePath();
		const lineText = getLineText(refSourceFile, refLine);

		references.push({
			filePath,
			line: refLine,
			column: refColumn,
			text: lineText.trim(),
		});
	}

	references.sort((a, b) => {
		if (a.filePath !== b.filePath) {
			return a.filePath.localeCompare(b.filePath);
		}
		return a.line - b.line;
	});

	return { references, definition: definitionLocation };
}

function getLineText(sourceFile: SourceFile, lineNumber: number): string {
	// Get the full text of the file and split by line, returning the requested line
	const lines = sourceFile.getFullText().split(/\r?\n/);
	// lineNumber is 1-based, so the index is lineNumber - 1
	if (lineNumber > 0 && lineNumber <= lines.length) {
		return lines[lineNumber - 1];
	}
	// If the line is not found, throw an error
	throw new Error(
		`Line ${lineNumber} not found in file ${sourceFile.getFilePath()}`,
	);
}
