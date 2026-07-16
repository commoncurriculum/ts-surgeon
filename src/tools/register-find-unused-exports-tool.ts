import type { ToolRegistry } from "./registry";
import { z } from "zod";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project";
import {
	findUnusedExports,
	type UnusedExport,
} from "../ts-morph/find-unused-exports/find-unused-exports";
import type { PackageExportWarning } from "../ts-morph/find-unused-exports/package-export-warnings";
import {
	summarizeUnusedExports,
	type UnusedExportsSummary,
} from "../ts-morph/find-unused-exports/summarize-unused-exports";
import { runTool } from "./_tool-runner";

/** Scan cap for summary mode to get a full picture (distinct from the default 100 used in list mode). */
const SUMMARY_SCAN_CAP = 100_000;
/** Maximum number of rows to show in the "by directory" breakdown in summary mode. */
const SUMMARY_TOP_DIRECTORIES = 20;

function formatUnusedExport(entry: UnusedExport): string {
	const tag = entry.isDefaultExport ? " [default]" : "";
	return `- ${entry.filePath}:${entry.line}:${entry.column}  ${entry.name} (${entry.kind})${tag}  textHits=${entry.textOccurrences} sameFileRefs=${entry.sameFileReferenceCount}`;
}

/**
 * Formats per-package structural warnings into output lines.
 * Inserted before the candidate list in both list and summary modes so the reader sees them first.
 */
function formatPackageWarnings(warnings: PackageExportWarning[]): string[] {
	if (warnings.length === 0) return [];
	const lines = ["⚠ Package-level warnings (likely FALSE POSITIVES below):"];
	for (const w of warnings) {
		const label = w.packageName ?? w.packageJsonPath;
		lines.push(
			`- ${label} (${w.packageJsonPath}): ${w.candidateCount} candidate(s) from this package may actually be consumed by other packages. Its package.json entry points (${w.externalEntryTargets.join(", ")}) resolve OUTSIDE the scanned sources, so cross-package imports resolve to built output / node_modules and are invisible to this analysis. Cross-check textHits and find_references before deleting anything from this package.`,
		);
	}
	lines.push("");
	return lines;
}

/** Computes the common prefix of a set of directory paths to shorten the display. */
function commonDirectoryPrefix(directories: string[]): string {
	if (directories.length === 0) return "";
	const split = directories.map((d) => d.split("/"));
	let prefix = split[0];
	for (const parts of split) {
		let i = 0;
		while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
		prefix = prefix.slice(0, i);
	}
	return prefix.join("/");
}

