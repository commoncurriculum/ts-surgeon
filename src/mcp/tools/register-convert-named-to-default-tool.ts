import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { convertNamedExportToDefault } from "../../ts-morph/convert-named-to-default/convert-named-to-default";
import { formatChangedFiles, runTool } from "./_tool-runner";

export function registerConvertNamedToDefaultTool(server: McpServer): void {
	server.tool(
		"convert_named_export_to_default_by_tsmorph",
		`[ts-morph] Convert a file's named export into its default export and rewrite every importing/re-exporting site across the project (named imports become default imports; \`export { name } from\` becomes \`export { default as name } from\`). This is the inverse of \`convert_default_export_to_named_by_tsmorph\`.

## When to use
- Standardizing a module on a default export (e.g. a component file expected to default-export its component).

## When NOT to use
- Renaming an export — use \`rename_symbol_by_tsmorph\`.
- Converting a default export to a named one — use \`convert_default_export_to_named_by_tsmorph\`.

## Supported target forms (in the target file)
- \`export function Foo() {}\` / \`export class Foo {}\` → \`export default function Foo() {}\`.
- \`export const Foo = ...\` / \`export let/var\` / \`export enum\` → keeps the declaration and appends \`export default Foo;\`.
- \`export { Foo }\` (and \`export { local as Foo }\`) → routes the binding to the default export.

## Reference updates
- \`import { Foo } from "target"\` → \`import Foo from "target"\`; \`import { Foo as Bar }\` → \`import Bar from "target"\`. Other named imports on the same statement are preserved (the default is split out).
- \`export { Foo } from "target"\` → \`export { default as Foo } from "target"\`; \`export { Foo as Bar } from "target"\` → \`export { default as Bar } from "target"\`.

## Critical constraints
- All paths (\`tsconfigPath\`, \`targetFilePath\`) MUST be absolute, and \`exportName\` must be a value export (not a \`type\`/\`interface\`).
- ABORTS if the file already has a default export, if \`exportName\` is re-exported from another file (convert it in its source file), or if it is declared in a multi-variable \`export const a, b\` statement (split it first).
- Namespace-member access of the converted name (\`ns.Foo\` from \`import * as ns\`) is NOT rewritten and will break — review such sites manually.

## Result
Returns the number of updated import and re-export sites, and the list of modified (or, in dryRun, to-be-modified) file paths.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			targetFilePath: z
				.string()
				.describe(
					"Path to the file whose named export should become the default export.",
				),
			exportName: z
				.string()
				.describe(
					"Name of the named export to convert into the default export.",
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
				"convert_named_export_to_default_by_tsmorph",
				{
					targetFilePath: args.targetFilePath,
					exportName: args.exportName,
					dryRun: args.dryRun,
				},
				async () => {
					const result = await convertNamedExportToDefault({
						tsconfigPath: args.tsconfigPath,
						targetFilePath: args.targetFilePath,
						exportName: args.exportName,
						dryRun: args.dryRun,
					});

					const summary = `Converted '${args.exportName}' to the default export. Updated ${result.updatedImportSites} import site(s) and ${result.updatedReExportSites} re-export site(s).`;
					const changedFilesList = formatChangedFiles(result.changedFiles);
					const message = args.dryRun
						? `Dry run complete: ${summary}\nWould modify the following files:\n - ${changedFilesList}`
						: `Conversion successful: ${summary}\nThe following files were modified:\n - ${changedFilesList}`;

					return {
						message,
						log: { changedFilesCount: result.changedFiles.length },
					};
				},
			),
	);
}
