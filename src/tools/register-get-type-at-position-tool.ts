import type { ToolRegistry } from "./registry";
import { z } from "zod";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project";
import { getTypeAtPosition } from "../ts-morph/get-type-at-position/get-type-at-position";
import { resolveTargetIdentifier } from "../ts-morph/rename-symbol/rename-symbol";
import { runTool } from "./_tool-runner";

export function registerGetTypeAtPositionTool(registry: ToolRegistry): void {
	registry.tool(
		"get_type_at_position",
		`[ts-morph] Return the TypeChecker-inferred type at a specific position in a TypeScript/JavaScript file, plus the symbol and its declaration location.

## When to use
- Quickly verifying "what is the actual inferred type of this variable / expression / function?" without spawning \`tsc\` or running a full type check.
- Cheaper than \`Read\`-ing the declaration file when all you need is the type signature.
- Before refactoring, to confirm what a value's actual shape is (especially helpful when types are inferred through multiple generics).

## When NOT to use
- Bulk type analysis across many positions — call \`tsc\` directly instead.
- Listing every reference of a symbol — use \`find_references\`.

## Critical constraints
- Target the node either with \`position\` (1-based line/column, matching what editors display) or with \`symbolName\` (a declaration name, when unambiguous in the file). Pass at least one.
- For function/method identifiers (where ALL declarations are signature-bearing) the type is rendered as a call-style \`(arg: T) => R\` text taken directly from the declaration source, preserving rest \`...\`, optional \`?\`, default values, and destructuring patterns. Overloads are joined with \`&\` and the implementation signature is hidden.
- For function/namespace merges or other mixed symbols (function with extra properties), the raw TypeChecker text (e.g. \`typeof fn\`) is returned to avoid silently dropping the property side of the type.
- For imported symbols the resolved (aliased) symbol's declaration location is reported, including barrel re-export chains (\`export * from\`, \`export { x } from\`) which are recursively unwrapped.
- For built-in or third-party symbols (e.g. \`console\`, \`Promise\`), \`declaration\` may point inside \`node_modules\` lib.d.ts files.

## Result fields
- \`type\`: the inferred type text.
- \`nodeKind\` / \`nodeText\`: what the position landed on (Identifier, StringLiteral, etc., and the source text — truncated to 80 chars).
- \`symbol\` (optional): the resolved symbol's name and the kind of its first declaration.
- \`declaration\` (optional): file path + 1-based line/column of the first declaration.

## Tips
- Pointing at whitespace or a comment line returns a SourceFile/EndOfFileToken node and the file-level inferred type (e.g. \`typeof import("...")\`) — this is NOT an error but is usually not what you want. Check \`nodeKind\` in the response and re-target to the identifier.
- For function/namespace merges where the type returns as \`typeof fn\`, inspect the \`declaration\` location to discover the merged namespace members.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			targetFilePath: z
				.string()
				.describe("Path to the file containing the position to inspect."),
			position: z
				.object({
					line: z.number().int().positive().describe("1-based line number."),
					column: z
						.number()
						.int()
						.positive()
						.describe("1-based column number."),
				})
				.optional()
				.describe(
					"Exact position to inspect. Optional when symbolName is given.",
				),
			symbolName: z
				.string()
				.optional()
				.describe(
					"Declaration name to inspect instead of a position; must be unambiguous in the file.",
				),
		},
		(args) =>
			runTool(
				"get_type_at_position",
				{
					targetFilePath: args.targetFilePath,
					position: args.position,
					symbolName: args.symbolName,
				},
				() => {
					const project = initializeProject(args.tsconfigPath);
					let position = args.position;
					if (!position) {
						if (args.symbolName === undefined) {
							throw new Error(
								"Pass position {line, column}, symbolName, or both.",
							);
						}
						const identifier = resolveTargetIdentifier(
							project,
							args.targetFilePath,
							{ symbolName: args.symbolName },
						);
						const located = identifier
							.getSourceFile()
							.getLineAndColumnAtPos(identifier.getStart());
						position = { line: located.line, column: located.column };
					}
					const result = getTypeAtPosition(
						project,
						args.targetFilePath,
						position,
					);

					const lines: string[] = [
						`Type: ${result.type}`,
						`Node: ${result.nodeKind} ${JSON.stringify(result.nodeText)}`,
					];
					if (result.symbol) {
						lines.push(`Symbol: ${result.symbol.name} (${result.symbol.kind})`);
					}
					if (result.declaration) {
						lines.push(
							`Declared at: ${result.declaration.filePath}:${result.declaration.line}:${result.declaration.column}`,
						);
					}
					return { message: lines.join("\n"), data: result };
				},
			),
	);
}
