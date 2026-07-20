import type { ToolRegistry } from "./registry.js";
import { z } from "zod";
import { renameSymbol } from "../ts-morph/rename-symbol/rename-symbol.js";
import { formatChangedFiles, runTool } from "./_tool-runner.js";

export function registerRenameSymbolTool(registry: ToolRegistry): void {
	registry.tool(
		"rename_symbol",
		`[ts-morph] Type-aware rename of a TypeScript/JavaScript symbol (function, variable, class, type, interface, enum, etc.) across the entire project.

## When to use
- Renaming any symbol that may be imported, re-exported, or referenced in other files.
- Prefer this over manual Edit + grep / sed. Identifier-based search misses re-exports, JSX attribute usage, and matches unrelated same-name tokens. This tool resolves references via the type checker, so it is both safer and faster.
- Even for a "local-only" symbol, this tool is the correct default: it costs nothing extra and guarantees no missed reference.

## When NOT to use
- Renaming a file or folder (and updating imports to it) -> use \`rename_filesystem_entry\`.
- Moving a symbol to a different file -> use \`move_symbol_to_file\`.
- Just looking up where a symbol is used (no rename) -> use \`find_references\`.

## Critical constraints
- \`position\` is optional: when omitted, the symbol is located by \`symbolName\` among the file's declaration names, which must be unambiguous (the error lists candidate positions otherwise). When given, it must point at the symbol's identifier (1-based line/column, as shown by editors).
- \`symbolName\` must match the identifier text at the resolved position; it is used as a sanity check.
- All paths (\`tsconfigPath\`, \`targetFilePath\`) MUST be absolute.

## Tips
- Run with \`dryRun: true\` first when the change spans many files, to preview the affected file list.

## Result
Returns the list of modified (or to-be-modified, in dryRun) file paths, plus status and processing time.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			targetFilePath: z
				.string()
				.describe("Path to the file containing the symbol to rename."),
			position: z
				.object({
					line: z.number().describe("1-based line number."),
					column: z.number().describe("1-based column number."),
				})
				.optional()
				.describe(
					"The exact position of the symbol to rename. Optional when symbolName is an unambiguous declaration name in the file.",
				),
			symbolName: z.string().describe("The current name of the symbol."),
			newName: z.string().describe("The new name for the symbol."),
			dryRun: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"If true, only show intended changes without modifying files.",
				),
		},
		(args) =>
			runTool(
				"rename_symbol",
				{
					targetFilePath: args.targetFilePath,
					position: args.position,
					symbolName: args.symbolName,
					newName: args.newName,
					dryRun: args.dryRun,
				},
				async () => {
					const { symbolName, newName, dryRun } = args;
					const result = await renameSymbol({
						tsconfigPath: args.tsconfigPath,
						targetFilePath: args.targetFilePath,
						position: args.position,
						symbolName,
						newName,
						dryRun,
					});

					const changedFilesList = formatChangedFiles(result.changedFiles);
					const message = dryRun
						? `Dry run complete: Renaming symbol '${symbolName}' to '${newName}' would modify the following files:\n - ${changedFilesList}`
						: `Rename successful: Renamed symbol '${symbolName}' to '${newName}'. The following files were modified:\n - ${changedFilesList}`;

					return {
						message,
						log: { changedFilesCount: result.changedFiles.length },
						data: result,
					};
				},
			),
	);
}