function formatSummary(
	summary: UnusedExportsSummary,
	scannedFiles: number,
	truncated: boolean,
	packageWarnings: PackageExportWarning[],
): string {
	if (summary.total === 0) {
		return `No unused exports found.\nScanned files: ${scannedFiles}\nTruncated: ${truncated}`;
	}

	const prefix = commonDirectoryPrefix(
		summary.byDirectory.map((d) => d.directory),
	);
	const strip = (dir: string): string => {
		if (!prefix) return dir;
		const rest = dir.slice(prefix.length).replace(/^\//, "");
		return rest === "" ? "." : rest;
	};

	const topDirs = summary.byDirectory.slice(0, SUMMARY_TOP_DIRECTORIES);
	const dirLines = topDirs.map((d) => `  ${strip(d.directory)}: ${d.count}`);
	const hiddenDirs = summary.byDirectory.length - topDirs.length;

	const lines = [
		...formatPackageWarnings(packageWarnings),
		`Unused export summary (total ${summary.total}):`,
		`- Delete-safety: deletable (sameFileRefs=0) = ${summary.deletable}, unexport-only (sameFileRefs>=1) = ${summary.unexportOnly}`,
		`- Default exports (low confidence, verify each): ${summary.defaultExports}`,
		`- By kind: ${summary.byKind.map((k) => `${k.kind}=${k.count}`).join(", ")}`,
		`- By directory${prefix ? ` (root: ${prefix})` : ""}, top ${topDirs.length} of ${summary.byDirectory.length}:`,
		...dirLines,
	];
	if (hiddenDirs > 0) {
		lines.push(`  ... and ${hiddenDirs} more directories`);
	}
	lines.push(
		"",
		'Re-run with responseFormat="list" (optionally entryPoints/excludeFilePatterns to narrow) to get per-symbol locations.',
		`Scanned files: ${scannedFiles}`,
		`Truncated: ${truncated}`,
	);
	return lines.join("\n");
}

export function registerFindUnusedExportsTool(registry: ToolRegistry): void {
	registry.tool(
		"find_unused_exports",
		`[ts-morph] List exports that have no references outside their declaring file across the project. Read-only.

## When to use
- Hunting for dead code candidates after a refactor or migration.
- Auditing a module's surface area: which exports does nobody actually consume?
- Pre-deletion safety check before manually removing exports — combine with \`find_references\` to double-confirm.

## When NOT to use
- You want a single symbol's references — use \`find_references\`.
- Single-file unused locals — \`tsc --noUnusedLocals\` is faster.

## Detection scope
Reports:
- \`export function/class/const/let/var/enum/interface/type ...\` (inline export keyword)
- \`export default function/class ...\` and \`export default <Identifier>\`
- \`export = <Identifier>\` (CommonJS)

## Detection algorithm
For each candidate identifier, \`findReferencesAsNodes()\` is run and the following references are excluded before deciding "unused":
- References inside the SAME file as the declaration (internal use does not count).
- References inside any \`ExportDeclaration\` (pure re-export sites like \`export { x } from "./y"\` or \`export *\`). This means a symbol re-exported only via a barrel — with nothing actually consuming the barrel — IS reported as unused.
- References in \`node_modules\`.

If 0 references remain, the export is reported.

## Known limitations (this tool returns CANDIDATES, not verdicts)
Static analysis cannot see:
- Dynamic \`require()\` / \`import()\` resolved from runtime strings.
- File-system / convention based routing (Next.js \`page.tsx\`, Remix routes, etc.). Pass these as \`entryPoints\`.
- Symbols looked up via reflection or string keys.
- Pure local re-exports (\`export { x }\` without \`from\`) where \`x\` is declared by a separate \`const x = ...\` in the same file — this form is not enumerated.
- Mixed function + namespace declarations may be partially missed.
- **Workspace packages that publish built output**: in a monorepo, when a scanned package's \`package.json\` entry points (\`exports\` / \`main\` / \`module\` / \`types\`) resolve outside the scanned sources (e.g. \`"exports": { ".": "./dist/index.js" }\`), imports from OTHER workspace packages resolve to the built files (or node_modules) instead of the scanned sources. Every export of such a package is then reported unused even when it IS consumed — a systematic false positive. The tool detects this shape and prepends a ⚠ package-level warning to the result; treat all candidates from a warned package as low confidence. Workaround: point that package's \`exports\` at source files for analysis, or verify each candidate with \`find_references\` / \`textHits\`.

### Default exports are high false-positive
\`export default <Identifier>\` / \`export = <Identifier>\` (shown with the \`[default]\` tag) are prone to FALSE POSITIVES: \`findReferencesAsNodes\` runs on the local identifier and often fails to connect to \`import Foo from "./mod"\` default-import sites. A default export reported here with \`textHits\` well above 0 is almost certainly actually used. Treat \`[default]\` candidates as low confidence and always confirm with \`find_references\`.

Always verify a candidate with \`find_references\` before deletion.

## Options
- \`tsconfigPath\`: absolute path to \`tsconfig.json\`.
- \`entryPoints\`: list of absolute file paths whose exports should be skipped (treat as public API). Reference sites IN these files still count as "used" automatically.
- \`excludeFilePatterns\`: substrings; any file whose absolute path \`includes()\` a pattern is not scanned. Use this for test files (e.g. \`".test."\`), generated dirs, etc.
- \`maxResults\`: cap on number of reported entries. Default 100. When reached, scanning stops and \`truncated\` becomes true — narrow scope with the filters above and retry.

## Output modes (\`responseFormat\`)
- \`"list"\` (default): one line per candidate (format below).
- \`"summary"\`: aggregate counts for the WHOLE project — total, delete-safety split (deletable vs unexport-only), default-export count, and breakdowns by kind and by directory. On large repos the per-line list easily blows past the response size limit, so start with \`"summary"\` to see where dead code clusters, then narrow with \`entryPoints\` / \`excludeFilePatterns\` and switch to \`"list"\` for exact locations. (\`summary\` scans the whole project regardless of \`maxResults\`.)

## Result format (list mode)
A bullet list of candidates with file:line:column, symbol name, declaration kind, a \`[default]\` tag for default exports, \`textHits=N\`, and \`sameFileRefs=N\`.

### \`sameFileRefs\` — decides delete vs. unexport (read this first)
Every reported export is, by definition, unreferenced OUTSIDE its declaring file. \`sameFileRefs\` tells you whether it is still used INSIDE that file (declaration itself and re-export sites excluded), which determines the safe action:
- \`sameFileRefs=0\`: not used anywhere, including its own file → **truly dead, safe to delete the whole declaration** (combine with \`textHits=0\` for highest confidence).
- \`sameFileRefs=1+\`: used within its own file → **only the \`export\` keyword is unnecessary**. Remove \`export\`, but KEEP the declaration — deleting it breaks the in-file references.

Deleting every reported declaration blindly will break the build: the majority are often \`sameFileRefs=1+\` (over-exported but internally used).

### \`textHits\` — text-occurrence triage hint
\`textHits\` is the number of word-boundary occurrences of the export's name in OTHER source files (declaring file excluded — so it says nothing about same-file usage; use \`sameFileRefs\` for that):
- \`textHits=0\`: no OTHER file mentions the name. Does NOT by itself mean deletable — still check \`sameFileRefs\`.
- \`textHits=1+\`: the name appears as a string literal, JSX tag, dynamic \`import().then(m => m.X)\`, or comment. Verify with \`find_references\` before deleting. Short names (e.g. \`a\`, \`id\`) match incidentally — discount accordingly.

### ⚠ Package-level warnings
When a package that produced candidates publishes built output (see Known limitations), a ⚠ warnings block is prepended to the result (both list and summary modes) naming the package, its out-of-scan entry points, and how many candidates are affected. Those candidates are likely false positives.

Trailing line reports \`Scanned files: N\` and \`Truncated: bool\`.`,
		{
			tsconfigPath: z
				.string()
				.describe("Absolute path to the project's tsconfig.json."),
			entryPoints: z
				.array(z.string())
				.optional()
				.describe(
					"Absolute file paths to treat as public API. Exports declared here are skipped.",
				),
			excludeFilePatterns: z
				.array(z.string())
				.optional()
				.describe(
					"Substrings; files whose absolute path includes any of these are not scanned.",
				),
			maxResults: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Cap on reported entries (list mode). Default 100. Ignored intent in "summary" mode, which scans the whole project.',
				),
			responseFormat: z
				.enum(["list", "summary"])
				.optional()
				.default("list")
				.describe(
					'"list" (default): one line per candidate. "summary": aggregate counts (delete-safety / kind / directory) for the WHOLE project — use this first on large repos to avoid huge output, then narrow with entryPoints/excludeFilePatterns and switch to "list".',
				),
			expandNamespaceImports: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					"Default true. Inject synthetic named imports into files containing `import * as ns from \"./mod\"` so that exports of the target module register as 'used' even when consumed only via `{ ...ns }` spread or other escaping patterns. Set to false if you want raw findReferences semantics.",
				),
		},
		(args) => {
			const isSummary = args.responseFormat === "summary";
			const logArgs = {
				tsconfigPath: args.tsconfigPath,
				entryPoints: args.entryPoints,
				excludeFilePatterns: args.excludeFilePatterns,
				maxResults: args.maxResults,
				responseFormat: args.responseFormat,
				expandNamespaceImports: args.expandNamespaceImports,
			};

			return runTool("find_unused_exports", logArgs, () => {
				const project = initializeProject(args.tsconfigPath);
				// summary mode aims for a full picture, so use effectively unlimited results unless the user specifies otherwise.
				const effectiveMaxResults = isSummary
					? (args.maxResults ?? SUMMARY_SCAN_CAP)
					: args.maxResults;
				const result = findUnusedExports(project, {
					entryPoints: args.entryPoints,
					excludeFilePatterns: args.excludeFilePatterns,
					maxResults: effectiveMaxResults,
					expandNamespaceImports: args.expandNamespaceImports,
				});

				if (isSummary) {
					return {
						message: formatSummary(
							summarizeUnusedExports(result.unusedExports),
							result.scannedFiles,
							result.truncated,
							result.packageWarnings,
						),
						data: result,
					};
				}
				if (result.unusedExports.length === 0) {
					return {
						message: `No unused exports found.\nScanned files: ${result.scannedFiles}\nTruncated: ${result.truncated}`,
						data: result,
					};
				}
				const lines = [
					...formatPackageWarnings(result.packageWarnings),
					`Unused export candidates (${result.unusedExports.length}):`,
					...result.unusedExports.map(formatUnusedExport),
					"",
					`Scanned files: ${result.scannedFiles}`,
					`Truncated: ${result.truncated}`,
				];
				return { message: lines.join("\n"), data: result };
			});
		},
	);
}
