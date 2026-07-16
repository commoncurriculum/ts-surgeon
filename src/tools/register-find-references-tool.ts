import type { ToolRegistry } from "./registry";
import { z } from "zod";
import { findSymbolReferences } from "../ts-morph/find-references";
import { runTool } from "./_tool-runner";

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
- All paths (\`tsconfigPath\`, \`targetFilePath\`) MUST be absolute.

## Result
Returns the definition (file path, line, column, source line) when found, followed by a numbered list of references with the same fields.`,
		{
			tsconfigPath: z
				.string()
				.describe("Absolute path to the project's tsconfig.json file."),
			targetFilePath: z
				.string()
				.describe("Absolute path to the file containing the symbol."),
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
					const { references, definition } = await findSymbolReferences({
						tsconfigPath: args.tsconfigPath,
						targetFilePath: args.targetFilePath,
						position: args.position,
						symbolName: args.symbolName,
					});

					let resultText = "";
					if (definition) {
						resultText += "Definition:\n";
						resultText += `- ${definition.filePath}:${definition.line}:${definition.column}\n`;
						resultText += `  \`\`\`typescript\n  ${definition.text}\n  \`\`\`\n\n`;
					} else {
						resultText += "Definition not found.\n\n";
					}

					if (references.length > 0) {
						resultText += `References (${references.length} found):\n`;
						resultText += references
							.map(
								(ref) =>
									`- ${ref.filePath}:${ref.line}:${ref.column}\n  \`\`\`typescript\n  ${ref.text}\n  \`\`\`\``,
							)
							.join("\n\n");
					} else {
						resultText += "References not found.";
					}
					return {
						message: resultText.trim(),
						data: { definition, references },
					};
				},
			),
	);
}
