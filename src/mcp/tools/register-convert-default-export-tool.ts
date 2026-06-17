import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { convertDefaultExportToNamed } from "../../ts-morph/convert-default-export/convert-default-export";
import { formatChangedFiles, runTool } from "./_tool-runner";

export function registerConvertDefaultExportTool(server: McpServer): void {
	server.tool(
		"convert_default_export_to_named_by_tsmorph",
		`[ts-morph] Convert a file's \`export default\` into a named export and rewrite every importing/re-exporting site across the project (default imports become named imports; \`export { default } from\` becomes a named re-export).

## When to use
- Migrating a module away from default exports (e.g. enforcing a "no default export" lint rule) without hand-editing every importer.
- A default export is imported under inconsistent local names across the codebase — this normalizes them onto one named export while preserving each importer's local alias.

## When NOT to use
- Renaming an existing named export — use \`rename_symbol_by_tsmorph\`.
- Moving the symbol to another file — use \`move_symbol_to_file_by_tsmorph\`.
- Going the other direction (named → default) — not supported by this tool.

## Supported default-export forms (in the target file)
- \`export default function Foo() {}\` / \`export default class Foo {}\` → keeps the name: \`export function Foo() {}\`.
- \`export default function () {}\` / \`export default class {}\` / \`export default <expr>\` (arrow, object literal, call, literal) → requires \`newName\`; becomes \`export const <newName> = <expr>;\`.
- \`export default someLocal;\` → \`export { someLocal };\` (or \`export { someLocal as <newName> };\`).
- \`export { foo as default };\` → \`export { foo };\` (or \`export { foo as <newName> };\`).

## Reference updates
- \`import Foo from "target"\` AND the named-specifier form \`import { default as Foo } from "target"\` → \`import { <name> as Foo } from "target"\` (the alias is dropped when the local name already equals \`<name>\`).
- Default imports combined with named imports are merged (identical specifiers are deduped); combined with a namespace import (\`import Foo, * as ns\`) they are split into a separate \`import { ... }\` declaration, reusing an existing same-module declaration when one exists.
- \`export { default } from "target"\` → \`export { <name> } from "target"\`; \`export { default as X } from "target"\` → \`export { <name> as X } from "target"\`.
- Path-alias and relative specifiers are both resolved via the TypeChecker.

## Critical constraints
- All paths (\`tsconfigPath\`, \`targetFilePath\`) MUST be absolute.
- \`newName\` is REQUIRED for anonymous default exports and is REJECTED (when it differs) for already-named function/class default exports — rename those separately first. It must be a non-reserved identifier.
- The conversion ABORTS (no changes) if the resulting name already exists as an export in the target file, or for an anonymous \`abstract\` class — neither can be emitted as valid TypeScript.
- Dynamic/runtime access to the default (e.g. \`import("target").then(m => m.default)\`, \`require("target").default\`) is NOT detected or rewritten; review such call sites manually.
- Re-exports that forward the default as a default (\`export { default } from "target"\`) become a NAMED re-export, which changes that barrel's public surface. **Transitive** re-export chains are NOT followed (only sites resolving directly to the target are updated) — verify downstream consumers.

## Result
Returns the resulting export name, the number of updated import and re-export sites, and the list of modified (or, in dryRun, to-be-modified) file paths.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			targetFilePath: z
				.string()
				.describe(
					"Path to the file whose default export should become a named export.",
				),
			newName: z
				.string()
				.optional()
				.describe(
					"Name for the resulting named export. Required for anonymous default exports. Omit to keep the name of an already-named default export.",
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
				"convert_default_export_to_named_by_tsmorph",
				{
					targetFilePath: args.targetFilePath,
					newName: args.newName,
					dryRun: args.dryRun,
				},
				async () => {
					const result = await convertDefaultExportToNamed({
						tsconfigPath: args.tsconfigPath,
						targetFilePath: args.targetFilePath,
						newName: args.newName,
						dryRun: args.dryRun,
					});

					const summary = `Exported as '${result.exportName}'. Updated ${result.updatedImportSites} import site(s) and ${result.updatedReExportSites} re-export site(s).`;
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
