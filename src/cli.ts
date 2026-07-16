import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	CliUsageError,
	readBatchItems,
	readCallParams,
	readStdinDefault,
	type StdinReader,
} from "./cli/params";
import { prepareParams } from "./cli/paths";
import { AGENT_SNIPPET, GUIDE, INIT_MARKER } from "./guide";
import {
	disableProjectCache,
	enableProjectCache,
} from "./ts-morph/_utils/ts-morph-project";
import {
	ToolParamsError,
	type ToolRegistry,
	UnknownToolError,
	createToolRegistry,
} from "./tools/registry";
import { VERSION } from "./version";

export { CliUsageError, parseStdinFileList } from "./cli/params";
export {
	findNearestTsconfig,
	prepareParams,
	resolvePathParams,
} from "./cli/paths";

const USAGE = `tsmorph-refactor — AST-accurate TypeScript/JavaScript refactoring CLI (ts-morph)

Usage:
  tsmorph-refactor list [--json]                List available tools
  tsmorph-refactor describe <tool> [--json]     Show a tool's description and JSON input schema
  tsmorph-refactor call <tool> [params]         Run a tool once and print its result
  tsmorph-refactor batch [options]              Run several tools in one process
  tsmorph-refactor guide                        Print the full agent guide
  tsmorph-refactor init [--file <path>]         Add the agent snippet to AGENTS.md (or <path>)
  tsmorph-refactor --help | --version

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
                         e.g.: git diff --name-only | tsmorph-refactor call
                         organize_imports --stdin-files

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
  tsmorph-refactor describe rename_symbol
  # position is optional when the declaration name is unambiguous in the file
  tsmorph-refactor call rename_symbol --target-file-path src/utils.ts \\
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
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--file") {
			const next = rest[++i];
			if (next === undefined) {
				throw new CliUsageError("--file requires a path argument.");
			}
			file = next;
		} else if (rest[i].startsWith("--file=")) {
			file = rest[i].slice("--file=".length);
		} else {
			throw new CliUsageError(`Unknown option for init: '${rest[i]}'`);
		}
	}
	const target = path.resolve(process.cwd(), file);
	const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
	if (existing.includes(INIT_MARKER)) {
		out.write(
			`${target} already references tsmorph-refactor — nothing to do.\n`,
		);
		return 0;
	}
	const separator =
		existing === "" || existing.endsWith("\n\n")
			? ""
			: existing.endsWith("\n")
				? "\n"
				: "\n\n";
	writeFileSync(target, `${existing}${separator}${AGENT_SNIPPET}`);
	out.write(`Added the tsmorph-refactor section to ${target}.\n`);
	return 0;
}

/** Runs one CLI command and returns the process exit code. */
export async function runCli(
	argv: string[],
	out: Writer = process.stdout,
	err: Writer = process.stderr,
	opts: { readStdin?: StdinReader } = {},
): Promise<number> {
	const [command, ...rawRest] = argv;
	// --json is a global output-mode flag, valid in any position of any command.
	const wantsJson = rawRest.includes("--json");
	const rest = rawRest.filter((arg) => arg !== "--json");
	const readStdin = opts.readStdin ?? readStdinDefault;

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
			case "init":
				return runInit(rest, out);
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
				const params = readCallParams(
					rest.slice(1),
					readStdin,
					tool.schemaShape,
				);
				const outcome = await callToolOnce(
					tool.name,
					prepareParams(params),
					registry,
				);
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
							prepareParams(item.params ?? {}),
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
