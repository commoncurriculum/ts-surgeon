import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { GUIDE } from "./guide";
import {
	disableProjectCache,
	enableProjectCache,
	invalidateProjectCache,
} from "./ts-morph/_utils/ts-morph-project";
import {
	ToolParamsError,
	UnknownToolError,
	createToolRegistry,
} from "./tools/registry";
import { VERSION } from "./version";

/** Error in how the CLI was invoked (bad command, malformed params). Exit code 2. */
export class CliUsageError extends Error {}

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

interface ToolSummary {
	name: string;
	summary: string;
}

function toolSummaries(): ToolSummary[] {
	return createToolRegistry()
		.list()
		.map((tool) => ({
			name: tool.name,
			summary: tool.description.split("\n")[0],
		}));
}

/** Lists every registered tool as `name` + the first line of its description. */
export function listToolsText(): string {
	return toolSummaries()
		.map(({ name, summary }) => `${name}\n    ${summary}`)
		.join("\n");
}

/** Returns a tool's full description and JSON input schema. */
export function describeToolText(toolName: string): string {
	const registry = createToolRegistry();
	const name = registry.resolveName(toolName);
	const tool = registry.list().find((t) => t.name === name);
	if (!tool) {
		throw new UnknownToolError(
			toolName,
			registry.list().map((t) => t.name),
		);
	}
	return [
		`# ${tool.name}`,
		"",
		tool.description,
		"",
		"## Input schema (JSON)",
		"",
		JSON.stringify(registry.inputSchema(name), null, 2),
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
): Promise<CallOutcome> {
	const result = await createToolRegistry().call(toolName, params);
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return { text, isError: result.isError === true, data: result.data };
}

/** Keys whose string values are filesystem paths to resolve against cwd. */
function isPathKey(key: string): boolean {
	return /paths?$/i.test(key) || key === "entryPoints";
}

/**
 * Resolves every relative path in the params against `cwd`, recursively
 * (covers nested shapes like renames[].oldPath). Glob-pattern fields
 * (e.g. excludeFilePatterns) are left untouched.
 */
export function resolvePathParams(value: unknown, cwd: string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => resolvePathParams(item, cwd));
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		if (isPathKey(key) && typeof v === "string") {
			out[key] = path.resolve(cwd, v);
		} else if (
			isPathKey(key) &&
			Array.isArray(v) &&
			v.every((item) => typeof item === "string")
		) {
			out[key] = v.map((item) => path.resolve(cwd, item));
		} else {
			out[key] = resolvePathParams(v, cwd);
		}
	}
	return out;
}

