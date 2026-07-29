import type { ToolRegistry } from "./registry.js";
import { z } from "zod";
import {
	type DeclarationReferences,
	findSymbolReferences,
} from "../ts-morph/find-references.js";
import { templateCaveat } from "../ts-morph/_utils/template-references.js";
import { runTool } from "./_tool-runner.js";

/** One declaration's definition line plus its numbered references. */
function formatDeclaration(declaration: DeclarationReferences): string {
	let text = "";
	if (declaration.definition) {
		const { filePath, line, column } = declaration.definition;
		text += "Definition:\n";
		text += `- ${filePath}:${line}:${column}\n`;
		text += `  \`\`\`typescript\n  ${declaration.definition.text}\n  \`\`\`\n\n`;
	} else {
		text += "Definition not found.\n\n";
	}
	if (declaration.references.length > 0) {
		text += `References (${declaration.references.length} found):\n`;
		text += declaration.references
			.map(
				(ref) =>
					`- ${ref.filePath}:${ref.line}:${ref.column}\n  \`\`\`typescript\n  ${ref.text}\n  \`\`\``,
			)
			.join("\n\n");
	} else {
		text += "References not found.";
	}
	return text.trim();
}

export function registerFindReferencesTool(registry: ToolRegistry): void {
	registry.tool(
		"find_references",
		`[ts-morph] Locate the definition AND every reference of a symbol at a given position, project-wide. Read-only.

## When to use
- Assessing the blast radius of a planned refactor before changing anything.
- Answering "who calls this function?" / "where is this type used?" precisely.
- Prefer this over \`grep\` for identifier lookups: grep matches unrelated same-name tokens (different scopes, comments, strings), while this tool uses the type checker to return only true references.

## When NOT to use
- You just want a free-text search (comments, strings, doc files) -> use \`grep\`.
- You already plan to rename -> skip straight to \`rename_symbol\` (it computes the same set internally and supports \`dryRun\`).

## Critical constraints
- Target the symbol either with \`position\` (1-based line/column landing on the identifier itself) or with \`symbolName\` (the declaration name, when it is unambiguous in the file). Pass at least one.
- \`targetFilePath\` is optional: \`symbolName\` alone looks the declaration up project-wide (it must be unambiguous across the project; the error lists every candidate otherwise). You do NOT need to know which file declares a symbol to use this tool.
- All paths (\`tsconfigPath\`, \`targetFilePath\`) MUST be absolute.

## Result
Returns the definition (file path, line, column, source line) when found, followed by a numbered list of references with the same fields.`,
		{
			tsconfigPath: z
				.string()
				.describe("Absolute path to the project's tsconfig.json file."),
			targetFilePath: z
				.string()
				.optional()
				.describe(
					"Absolute path to the file containing the symbol. Optional: omit it to resolve symbolName project-wide.",
				),
			position: z
				.object({
					line: z.number().describe("1-based line number."),
					column: z.number().describe("1-based column number."),
				})
				.optional()
				.describe(
					"The exact position of the symbol. Optional when symbolName is given.",
				),
			symbolName: z
				.string()
				.optional()
				.describe(
					"Declaration name to target instead of a position; must be unambiguous in the file. Pass position as well to disambiguate.",
				),
		},
		(args) =>
			runTool(
				"find_references",
				{
					targetFilePath: args.targetFilePath,
					position: args.position,
					symbolName: args.symbolName,
				},
				async () => {
					const { declarations } = await findSymbolReferences({
						tsconfigPath: args.tsconfigPath,
						targetFilePath: args.targetFilePath,
						position: args.position,
						symbolName: args.symbolName,
					});

					// One declaration reads exactly as before. Several are reported
					// side by side instead of raising an ambiguity error the caller
					// would have to pay another full project parse to answer.
					const sections =
						declarations.length === 1
							? formatDeclaration(declarations[0])
							: [
									`'${declarations[0].symbolName}' has ${declarations.length} declarations; references for each follow. Pass position {line, column} to target just one.`,
									...declarations.map(
										(declaration, index) =>
											`## Declaration ${index + 1} — ${declaration.definition?.filePath ?? "unknown file"}:${declaration.definition?.line ?? "?"}:${declaration.definition?.column ?? "?"}\n${formatDeclaration(declaration)}`,
									),
								].join("\n\n");

					// Templates outside the TypeScript program hold references the
					// checker cannot see. Reporting a partial answer as "Success" is
					// what made that omission dangerous.
					const caveat = templateCaveat({
						tsconfigPath: args.tsconfigPath,
						symbolNames: [...new Set(declarations.map((d) => d.symbolName))],
						mutating: false,
					});

					return {
						message: caveat ? `${sections}\n\n${caveat.text}` : sections,
						data: {
							declarations,
							// Retained for single-declaration consumers of --json.
							definition: declarations[0]?.definition ?? null,
							references: declarations[0]?.references ?? [],
							...(caveat ? { templateBlindSpot: caveat.data } : {}),
						},
					};
				},
			),
	);
}
