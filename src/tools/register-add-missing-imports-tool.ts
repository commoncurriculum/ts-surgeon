import type { ToolRegistry } from "./registry";
import { z } from "zod";
import { addMissingImports } from "../ts-morph/add-missing-imports/add-missing-imports";
import { formatChangedFiles, runTool } from "./_tool-runner";

export function registerAddMissingImportsTool(registry: ToolRegistry): void {
	registry.tool(
		"add_missing_imports_by_tsmorph",
		`[ts-morph] Add import statements for unresolved identifiers (the editor "Add all missing imports" action) in specific files or the whole project.

## When to use
- After writing or pasting code that references symbols which are not yet imported.
- Cleaning up "Cannot find name 'X'" errors in bulk without hand-writing each import.

## When NOT to use
- Removing unused imports / sorting (use \`organize_imports_by_tsmorph\`).
- The identifier is genuinely undefined (no matching export exists anywhere) — nothing will be added for it.

## Behavior
- For each unresolved identifier, inserts an import from the best matching export found in the project or its dependencies (merging into an existing import from the same module when possible).
- Uses the TypeScript language service, so it respects \`paths\` aliases and the project's module resolution.

## Critical constraints
- All paths (\`tsconfigPath\`, \`filePaths\`) MUST be absolute.
- When \`filePaths\` is omitted, EVERY non-declaration source file in the project is processed — prefer passing the files you touched, and/or run with \`dryRun: true\` first.
- When an identifier could come from multiple modules, the language service picks one; review ambiguous cases. Imports are not added for names with no resolvable export.

## Result
Returns the number of files processed and the list of modified (or, in dryRun, to-be-modified) file paths.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			filePaths: z
				.array(z.string())
				.optional()
				.describe(
					"Absolute paths of files to fix. Omit to process every non-declaration source file in the project.",
				),
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
				"add_missing_imports_by_tsmorph",
				{ fileCount: args.filePaths?.length ?? "all", dryRun: args.dryRun },
				async () => {
					const result = await addMissingImports({
						tsconfigPath: args.tsconfigPath,
						filePaths: args.filePaths,
						dryRun: args.dryRun,
					});

					const summary = `Processed ${result.processedFileCount} file(s); ${result.changedFiles.length} changed.`;
					const changedFilesList = formatChangedFiles(result.changedFiles);
					const message = args.dryRun
						? `Dry run complete: ${summary}\nWould modify the following files:\n - ${changedFilesList}`
						: `Add missing imports successful: ${summary}\nThe following files were modified:\n - ${changedFilesList}`;

					return {
						message,
						log: { changedFilesCount: result.changedFiles.length },
					};
				},
			),
	);
}
