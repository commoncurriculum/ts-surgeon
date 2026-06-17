import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Project } from "ts-morph";
import { z } from "zod";
import { removePathAlias } from "../../ts-morph/remove-path-alias/remove-path-alias";
import { formatChangedFiles, runTool } from "./_tool-runner";

export function registerRemovePathAliasTool(server: McpServer): void {
	server.tool(
		"remove_path_alias_by_tsmorph",
		`[ts-morph] Convert path-alias imports/exports (e.g., \`@/components/Button\`) to relative paths (\`../../components/Button\`) within a target file or directory.

## When to use
- Standardizing on relative paths for a subset of the codebase.
- Preparing for a large \`rename_filesystem_entry_by_tsmorph\` run when you want to control alias rewriting explicitly (note: \`rename_filesystem_entry_by_tsmorph\` already rewrites aliases to relative paths automatically; run this tool first only if you want the conversion to be a separate, reviewable commit).
- Prefer this over manual find/replace -- relative path computation is error-prone across nested directories.

## When NOT to use
- The project has no \`paths\` mapping in \`tsconfig.json\` (this tool has nothing to do).
- You want to ADD aliases or change one alias to another (not supported).

## Critical constraints
- Aliases are read from the \`paths\` option of the project's \`tsconfig.json\`. Only those aliases are resolved.
- \`targetPath\` may be a single file OR a directory. Directory targets process every \`.ts\`/\`.tsx\` file under it.
- All paths (\`tsconfigPath\`, \`targetPath\`) MUST be absolute.

## Tips
- Run with \`dryRun: true\` first when applying to a directory, to confirm the scope.

## Result
Returns the list of modified (or to-be-modified, in dryRun) file paths, plus status and processing time.`,
		{
			tsconfigPath: z
				.string()
				.describe("Absolute path to the project's tsconfig.json file."),
			targetPath: z
				.string()
				.describe("Absolute path to the target file or directory."),
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
				"remove_path_alias_by_tsmorph",
				{ targetPath: args.targetPath, dryRun: args.dryRun },
				async () => {
					const { tsconfigPath, targetPath, dryRun } = args;
					const project = new Project({ tsConfigFilePath: tsconfigPath });
					const pathsOption = project.compilerOptions.get().paths ?? {};

					const result = await removePathAlias({
						project,
						targetPath,
						dryRun,
						paths: pathsOption,
					});

					if (!dryRun) {
						await project.save();
					}

					const actionVerb = dryRun ? "scheduled for modification" : "modified";
					const message = `Path alias removal (${
						dryRun ? "Dry run" : "Execute"
					}): Within the specified path '${targetPath}', the following files were ${actionVerb}:\n - ${formatChangedFiles(result.changedFiles)}`;

					return {
						message,
						log: { changedFilesCount: result.changedFiles.length },
					};
				},
			),
	);
}
