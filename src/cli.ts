import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	CliUsageError,
	readBatchItems,
	readCallParams,
	readStdinDefault,
	type StdinReader,
} from "./cli/params.js";
import {
	installClaudeHook,
	installOpencodeHook,
	runHook,
	runPostHook,
	type SearchAnswerer,
} from "./cli/hook.js";
import {
	findNearestTsconfig,
	prepareParams,
	solutionReferences,
} from "./cli/paths.js";
import { probeAstGrep } from "./ast-grep/pattern-tools.js";
import { AGENT_SNIPPET, GUIDE, INIT_MARKER } from "./guide.js";
import {
	disableProjectCache,
	enableProjectCache,
} from "./ts-morph/_utils/ts-morph-project.js";
import {
	ToolParamsError,
	type ToolRegistry,
	UnknownToolError,
	createToolRegistry,
} from "./tools/registry.js";
import { VERSION } from "./version.js";

export { CliUsageError, parseStdinFileList } from "./cli/params.js";
export {
	findNearestTsconfig,
	prepareParams,
	resolvePathParams,
} from "./cli/paths.js";

const USAGE = `ts-surgeon — AST-accurate TypeScript/JavaScript refactoring CLI (ts-morph)

Usage:
  ts-surgeon list [--json]                List available tools
  ts-surgeon describe <tool> [--json]     Show a tool's description and JSON input schema
  ts-surgeon call <tool> [params]         Run a tool once and print its result
  ts-surgeon batch [options]              Run several tools in one process
  ts-surgeon guide                        Print the full agent guide
  ts-surgeon doctor                       Check the install: version, Node,
                                          resolved tsconfig, tool count, and
                                          ast-grep native binary status
                                          (exit 1 when something is broken)
  ts-surgeon init [--file <path>]         Add the agent snippet to AGENTS.md (or <path>);
                                          --claude-hook installs the guard into
                                          .claude/settings.json (Claude Code);
                                          --opencode-hook registers the guard plugin
                                          in opencode.json's "plugin" array
  ts-surgeon hook                         PreToolUse guard for agent harnesses: blocks
                                          sed/perl -i on TS/JS sources and recursive
                                          identifier searches (grep -r / rg / native
                                          Grep) with exit 2, telling the agent which
                                          ts-surgeon tool to use instead (--strict is
                                          a deprecated no-op; this is the one mode)
  ts-surgeon --help | --version

Params for call (flags win over JSON; both can be combined):
  --params <json>        Parameters as a JSON object
  --params-file <path>   Read the JSON parameters from a file
  (piped stdin)          Read the JSON parameters from stdin
  --<field> <value>      Set a single field: kebab-case maps to the schema's
                         camelCase (--target-file-path -> targetFilePath),
                         dots nest (--position.line 1), a flag with no value
                         is boolean true (--dry-run)
  --stdin-files          Read a newline-separated file list from stdin into
                         filePaths (non-source and missing paths are skipped),
                         e.g.: git diff --name-only | ts-surgeon call
                         organize_imports --stdin-files
  --git-changed          Set filePaths to the TS/JS files listed by
                         git diff --name-only (unstaged changes); no pipe
                         needed: ts-surgeon call organize_imports --git-changed
  --git-staged           Same, but for staged changes (git diff --staged)
  --all-projects         When tsconfigPath is a solution-style config (a
                         "references" array), run the tool once per referenced
                         project and merge the results. Read-only tools only
                         (search_pattern, find_references, find_unused_exports,
                         get_diagnostics)

Conveniences:
  - Relative paths are resolved against the current working directory.
  - tsconfigPath may be omitted; the nearest tsconfig.json above the target
    file (or the cwd) is discovered automatically.
  - --json prints a machine-readable result: { tool, status, data, message }.
  - Tool names accept dashes (rename-symbol) and legacy *_by_tsmorph aliases.

Batch: pass a JSON array of { "tool": "...", "params": { ... } } via --params,
--params-file, or stdin. Output is always JSON. Stops at the first failing
tool unless --continue-on-error is set. Operations share one parsed project
per tsconfig (fast; later ops see earlier results) — pass --fresh-project to
re-parse from disk for every operation instead.

Examples:
  ts-surgeon describe rename_symbol
  # position is optional when the declaration name is unambiguous in the file
  ts-surgeon call rename_symbol --target-file-path src/utils.ts \\
    --symbol-name calculateSum --new-name addNumbers --dry-run

Exit codes: 0 = success, 1 = tool reported an error, 2 = usage error.
`;

