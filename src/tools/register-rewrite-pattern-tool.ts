import { z } from "zod";
import { rewritePattern } from "../ast-grep/pattern-tools.js";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project.js";
import { formatChangedFiles, runTool } from "./_tool-runner.js";
import type { ToolRegistry } from "./registry.js";

export function registerRewritePatternTool(registry: ToolRegistry): void {
	registry.tool(
		"rewrite_pattern",
		`[ast-grep] Rewrite every occurrence of a structural code pattern using a template — the safe replacement for sed-style codemods.

## When to use
- Syntactic, project-wide codemods: \`console.log($$$ARGS)\` -> \`logger.debug($$$ARGS)\`, \`assert.equal($A, $B)\` -> \`expect($A).toBe($B)\`, wrapping/unwrapping call shapes.
- Whenever you are tempted to \`sed -i\` source files: this matches the AST (formatting-proof, no string/comment false positives) and previews with dryRun.

## When NOT to use
- Renaming a symbol and its imports/re-exports -> \`rename_symbol\` (type-aware).
- Changing a function's parameters and call sites -> \`change_signature\`.

## Pattern & rewrite syntax (ast-grep)
- \`pattern\` matches code shapes; \`rewrite\` is the replacement template. \`$NAME\` captures one node, \`$$$NAME\` captures many (source text is preserved verbatim, separators included).
- Example: pattern \`console.log($$$ARGS)\`, rewrite \`logger.debug($$$ARGS)\`.

## Critical constraints
- The rewrite is textual within each match: imports are NOT touched unless \`fixImports\` is set, which adds missing imports on the changed files (only imports the language service can resolve; nothing is removed or reordered — follow with \`organize_imports\` for cleanup, then \`get_diagnostics\`).
- Run with \`dryRun: true\` first when the pattern may fan out widely.
- Need the rewrite to apply only where a capture has a specific TYPE? -> \`rewrite_where\`.

## Result
Match count and the list of modified (or to-be-modified, in dryRun) file paths.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			pattern: z
				.string()
				.describe("ast-grep pattern to match, e.g. 'console.log($$$ARGS)'."),
			rewrite: z
				.string()
				.describe(
					"Replacement template using the pattern's $NAME / $$$NAME captures, e.g. 'logger.debug($$$ARGS)'.",
				),
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
					"After rewriting, add missing imports on the changed files (only imports the language service can resolve; nothing is removed or reordered).",
				),
		},
		(args) =>
			runTool(
				"rewrite_pattern",
				{
					pattern: args.pattern,
					rewrite: args.rewrite,
					dryRun: args.dryRun,
				},
				async () => {
					const project = initializeProject(args.tsconfigPath);
					const result = await rewritePattern(project, {
						pattern: args.pattern,
						rewrite: args.rewrite,
						filePaths: args.filePaths,
						dryRun: args.dryRun,
						fixImports: args.fixImports,
					});
					const changedFilesList = formatChangedFiles(result.changedFiles);
					const message = args.dryRun
						? `Dry run complete: ${result.matchCount} match(es) would be rewritten in the following files:\n - ${changedFilesList}`
						: `Rewrite successful: ${result.matchCount} match(es) rewritten. The following files were modified:\n - ${changedFilesList}`;
					return {
						message,
						log: {
							matchCount: result.matchCount,
							changedFilesCount: result.changedFiles.length,
						},
						data: result,
					};
				},
			),
	);
}
