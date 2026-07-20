import type { ToolRegistry } from "./registry.js";
import { z } from "zod";
import { applyCodeFix } from "../ts-morph/apply-code-fix/apply-code-fix.js";
import { formatChangedFiles, runTool } from "./_tool-runner.js";

export function registerApplyCodeFixTool(registry: ToolRegistry): void {
	registry.tool(
		"apply_code_fix",
		`[ts-morph] Apply a TypeScript "fix all in file" quick-fix across specific files or the whole project. Pairs with \`get_diagnostics\` to turn a diagnosis into an automated fix.

## Supported fixes (\`fix\`)
- \`remove_unused\` — delete unused declarations and unused imports.
- \`implement_interface\` — stub out members a class is missing from an \`implements\` clause (bodies throw "Method not implemented.").
- \`implement_abstract_members\` — stub out inherited \`abstract\` members a subclass has not implemented.
- \`infer_types_from_usage\` — add inferred type annotations for implicit-\`any\` parameters/variables (only offered under \`noImplicitAny\`).

## When to use
- Bulk-clearing a class of diagnostics surfaced by \`get_diagnostics\` (unused code, unimplemented interface/abstract members, implicit any).

## When NOT to use
- Adding missing imports — use \`add_missing_imports\`.
- Sorting/coalescing imports — use \`organize_imports\`.

## Critical constraints
- All paths (\`tsconfigPath\`, \`filePaths\`) MUST be absolute.
- When \`filePaths\` is omitted, EVERY non-declaration source file is processed — prefer passing the files you touched, and/or run with \`dryRun: true\` first.
- A fix with no matching diagnostic in a file is a no-op. \`infer_types_from_usage\` and other fixes only apply when the corresponding diagnostic is present (e.g. \`noImplicitAny\` must be enabled).
- Stubbed member bodies throw \`new Error("Method not implemented.")\`; review and fill them in.

## Result
Returns the number of files processed and the list of modified (or, in dryRun, to-be-modified) file paths.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			fix: z
				.enum([
					"remove_unused",
					"implement_interface",
					"implement_abstract_members",
					"infer_types_from_usage",
				])
				.describe("Which code fix to apply across the target files."),
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
				"apply_code_fix",
				{
					fix: args.fix,
					fileCount: args.filePaths?.length ?? "all",
					dryRun: args.dryRun,
				},
				async () => {
					const result = await applyCodeFix({
						tsconfigPath: args.tsconfigPath,
						fix: args.fix,
						filePaths: args.filePaths,
						dryRun: args.dryRun,
					});

					const summary = `Applied '${args.fix}' to ${result.processedFileCount} file(s); ${result.changedFiles.length} changed.`;
					const changedFilesList = formatChangedFiles(result.changedFiles);
					const message = args.dryRun
						? `Dry run complete: ${summary}\nWould modify the following files:\n - ${changedFilesList}`
						: `Apply code fix successful: ${summary}\nThe following files were modified:\n - ${changedFilesList}`;

					return {
						message,
						log: { changedFilesCount: result.changedFiles.length },
						data: result,
					};
				},
			),
	);
}