function toolSummaries(registry: ToolRegistry) {
	return registry.list().map((tool) => ({
		name: tool.name,
		summary: tool.description.split("\n")[0],
	}));
}

/** Lists every registered tool as `name` + the first line of its description. */
export function listToolsText(
	registry: ToolRegistry = createToolRegistry(),
): string {
	return toolSummaries(registry)
		.map(({ name, summary }) => `${name}\n    ${summary}`)
		.join("\n");
}

function describeTool(registry: ToolRegistry, toolName: string) {
	const tool = registry.get(toolName);
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: registry.inputSchema(tool.name),
	};
}

/** Returns a tool's full description and JSON input schema as markdown. */
export function describeToolText(
	toolName: string,
	registry: ToolRegistry = createToolRegistry(),
): string {
	const { name, description, inputSchema } = describeTool(registry, toolName);
	return [
		`# ${name}`,
		"",
		description,
		"",
		"## Input schema (JSON)",
		"",
		JSON.stringify(inputSchema, null, 2),
	].join("\n");
}

export interface CallOutcome {
	text: string;
	isError: boolean;
	data?: unknown;
}

/** Calls a single tool with the given parameters and returns its text result. */
export async function callToolOnce(
	toolName: string,
	params: Record<string, unknown>,
	registry: ToolRegistry = createToolRegistry(),
): Promise<CallOutcome> {
	const result = await registry.call(toolName, params);
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return { text, isError: result.isError === true, data: result.data };
}

function formatOutcomeJson(name: string, outcome: CallOutcome): object {
	return {
		tool: name,
		status: outcome.isError ? "error" : "success",
		data: outcome.data ?? null,
		message: outcome.text,
	};
}

interface Writer {
	write(chunk: string): unknown;
}

/**
 * Appends the agent snippet to an instructions file (AGENTS.md by default).
 * Idempotent: skips when the snippet's npx command is already present.
 */
function runInit(rest: string[], out: Writer): number {
	let file = "AGENTS.md";
	let claudeHook = false;
	let opencodeHook = false;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--file") {
			const next = rest[++i];
			if (next === undefined) {
				throw new CliUsageError("--file requires a path argument.");
			}
			file = next;
		} else if (rest[i].startsWith("--file=")) {
			file = rest[i].slice("--file=".length);
		} else if (rest[i] === "--claude-hook") {
			claudeHook = true;
		} else if (rest[i] === "--opencode-hook") {
			opencodeHook = true;
		} else {
			throw new CliUsageError(`Unknown option for init: '${rest[i]}'`);
		}
	}
	if (claudeHook) {
		installClaudeHook(process.cwd(), out);
	}
	if (opencodeHook) {
		installOpencodeHook(process.cwd(), out);
	}
	const target = path.resolve(process.cwd(), file);
	const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
	if (existing.includes(INIT_MARKER)) {
		out.write(`${target} already references ts-surgeon — nothing to do.\n`);
		return 0;
	}
	const separator =
		existing === "" || existing.endsWith("\n\n")
			? ""
			: existing.endsWith("\n")
				? "\n"
				: "\n\n";
	writeFileSync(target, `${existing}${separator}${AGENT_SNIPPET}`);
	out.write(`Added the ts-surgeon section to ${target}.\n`);
	return 0;
}

/**
 * Tools --all-projects may fan out: read-only ones. A mutating tool run once
 * per referenced project would edit files shared between projects once per
 * project — until that has a dedupe story, aggregation stays read-only.
 */
const ALL_PROJECTS_TOOLS = new Set([
	"search_pattern",
	"find_references",
	"find_unused_exports",
	"get_diagnostics",
]);

/**
 * `call <tool> --all-projects` — runs a read-only tool once per referenced
 * project of a solution-style tsconfig and merges the results (data gains
 * byProject). Exit 1 if any project's run reported an error.
 */
