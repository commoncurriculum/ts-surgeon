import { z } from "zod";
import { searchText } from "../text/search-text";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project";
import { runTool } from "./_tool-runner";
import type { ToolRegistry } from "./registry";

export function registerSearchTextTool(registry: ToolRegistry): void {
	registry.tool(
		"search_text",
		`[text] Find every occurrence of plain text (or a regex) across the project's source files. Read-only — the project-scoped replacement for \`grep -r\`.

## When to use
- Plain-text lookups where the AST doesn't help: TODO/FIXME comments, string literals, config keys, error messages, URLs.
- Instead of \`grep -r\` / \`rg\`: the corpus is the tsconfig project's source files, so node_modules, dist, and lockfiles are never scanned and never pollute the results.

## When NOT to use
- Finding usages of a *symbol* -> use \`find_references\` (type-aware; follows imports and aliases).
- Finding a code *shape* (call patterns, syntax) -> use \`search_pattern\` (formatting-proof, no string/comment false positives).

## Query semantics
- The query is a literal string by default; set \`regex: true\` for a JavaScript regular expression.
- Case-sensitive by default; set \`caseSensitive: false\` to ignore case.

## Result
Grep-style \`file:line:col\` list plus the matched line; data carries the structured match list.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			query: z
				.string()
				.min(1)
				.describe("Text to search for. A literal string unless regex is true."),
			regex: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"If true, interpret the query as a JavaScript regular expression.",
				),
			caseSensitive: z
				.boolean()
				.optional()
				.default(true)
				.describe("If false, match case-insensitively (default true)."),
			filePaths: z
				.array(z.string())
				.optional()
				.describe(
					"Restrict the search to these files. Omitted = every source file in the project.",
				),
			maxResults: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Cap on listed matches (default 200)."),
		},
		(args) =>
			runTool(
				"search_text",
				{
					query: args.query,
					regex: args.regex,
					fileCount: args.filePaths?.length,
				},
				() => {
					const project = initializeProject(args.tsconfigPath);
					const result = searchText(project, {
						query: args.query,
						regex: args.regex,
						caseSensitive: args.caseSensitive,
						filePaths: args.filePaths,
						maxResults: args.maxResults,
					});
					const lines = result.matches.map(
						(m) => `${m.filePath}:${m.line}:${m.column}  ${m.text}`,
					);
					const header = `Text matches: ${result.totalCount} total across ${result.scannedFiles} scanned file(s)${
						result.truncated ? ` — showing first ${result.matches.length}` : ""
					}`;
					const body =
						result.matches.length > 0 ? lines.join("\n") : "(No matches)";
					return {
						message: `${header}\n${body}`,
						log: { matchCount: result.totalCount },
						data: result,
					};
				},
			),
	);
}