/** Walks up from `startDir` to find the nearest tsconfig.json. */
export function findNearestTsconfig(startDir: string): string | undefined {
	let dir = path.resolve(startDir);
	for (;;) {
		const candidate = path.join(dir, "tsconfig.json");
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/** Picks the directory tsconfig discovery should start from. */
function tsconfigSearchStart(
	params: Record<string, unknown>,
	cwd: string,
): string {
	const fileHint =
		params.targetFilePath ??
		params.originalFilePath ??
		params.targetPath ??
		(Array.isArray(params.filePaths) ? params.filePaths[0] : undefined) ??
		(Array.isArray(params.renames)
			? (params.renames[0] as Record<string, unknown> | undefined)?.oldPath
			: undefined);
	return typeof fileHint === "string" ? path.dirname(fileHint) : cwd;
}

/**
 * Prepares raw params for a tool call: resolves relative paths against cwd
 * and fills in tsconfigPath from the nearest tsconfig.json when omitted.
 */
export function prepareParams(
	raw: Record<string, unknown>,
	cwd: string = process.cwd(),
): Record<string, unknown> {
	const resolved = resolvePathParams(raw, cwd) as Record<string, unknown>;
	if (resolved.tsconfigPath === undefined) {
		const found = findNearestTsconfig(tsconfigSearchStart(resolved, cwd));
		if (found) {
			resolved.tsconfigPath = found;
		}
	}
	return resolved;
}

const SOURCE_FILE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/**
 * Parses a newline-separated file list (e.g. `git diff --name-only`) into
 * absolute paths, keeping only TS/JS source files that exist on disk.
 */
export function parseStdinFileList(text: string, cwd: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && SOURCE_FILE_RE.test(line))
		.map((line) => path.resolve(cwd, line))
		.filter((file) => existsSync(file));
}

type StdinReader = () => string;

const readStdinDefault: StdinReader = () => readFileSync(0, "utf-8");

function parseParamsJson(source: string, origin: string): unknown {
	try {
		return JSON.parse(source);
	} catch (error) {
		throw new CliUsageError(
			`Failed to parse ${origin} as JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function asParamsObject(
	parsed: unknown,
	origin: string,
): Record<string, unknown> {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new CliUsageError(`${origin} must be a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function kebabToCamel(key: string): string {
	return key.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Coerces a flag value: JSON where it clearly is JSON, raw string otherwise. */
function coerceFlagValue(raw: string): unknown {
	if (/^(-?\d+(\.\d+)?|true|false|null|\{.*\}|\[.*\])$/s.test(raw.trim())) {
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	}
	return raw;
}

/** Sets a dot-path key (e.g. "position.line") on a params object. */
function setDotPath(
	target: Record<string, unknown>,
	dotKey: string,
	value: unknown,
): void {
	const segments = dotKey.split(".").map(kebabToCamel);
	let node = target;
	for (const segment of segments.slice(0, -1)) {
		const existing = node[segment];
		if (existing === null || typeof existing !== "object") {
			node[segment] = {};
		}
		node = node[segment] as Record<string, unknown>;
	}
	node[segments.at(-1) as string] = value;
}

interface ParsedCallArgs {
	json: boolean;
	params: Record<string, unknown>;
}

/**
 * Parses `call` arguments: --params/--params-file/stdin JSON as the base,
 * with individual --field flags merged on top.
 */
function readCallParams(
	rest: string[],
	readStdin: StdinReader,
): ParsedCallArgs {
	let paramsJson: string | undefined;
	let paramsFile: string | undefined;
	let json = false;
	let stdinFiles = false;
	const flagParams: Record<string, unknown> = {};
	let sawFieldFlags = false;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (!arg.startsWith("--")) {
			throw new CliUsageError(`Unexpected argument '${arg}'.`);
		}
		const eq = arg.indexOf("=");
		const flagName = (eq === -1 ? arg : arg.slice(0, eq)).slice(2);
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

		const takeValue = (): string => {
			if (inlineValue !== undefined) {
				return inlineValue;
			}
			const next = rest[++i];
			if (next === undefined) {
				throw new CliUsageError(`--${flagName} requires a value.`);
			}
			return next;
		};

		switch (flagName) {
			case "params":
				paramsJson = takeValue();
				break;
			case "params-file":
				paramsFile = takeValue();
				break;
			case "json":
				json = true;
				break;
			case "stdin-files":
				stdinFiles = true;
				break;
			default: {
				sawFieldFlags = true;
				const hasValue =
					inlineValue !== undefined ||
					(rest[i + 1] !== undefined && !rest[i + 1].startsWith("--"));
				const value = hasValue ? coerceFlagValue(takeValue()) : true;
				setDotPath(flagParams, flagName, value);
			}
		}
	}

	if (paramsJson !== undefined && paramsFile !== undefined) {
		throw new CliUsageError("Pass either --params or --params-file, not both.");
	}

	let base: Record<string, unknown> = {};
	if (paramsJson !== undefined) {
		base = asParamsObject(parseParamsJson(paramsJson, "--params"), "--params");
	} else if (paramsFile !== undefined) {
		base = asParamsObject(
			parseParamsJson(
				readFileSync(paramsFile, "utf-8"),
				`params file '${paramsFile}'`,
			),
			`params file '${paramsFile}'`,
		);
	} else if (!sawFieldFlags && !stdinFiles) {
		if (process.stdin.isTTY) {
			throw new CliUsageError(
				"No parameters given. Pass --<field> flags, --params '<json>', --params-file <path>, or pipe JSON via stdin.",
			);
		}
		base = asParamsObject(parseParamsJson(readStdin(), "stdin"), "stdin");
	}

	const params = { ...base, ...flagParams };
	if (stdinFiles) {
		const files = parseStdinFileList(readStdin(), process.cwd());
		if (files.length === 0) {
			throw new CliUsageError(
				"--stdin-files: no existing TS/JS source files found on stdin. Refusing to run without filePaths (that would process the whole project).",
			);
		}
		params.filePaths = files;
	}
	return { json, params };
}

interface BatchItem {
	tool: string;
	params?: Record<string, unknown>;
}

function readBatchItems(
	rest: string[],
	readStdin: StdinReader,
): {
	items: BatchItem[];
	continueOnError: boolean;
	freshProject: boolean;
} {
	let source: string | undefined;
	let origin = "stdin";
	let continueOnError = false;
	let freshProject = false;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--continue-on-error") {
			continueOnError = true;
		} else if (arg === "--fresh-project") {
			freshProject = true;
		} else if (arg === "--params") {
			source = rest[++i];
			origin = "--params";
		} else if (arg === "--params-file") {
			const file = rest[++i];
			if (file === undefined) {
				throw new CliUsageError("--params-file requires a path argument.");
			}
			source = readFileSync(file, "utf-8");
			origin = `params file '${file}'`;
		} else if (arg === "--json") {
			// batch output is always JSON; accept the flag for symmetry
		} else {
			throw new CliUsageError(`Unknown option for batch: '${arg}'`);
		}
	}

	if (source === undefined) {
		if (process.stdin.isTTY) {
			throw new CliUsageError(
				"batch needs a JSON array of { tool, params } via --params, --params-file, or stdin.",
			);
		}
		source = readStdin();
	}

	const parsed = parseParamsJson(source, origin);
	if (!Array.isArray(parsed)) {
		throw new CliUsageError(`${origin} must be a JSON array for batch.`);
	}
	const items = parsed.map((item, index) => {
		if (
			item === null ||
			typeof item !== "object" ||
			typeof (item as BatchItem).tool !== "string"
		) {
			throw new CliUsageError(
				`batch item ${index} must be an object with a "tool" string.`,
			);
		}
		return item as BatchItem;
	});
	return { items, continueOnError, freshProject };
}

const AGENT_SNIPPET = `## Refactoring (tsmorph-refactor)

For TypeScript/JavaScript refactors that cross file boundaries (renames, moves,
signature changes, finding references, dead-code checks), do not hand-edit.
Use the ts-morph refactoring CLI:

    npx -y @commoncurriculum/tsmorph-refactor guide   # read this first
    npx -y @commoncurriculum/tsmorph-refactor list    # tool names + summaries
`;

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
	if (existing.includes("@commoncurriculum/tsmorph-refactor guide")) {
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

interface Writer {
	write(chunk: string): unknown;
}

/** Runs one CLI command and returns the process exit code. */
export async function runCli(
	argv: string[],
	out: Writer = process.stdout,
	err: Writer = process.stderr,
	opts: { readStdin?: StdinReader } = {},
): Promise<number> {
	const [command, ...rest] = argv;
	const wantsJson = rest.includes("--json");
	const readStdin = opts.readStdin ?? readStdinDefault;

	try {
		switch (command) {
			case undefined:
			case "help":
			case "--help":
			case "-h":
				out.write(USAGE);
				return command === undefined ? 2 : 0;
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
			case "list-tools":
				out.write(
					wantsJson
						? `${JSON.stringify(toolSummaries(), null, 2)}\n`
						: `${listToolsText()}\n`,
				);
				return 0;
			case "describe": {
				const toolName = rest.find((arg) => !arg.startsWith("-"));
				if (!toolName) {
					throw new CliUsageError("describe requires a tool name.");
				}
				if (wantsJson) {
					const registry = createToolRegistry();
					const name = registry.resolveName(toolName);
					const tool = registry.list().find((t) => t.name === name);
					out.write(
						`${JSON.stringify(
							{
								name,
								description: tool?.description,
								inputSchema: registry.inputSchema(name),
							},
							null,
							2,
						)}\n`,
					);
				} else {
					out.write(`${describeToolText(toolName)}\n`);
				}
				return 0;
			}
			case "call": {
				const toolName = rest[0];
				if (!toolName || toolName.startsWith("-")) {
					throw new CliUsageError("call requires a tool name.");
				}
				const { json, params } = readCallParams(rest.slice(1), readStdin);
				const registry = createToolRegistry();
				const name = registry.resolveName(toolName);
				const outcome = await callToolOnce(name, prepareParams(params));
				if (json) {
					out.write(
						`${JSON.stringify(
							{
								tool: name,
								status: outcome.isError ? "error" : "success",
								data: outcome.data ?? null,
								message: outcome.text,
							},
							null,
							2,
						)}\n`,
					);
				} else {
					out.write(`${outcome.text}\n`);
				}
				return outcome.isError ? 1 : 0;
			}
			case "batch": {
				const { items, continueOnError, freshProject } = readBatchItems(
					rest,
					readStdin,
				);
				const registry = createToolRegistry();
				const results: Array<Record<string, unknown>> = [];
				let anyError = false;
				// Share one parsed Project per tsconfig across the batch (each op
				// still saves to disk, so later ops see earlier results). A dry run
				// or a failed op may leave the in-memory AST out of sync with the
				// filesystem, so the cache is dropped after those.
				if (!freshProject) {
					enableProjectCache();
				}
				try {
					for (const item of items) {
						const name = registry.resolveName(item.tool);
						const params = prepareParams(item.params ?? {});
						const outcome = await callToolOnce(name, params);
						results.push({
							tool: name,
							status: outcome.isError ? "error" : "success",
							data: outcome.data ?? null,
							message: outcome.text,
						});
						if (outcome.isError || params.dryRun === true) {
							invalidateProjectCache();
						}
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
