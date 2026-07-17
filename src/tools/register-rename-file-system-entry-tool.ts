import * as path from "node:path";
import type { ToolRegistry } from "./registry";
import { z } from "zod";
import { TimeoutError } from "../errors/timeout-error";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project";
import { renameFileSystemEntry } from "../ts-morph/rename-file-system/rename-file-system-entry";
import { formatChangedFiles, runTool } from "./_tool-runner";

const renameSchema = z.object({
	tsconfigPath: z
		.string()
		.describe("Absolute path to the project's tsconfig.json file."),
	renames: z
		.array(
			z.object({
				oldPath: z
					.string()
					.describe(
						"The current absolute path of the file or folder to rename.",
					),
				newPath: z
					.string()
					.describe("The new desired absolute path for the file or folder."),
			}),
		)
		.nonempty()
		.describe("An array of rename operations, each with oldPath and newPath."),
	dryRun: z
		.boolean()
		.optional()
		.default(false)
		.describe("If true, only show intended changes without modifying files."),
	timeoutSeconds: z
		.number()
		.int()
		.positive()
		.optional()
		.default(120)
		.describe(
			"Maximum time in seconds allowed for the operation before it times out. Defaults to 120.",
		),
});

type RenameArgs = z.infer<typeof renameSchema>;

export function registerRenameFileSystemEntryTool(
	registry: ToolRegistry,
): void {
	registry.tool(
		"rename_filesystem_entry",
		`[ts-morph] Rename or move one or more TypeScript/JavaScript files and/or folders, and automatically rewrite every import/export path that references them.

## When to use
- Renaming or moving any .ts/.tsx/.js/.jsx file or directory (single or batch).
- Prefer this over \`mv\` + manual import fixing. This tool resolves references via the type checker, so it handles relative paths, path aliases (\`@/\`), and barrel imports (\`from '.'\`, \`from '..'\`) that grep cannot reliably find.
- Use batch mode (multiple entries in \`renames\`) when reorganizing several files at once -- a single AST pass is much faster than running the tool repeatedly.

## When NOT to use
- Renaming a symbol inside a file -> \`rename_symbol\`.
- Moving a single symbol (not the whole file) to another file -> \`move_symbol_to_file\`.

## Critical constraints
- Path aliases in updated imports are REWRITTEN AS RELATIVE PATHS (e.g., \`@/foo\` -> \`../foo\`). If you want to keep aliases, run \`remove_path_alias\` separately beforehand, or accept the conversion.
- Barrel imports like \`import X from '../components'\` are rewritten to point at the resolved index file (e.g., \`'../components/index.tsx'\`).
- Default exports declared via a bare identifier (\`export default Foo;\`) may not be updated correctly. Default function/class declarations (\`export default function foo() {}\`) are handled.
- All paths (\`tsconfigPath\`, \`oldPath\`, \`newPath\`) MUST be absolute.
- The tool refuses to run on path conflicts (target already exists, duplicate destinations).

## Tips
- Run with \`dryRun: true\` first for any non-trivial rename to inspect the affected file list.
- \`timeoutSeconds\` defaults to 120; raise it for very large projects or huge batch renames.

## Result
Returns the list of modified (or to-be-modified, in dryRun) file paths, plus status and processing time. On timeout the operation is cancelled and an error is returned.`,
		renameSchema.shape,
		(args: RenameArgs) => {
			const { tsconfigPath, renames, dryRun, timeoutSeconds } = args;
			const logArgs = {
				tsconfigPath,
				renames: renames.map((r) => ({
					old: path.basename(r.oldPath),
					new: path.basename(r.newPath),
				})),
				dryRun,
				timeoutSeconds,
			};

			return runTool("rename_filesystem_entry", logArgs, async () => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => {
					controller.abort(
						new TimeoutError(
							`Operation timed out after ${timeoutSeconds} seconds`,
							timeoutSeconds,
						),
					);
				}, timeoutSeconds * 1000);

				try {
					const project = initializeProject(tsconfigPath);
					const result = await renameFileSystemEntry({
						project,
						renames,
						dryRun,
						signal: controller.signal,
					});

					const renameSummary = renames
						.map(
							(r) =>
								`'${path.basename(r.oldPath)}' -> '${path.basename(r.newPath)}'`,
						)
						.join(", ");
					const changedFilesList = formatChangedFiles(result.changedFiles);
					const message = dryRun
						? `Dry run complete: Renaming [${renameSummary}] would modify the following files:\n - ${changedFilesList}`
						: `Rename successful: Renamed [${renameSummary}]. The following files were modified:\n - ${changedFilesList}`;
					return {
						message,
						log: { changedFilesCount: result.changedFiles.length },
						data: result,
					};
				} catch (error) {
					// Map cancellation into friendly messages; the harness prefixes "Error:".
					if (error instanceof TimeoutError) {
						throw new Error(
							`The operation timed out because it did not complete within ${error.durationSeconds} seconds. The operation has been cancelled.\nThe project may be large or the number of changes may be high.`,
						);
					}
					if (error instanceof Error && error.name === "AbortError") {
						throw new Error(`The operation was cancelled: ${error.message}`);
					}
					throw error;
				} finally {
					clearTimeout(timeoutId);
				}
			});
		},
	);
}
