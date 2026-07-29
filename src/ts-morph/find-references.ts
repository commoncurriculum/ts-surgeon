import type { Identifier, Node, SourceFile } from "ts-morph";
import { initializeProject } from "./_utils/ts-morph-project.js";
import {
	resolveProjectWideDeclarationCandidates,
	resolveTargetIdentifierCandidates,
} from "./_utils/resolve-identifier.js";

// --- Data Structure for Result ---

export interface ReferenceLocation {
	filePath: string;
	line: number;
	column: number;
	text: string;
}

/** What one declaration of the requested name resolves to. */
export interface DeclarationReferences {
	symbolName: string;
	definition: ReferenceLocation | null;
	references: ReferenceLocation[];
}

// --- Main Function ---

/**
 * Searches the entire project for all references to a symbol, targeted either
 * by position, by declaration name within a file, or — when no targetFilePath
 * is given — by declaration name project-wide.
 *
 * A name matching several declarations returns ALL of them rather than raising
 * an ambiguity error. This is a read-only lookup: it already knows every
 * candidate position by the time it could complain, and erroring out costs the
 * caller another process start and another full project parse to learn what
 * this call could simply have reported (defect report, 2026-07-29).
 *
 * Reference resolution is capped, though. Each declaration costs a full
 * type-checker search, so a name like `render` with thirty declarations would
 * turn a lookup that used to fail instantly into a very long one. Past the cap
 * the remaining declarations come back as positions only, labelled as such —
 * the caller can then aim at one with `position`.
 */
const MAX_SEARCHED_DECLARATIONS = 5;

export async function findSymbolReferences({
	tsconfigPath,
	targetFilePath,
	position,
	symbolName,
	maxDeclarations = MAX_SEARCHED_DECLARATIONS,
}: {
	tsconfigPath: string;
	targetFilePath?: string;
	position?: { line: number; column: number };
	symbolName?: string;
	maxDeclarations?: number;
}): Promise<{
	declarations: DeclarationReferences[];
	/** Declarations found but not searched, because the cap was reached. */
	unsearchedDeclarations: ReferenceLocation[];
}> {
	// Not reachable from the CLI (the tool schema does not expose it), but a
	// caller passing 0 or a fraction would get an empty `declarations` while
	// still being told there are unsearched ones — and every consumer reads
	// declarations[0]. Clamp rather than trust.
	const cap = Math.max(1, Math.floor(maxDeclarations));
	const project = initializeProject(tsconfigPath);

	// targetFilePath (when given) is expected to be an absolute path
	let identifierNodes: Identifier[];
	if (targetFilePath !== undefined) {
		identifierNodes = resolveTargetIdentifierCandidates(
			project,
			targetFilePath,
			{ position, symbolName },
		);
	} else {
		if (symbolName === undefined) {
			throw new Error(
				"Pass targetFilePath (with position or symbolName), or symbolName alone for a project-wide lookup.",
			);
		}
		identifierNodes = resolveProjectWideDeclarationCandidates(
			project,
			symbolName,
		);
	}

	return {
		declarations: identifierNodes
			.slice(0, cap)
			.map((node) => collectReferences(node)),
		unsearchedDeclarations: identifierNodes
			.slice(cap)
			.map((node) => locationOf(node)),
	};
}

/** An identifier's own position, without running a reference search. */
function locationOf(identifier: Identifier): ReferenceLocation {
	const sourceFile = identifier.getSourceFile();
	const { line, column } = sourceFile.getLineAndColumnAtPos(
		identifier.getStart(),
	);
	return {
		filePath: sourceFile.getFilePath(),
		line,
		column,
		text: getLineText(sourceFile, line).trim(),
	};
}

function collectReferences(identifierNode: Identifier): DeclarationReferences {
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

	return {
		symbolName: identifierNode.getText(),
		references,
		definition: definitionLocation,
	};
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