async function runAllProjects(
	registry: ToolRegistry,
	toolName: string,
	prepared: Record<string, unknown>,
	references: string[],
	wantsJson: boolean,
	out: Writer,
	err: Writer,
): Promise<number> {
	if (!ALL_PROJECTS_TOOLS.has(toolName)) {
		throw new CliUsageError(
			`--all-projects supports read-only tools only (${[...ALL_PROJECTS_TOOLS].join(", ")}). '${toolName}' mutates files — a file shared between referenced projects would be edited once per project.`,
		);
	}
	if (references.length === 0) {
		throw new CliUsageError(
			`--all-projects: ${String(prepared.tsconfigPath)} has no "references" array — it is not a solution-style tsconfig.`,
		);
	}
	const existing = references.filter((ref) => existsSync(ref));
	const skipped = references.filter((ref) => !existsSync(ref));
	if (existing.length === 0) {
		throw new CliUsageError(
			`--all-projects: none of the referenced tsconfigs exist on disk:\n  ${references.join("\n  ")}`,
		);
	}
	for (const ref of skipped) {
		err.write(`Warning: skipping missing referenced tsconfig ${ref}\n`);
	}

	const byProject: Array<{
		tsconfigPath: string;
		status: string;
		data: unknown;
		message: string;
	}> = [];
	let anyError = false;
	for (const refPath of existing) {
		const outcome = await callToolOnce(
			toolName,
			{ ...prepared, tsconfigPath: refPath },
			registry,
		);
		anyError = anyError || outcome.isError;
		byProject.push({
			tsconfigPath: refPath,
			status: outcome.isError ? "error" : "success",
			data: outcome.data ?? null,
			message: outcome.text,
		});
	}

	// One message and one { tool, status, data, message } envelope — the same
	// shape every other `call` emits, with the per-project detail under data.
	const message = byProject
		.map((entry) => `## ${entry.tsconfigPath}\n${entry.message}`)
		.join("\n\n");
	if (wantsJson) {
		out.write(
			`${JSON.stringify(
				{
					tool: toolName,
					status: anyError ? "error" : "success",
					data: { byProject },
					message,
				},
				null,
				2,
			)}\n`,
		);
	} else {
		out.write(`${message}\n`);
	}
	return anyError ? 1 : 0;
}

/**
 * `ts-surgeon doctor` — prints the environment facts a bug report needs and
 * exits 1 when part of the install is broken (currently: the ast-grep native
 * binary, without which search_pattern / rewrite_pattern cannot run).
 */
async function runDoctor(out: Writer, cwd: string): Promise<number> {
	const registry = createToolRegistry();
	const tsconfig = findNearestTsconfig(cwd);
	const astGrep = await probeAstGrep();
	const lines = [
		`ts-surgeon version: ${VERSION}`,
		`Node: ${process.version} (${process.platform}-${process.arch})`,
		`Registered tools: ${registry.list().length}`,
		`Resolved tsconfig: ${tsconfig ?? "(none found above the current directory)"}`,
		`ast-grep native binary: ${astGrep.ok ? "ok" : `FAILED — ${astGrep.error}`}`,
	];
	out.write(`${lines.join("\n")}\n`);
	if (!astGrep.ok) {
		out.write(
			"\nsearch_pattern / rewrite_pattern are unavailable; the other tools work.\n",
		);
		return 1;
	}
	return 0;
}

