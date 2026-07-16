import type { ToolRegistry } from "./registry";
import { z } from "zod";
import { safeDeleteSymbol } from "../ts-morph/safe-delete-symbol/safe-delete-symbol";
import type { BlockingReference } from "../ts-morph/safe-delete-symbol/types";
import { formatChangedFiles, runTool } from "./_tool-runner";

function formatBlockers(blockers: BlockingReference[]): string {
	return blockers
		.map((b) => ` - ${b.filePath}:${b.line}:${b.column} — ${b.text}`)
		.join("\n");
}

export function registerSafeDeleteSymbolTool(registry: ToolRegistry): void {
	registry.tool(
		"safe_delete_symbol_by_tsmorph",
		`[ts-morph] Delete a top-level symbol's declaration ONLY when it has no references outside its own declaration; otherwise report the blocking references and change nothing.

## When to use
- Removing a function/class/variable/type you believe is dead, with a guarantee you won't break a reference you missed.
- The mutating partner to \`find_unused_exports_by_tsmorph\`: confirm a candidate is truly unused, then delete it.

## When NOT to use
- Renaming or moving the symbol — use \`rename_symbol_by_tsmorph\` / \`move_symbol_to_file_by_tsmorph\`.
- Removing unused imports — use \`organize_imports_by_tsmorph\` or \`apply_code_fix_by_tsmorph\` (\`remove_unused\`).

## Behavior
- Finds the named top-level declaration (and any overload signatures of the same symbol) and resolves all references via the type checker.
- References inside the declaration itself (its name, recursive self-calls) are ignored; ALL other references (other files, same-file usages, local \`export { x }\` re-exports) block deletion.
- If there are no blocking references, the declaration is removed (a single declarator is removed from a multi-variable statement). Otherwise nothing changes and the blockers are returned.

## Critical constraints
- All paths (\`tsconfigPath\`, \`targetFilePath\`) MUST be absolute.
- Operates on TOP-LEVEL declarations by name. If two different symbols share the name, the first in the file is targeted.
- Imports that become unused after deletion are NOT removed — follow up with \`organize_imports\` / \`apply_code_fix\` if needed.

## Result
On success: the deleted symbol and the modified file(s). When blocked: the list of references (\`file:line:col\`) preventing deletion.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			targetFilePath: z
				.string()
				.describe("Path to the file declaring the symbol."),
			symbolName: z
				.string()
				.describe("Name of the top-level symbol to delete."),
			dryRun: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"If true, only show the intended result without modifying files.",
				),
		},
		(args) =>
			runTool(
				"safe_delete_symbol_by_tsmorph",
				{
					targetFilePath: args.targetFilePath,
					symbolName: args.symbolName,
					dryRun: args.dryRun,
				},
				async () => {
					const result = await safeDeleteSymbol({
						tsconfigPath: args.tsconfigPath,
						targetFilePath: args.targetFilePath,
						symbolName: args.symbolName,
						dryRun: args.dryRun,
					});

					if (!result.deleted) {
						return {
							message: `Not deleted: '${args.symbolName}' has ${result.blockingReferences.length} blocking reference(s):\n${formatBlockers(result.blockingReferences)}`,
							log: {
								deleted: false,
								blockers: result.blockingReferences.length,
							},
						};
					}

					const changedFilesList = formatChangedFiles(result.changedFiles);
					const message = args.dryRun
						? `Dry run complete: '${args.symbolName}' is safe to delete. Would modify the following files:\n - ${changedFilesList}`
						: `Deleted '${args.symbolName}'. The following files were modified:\n - ${changedFilesList}`;

					return {
						message,
						log: {
							deleted: true,
							changedFilesCount: result.changedFiles.length,
						},
					};
				},
			),
	);
}
