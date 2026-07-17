import { z } from "zod";
import { rewriteWhere } from "../ast-grep/rewrite-where";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project";
import { formatChangedFiles, runTool } from "./_tool-runner";
import type { ToolRegistry } from "./registry";

export function registerRewriteWhereTool(registry: ToolRegistry): void {
	registry.tool(
		"rewrite_where",
		`[ast-grep + ts-morph] Rewrite a structural code pattern ONLY where a captured node's checker type satisfies a predicate — the type-aware codemod no plain pattern tool can do.

## When to use
- Two types share a method name and only one should change: rewrite \`$X.close()\` -> \`shutdown($X)\` only where \`$X\` is a \`DbConnection\`, leaving \`FileHandle.close()\` call sites alone.
- Any \`rewrite_pattern\` job where the pattern over-matches syntactically and the discriminator is the TYPE of a capture.

## When NOT to use
- No type constraint needed -> \`rewrite_pattern\` (cheaper: no type checking).
- Renaming a symbol / changing a signature -> \`rename_symbol\` / \`change_signature\`.

## The predicate (\`where\`)
- \`capture\`: the metavariable to test, WITHOUT the $ (pattern \`$X.close()\` -> capture \`"X"\`).
- \`type\`: the type name to test against.
- \`mode\`:
  - \`"is"\` (default): the capture's type is exactly the named type (symbol or alias name). A union containing the type does NOT match.
  - \`"extends"\`: the type is the named type or inherits from it (base-type chain).
  - \`"assignable"\`: TypeScript assignability, which is STRUCTURAL (a same-shape type matches). Requires \`typeDeclarationPath\` — the file declaring the target type — because a bare name is ambiguous across a project.

## Critical constraints
- The rewrite is textual within each match: imports are NOT touched unless \`fixImports\` is set (which adds missing imports on changed files; it never removes or reorders).
- Run with \`dryRun: true\` first; the result reports matchCount (syntactic) vs rewrittenCount (predicated) so you can see how much the predicate filtered.

## Result
Match/rewrite counts and the list of modified (or to-be-modified, in dryRun) file paths.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			pattern: z
				.string()
				.describe("ast-grep pattern to match, e.g. '$X.close()'."),
			rewrite: z
				.string()
				.describe(
					"Replacement template using the pattern's captures, e.g. 'await $X.close()'.",
				),
			where: z
				.object({
					capture: z
						.string()
						.min(1)
						.describe(
							"Metavariable whose type is tested, without the $ (e.g. 'X').",
						),
					type: z
						.string()
						.min(1)
						.describe("Type name to test against, e.g. 'DbConnection'."),
					mode: z
						.enum(["is", "extends", "assignable"])
						.optional()
						.describe(
							"'is' (exact, default), 'extends' (is-or-inherits), or 'assignable' (structural, needs typeDeclarationPath).",
						),
					typeDeclarationPath: z
						.string()
						.optional()
						.describe(
							"File declaring the target type; required for mode 'assignable'.",
						),
				})
				.describe("Type predicate applied to each match's capture."),
			filePaths: z
				.array(z.string())
				.optional()
				.describe(
					"Restrict the rewrite to these files. Omitted = every TS/JS file in the project (use dryRun first).",
				),
			dryRun: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"If true, only show intended changes without modifying files.",
				),
			fixImports: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"After rewriting, add missing imports on the changed files (only imports the language service can resolve).",
				),
		},
		(args) =>
			runTool(
				"rewrite_where",
				{
					pattern: args.pattern,
					rewrite: args.rewrite,
					whereType: args.where.type,
					whereMode: args.where.mode ?? "is",
					dryRun: args.dryRun,
				},
				async () => {
					const project = initializeProject(args.tsconfigPath);
					const result = await rewriteWhere(project, {
						pattern: args.pattern,
						rewrite: args.rewrite,
						where: args.where,
						filePaths: args.filePaths,
						dryRun: args.dryRun,
						fixImports: args.fixImports,
					});
					const changedFilesList = formatChangedFiles(result.changedFiles);
					const summary = `${result.rewrittenCount} of ${result.matchCount} pattern match(es) passed the type predicate`;
					const message = args.dryRun
						? `Dry run complete: ${summary} and would be rewritten in the following files:\n - ${changedFilesList}`
						: `Rewrite successful: ${summary} and were rewritten. The following files were modified:\n - ${changedFilesList}`;
					return {
						message,
						log: {
							matchCount: result.matchCount,
							rewrittenCount: result.rewrittenCount,
							changedFilesCount: result.changedFiles.length,
						},
						data: result,
					};
				},
			),
	);
}