/** Runs one CLI command and returns the process exit code. */
export async function runCli(
	argv: string[],
	out: Writer = process.stdout,
	err: Writer = process.stderr,
	opts: {
		readStdin?: StdinReader;
		cwd?: string;
		/** Test seam for `hook`: overrides how identifier searches are answered. */
		answerSearch?: SearchAnswerer;
	} = {},
): Promise<number> {
	const [command, ...rawRest] = argv;
	// --json is a global output-mode flag, valid in any position of any command.
	const wantsJson = rawRest.includes("--json");
	const rest = rawRest.filter((arg) => arg !== "--json");
	const readStdin = opts.readStdin ?? readStdinDefault;
	const cwd = opts.cwd ?? process.cwd();

	try {
		switch (command) {
			case undefined:
				out.write(USAGE);
				return 2;
			case "help":
			case "--help":
			case "-h":
				out.write(USAGE);
				return 0;
			case "--version":
			case "-v":
				out.write(`${VERSION}\n`);
				return 0;
			case "guide":
				out.write(GUIDE);
				return 0;
			case "doctor":
				return runDoctor(out, cwd);
			case "init":
				return runInit(rest, out);
			case "hook":
				if (rest.includes("--post")) {
					return runPostHook(readStdin, out);
				}
				// An undefined answerSearch falls through to runHook's default.
				return runHook(rest, readStdin, err, opts.answerSearch);
			case "list":
			case "list-tools": {
				const registry = createToolRegistry();
				out.write(
					wantsJson
						? `${JSON.stringify(toolSummaries(registry), null, 2)}\n`
						: `${listToolsText(registry)}\n`,
				);
				return 0;
			}
			case "describe": {
				const toolName = rest[0];
				if (!toolName || toolName.startsWith("-")) {
					throw new CliUsageError("describe requires a tool name.");
				}
				const registry = createToolRegistry();
				out.write(
					wantsJson
						? `${JSON.stringify(describeTool(registry, toolName), null, 2)}\n`
						: `${describeToolText(toolName, registry)}\n`,
				);
				return 0;
			}
			case "call": {
				const toolName = rest[0];
				if (!toolName || toolName.startsWith("-")) {
					throw new CliUsageError("call requires a tool name.");
				}
				const registry = createToolRegistry();
				const tool = registry.get(toolName);
				const allProjects = rest.includes("--all-projects");
				const params = readCallParams(
					rest.slice(1).filter((arg) => arg !== "--all-projects"),
					readStdin,
					tool.schemaShape,
					cwd,
				);
				const prepared = prepareParams(params, cwd);
				const references =
					typeof prepared.tsconfigPath === "string"
						? solutionReferences(prepared.tsconfigPath)
						: [];
				if (allProjects) {
					// awaited so a CliUsageError rejection lands in this try/catch
					return await runAllProjects(
						registry,
						tool.name,
						prepared,
						references,
						wantsJson,
						out,
						err,
					);
				}
				if (references.length > 0) {
					// A solution-style config often contains no source files itself, so
					// the tool would silently see a partial (or empty) project.
					err.write(
						`Warning: ${String(prepared.tsconfigPath)} is a solution-style tsconfig ("references" with ${references.length} project(s)). Pass a leaf tsconfig (e.g. ${references[0]}) or add --all-projects to run a read-only tool across every referenced project.\n`,
					);
				}
				const outcome = await callToolOnce(tool.name, prepared, registry);
				out.write(
					wantsJson
						? `${JSON.stringify(formatOutcomeJson(tool.name, outcome), null, 2)}\n`
						: `${outcome.text}\n`,
				);
				return outcome.isError ? 1 : 0;
			}
			case "batch": {
				const { items, continueOnError, freshProject } = readBatchItems(
					rest,
					readStdin,
				);
				const registry = createToolRegistry();
				const results: object[] = [];
				let anyError = false;
				// Share one parsed Project per tsconfig across the batch: each op
				// saves to disk, so later ops see earlier results. The cache itself
				// refuses to reuse a project with unsaved mutations (dry runs,
				// failed ops), so no invalidation bookkeeping is needed here.
				if (!freshProject) {
					enableProjectCache();
				}
				try {
					for (const item of items) {
						const name = registry.resolveName(item.tool);
						const outcome = await callToolOnce(
							name,
							prepareParams(item.params ?? {}, cwd),
							registry,
						);
						results.push(formatOutcomeJson(name, outcome));
						if (outcome.isError) {
							anyError = true;
							if (!continueOnError) {
								break;
							}
						}
					}
				} finally {
					disableProjectCache();
				}
				out.write(`${JSON.stringify(results, null, 2)}\n`);
				return anyError ? 1 : 0;
			}
			default:
				throw new CliUsageError(`Unknown command '${command}'.\n\n${USAGE}`);
		}
	} catch (error) {
		if (
			error instanceof CliUsageError ||
			error instanceof ToolParamsError ||
			error instanceof UnknownToolError
		) {
			err.write(`${error.message}\n`);
			return 2;
		}
		err.write(
			`Error: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}
