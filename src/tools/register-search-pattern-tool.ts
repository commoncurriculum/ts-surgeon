import { z } from "zod";
import { searchPattern } from "../ast-grep/pattern-tools";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project";
import { runTool } from "./_tool-runner";
import type { ToolRegistry } from "./registry";

export function registerSearchPatternTool(registry: ToolRegistry): void {
	registry.tool(
		"search_pattern",
		`[ast-grep] Find every occurrence of a structural code pattern (an ast-grep pattern with $META variables) across the project. Read-only.

## When to use
- "Where does this code *shape* appear?" — e.g. every \`console.log($$$ARGS)\`, every \`await $FN($$$)\` inside a loop, every \`useEffect($FN, [])\`.
- Instead of \`grep -r\` when the thing you are looking for is syntax, not text: patterns match the parsed AST, so formatting, whitespace, and line breaks don't matter, and string/comment contents don't false-positive.

## When NOT to use
- Finding usages of a *symbol* -> use \`find_references\` (type-aware; follows imports and aliases).
- Plain-text search (TODO comments, strings) -> ordinary grep is fine.

## Pattern syntax (ast-grep)
- Write the code you want to find; \`$NAME\` matches one node, \`$$$NAME\` matches zero or more (e.g. argument lists).
- Examples: \`console.log($$$ARGS)\`, \`if ($COND) { $$$BODY }\`, \`$OBJ.map(($EL) => $EL)\`.

## Result
Grep-style \`file:line:col\` list plus the matched text; data carries the structured match list.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			pattern: z
				.string()
				.describe(
					"ast-grep pattern, e.g. 'console.log($$$ARGS)'. $NAME matches one node, $$$NAME matches many.",
				),
			filePaths: z
				.array(z.string())
				.optional()
				.describe(
					"Restrict the search to these files. Omitted = every TS/JS file in the project.",
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
				"search_pattern",
				{ pattern: args.pattern, fileCount: args.filePaths?.length },
				async () => {
					const project = initializeProject(args.tsconfigPath);
					const result = await searchPattern(project, {
						pattern: args.pattern,
						filePaths: args.filePaths,
						maxResults: args.maxResults,
					});
					const lines = result.matches.map(
						(m) =>
							`${m.filePath}:${m.line}:${m.column}  ${m.text.split("\n")[0]}`,
					);
					const header = `Pattern matches: ${result.totalCount} total across ${result.scannedFiles} scanned file(s)${
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
