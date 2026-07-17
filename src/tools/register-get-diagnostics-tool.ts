import type { ToolRegistry } from "./registry";
import { z } from "zod";
import { getDiagnostics } from "../ts-morph/get-diagnostics/get-diagnostics";
import type { DiagnosticInfo } from "../ts-morph/get-diagnostics/types";
import { runTool } from "./_tool-runner";

function formatLocation(d: DiagnosticInfo): string {
	if (d.filePath === undefined) return "(global)";
	if (d.line === undefined) return d.filePath;
	return `${d.filePath}:${d.line}:${d.column ?? 0}`;
}

function formatDiagnostic(d: DiagnosticInfo): string {
	return `${d.category} TS${d.code} ${formatLocation(d)} — ${d.message}`;
}

export function registerGetDiagnosticsTool(registry: ToolRegistry): void {
	registry.tool(
		"get_diagnostics",
		`[ts-morph] Return the TypeScript pre-emit diagnostics (syntactic + semantic type errors, warnings, and suggestions) for specific files or the whole project, computed from the project's tsconfig.

## When to use
- Validating that an edit/refactor did not introduce type errors, without spawning a separate \`tsc\` process.
- Getting the exact location + code + message of type errors to fix them.

## When NOT to use
- Inspecting the type at a single position — use \`get_type_at_position\`.
- Listing unused exports/imports — use \`find_unused_exports\` / \`organize_imports\`.

## Behavior
- Uses \`getPreEmitDiagnostics\` (the same set \`tsc --noEmit\` would report, minus emit-only errors).
- Diagnostics are sorted error → warning → suggestion → message, then by file and position.
- When \`filePaths\` is omitted, the whole project is checked (including global diagnostics with no file).

## Critical constraints
- All paths (\`tsconfigPath\`, \`filePaths\`) MUST be absolute.
- Reported \`line\`/\`column\` are 1-based.
- Results are capped at \`maxResults\` (default 100); \`truncated\` indicates whether more exist.

## Result
A summary (total/error/warning counts) plus one line per diagnostic: \`<category> TS<code> <file>:<line>:<col> — <message>\`. A file-level diagnostic with no specific position renders as just \`<file>\`, and a project-global diagnostic (no associated file) renders as \`(global)\`.`,
		{
			tsconfigPath: z
				.string()
				.describe("Path to the project's tsconfig.json file."),
			filePaths: z
				.array(z.string())
				.optional()
				.describe(
					"Absolute paths of files to diagnose. Omit to check the whole project.",
				),
			maxResults: z
				.number()
				.int()
				.positive()
				.optional()
				.default(100)
				.describe("Maximum number of diagnostics to return (default 100)."),
		},
		(args) =>
			runTool(
				"get_diagnostics",
				{
					fileCount: args.filePaths?.length ?? "all",
					maxResults: args.maxResults,
				},
				() => {
					const result = getDiagnostics({
						tsconfigPath: args.tsconfigPath,
						filePaths: args.filePaths,
						maxResults: args.maxResults,
					});

					const header = `Diagnostics: ${result.totalCount} total (${result.errorCount} error(s), ${result.warningCount} warning(s))${
						result.truncated
							? ` — showing first ${result.diagnostics.length}`
							: ""
					}`;
					const body =
						result.diagnostics.length > 0
							? result.diagnostics.map(formatDiagnostic).join("\n")
							: "(No diagnostics)";
					return { message: `${header}\n${body}`, data: result };
				},
			),
	);
}
