import { readFileSync } from "node:fs";
import {
	ToolParamsError,
	UnknownToolError,
	createToolRegistry,
} from "./tools/registry";
import { VERSION } from "./version";

/** Error in how the CLI was invoked (bad command, malformed params). Exit code 2. */
export class CliUsageError extends Error {}

const USAGE = `mcp-tsmorph-refactor — AST-accurate TypeScript/JavaScript refactoring CLI (ts-morph)

Usage:
  mcp-tsmorph-refactor list                     List available tools
  mcp-tsmorph-refactor describe <tool>          Show a tool's description and JSON input schema
  mcp-tsmorph-refactor call <tool> [options]    Run a tool once and print its result
  mcp-tsmorph-refactor --help | --version

Options for call:
  --params <json>        Tool parameters as a JSON object
  --params-file <path>   Read the JSON parameters from a file
  (no option)            Read the JSON parameters from stdin

The parameter JSON must match the tool's input schema (see \`describe <tool>\`).
All paths must be absolute.

Examples:
  mcp-tsmorph-refactor describe rename_symbol_by_tsmorph
  mcp-tsmorph-refactor call rename_symbol_by_tsmorph --params '{
    "tsconfigPath": "/abs/path/tsconfig.json",
    "targetFilePath": "/abs/path/src/utils.ts",
    "position": { "line": 1, "column": 17 },
    "symbolName": "calculateSum",
    "newName": "addNumbers",
    "dryRun": true
  }'

Exit codes: 0 = success, 1 = tool reported an error, 2 = usage error.
`;

/** Lists every registered tool as `name` + the first line of its description. */
export function listToolsText(): string {
	return createToolRegistry()
		.list()
		.map((tool) => {
			const summary = tool.description.split("\n")[0];
			return `${tool.name}\n    ${summary}`;
		})
		.join("\n");
}

/** Returns a tool's full description and JSON input schema. */
export function describeToolText(toolName: string): string {
	const registry = createToolRegistry();
	const tool = registry.list().find((t) => t.name === toolName);
	if (!tool) {
		throw new CliUsageError(
			new UnknownToolError(
				toolName,
				registry.list().map((t) => t.name),
			).message,
		);
	}
	return [
		`# ${tool.name}`,
		"",
		tool.description,
		"",
		"## Input schema (JSON)",
		"",
		JSON.stringify(registry.inputSchema(toolName), null, 2),
	].join("\n");
}

export interface CallOutcome {
	text: string;
	isError: boolean;
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
	return { text, isError: result.isError === true };
}

function parseParamsJson(
	source: string,
	origin: string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new CliUsageError(
			`Failed to parse ${origin} as JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new CliUsageError(`${origin} must be a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

/** Resolves the params for `call` from --params, --params-file, or stdin. */
function readCallParams(rest: string[]): Record<string, unknown> {
	let paramsJson: string | undefined;
	let paramsFile: string | undefined;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--params") {
			paramsJson = rest[++i];
			if (paramsJson === undefined) {
				throw new CliUsageError("--params requires a JSON argument.");
			}
		} else if (arg.startsWith("--params=")) {
			paramsJson = arg.slice("--params=".length);
		} else if (arg === "--params-file") {
			paramsFile = rest[++i];
			if (paramsFile === undefined) {
				throw new CliUsageError("--params-file requires a path argument.");
			}
		} else if (arg.startsWith("--params-file=")) {
			paramsFile = arg.slice("--params-file=".length);
		} else {
			throw new CliUsageError(`Unknown option for call: '${arg}'`);
		}
	}

	if (paramsJson !== undefined && paramsFile !== undefined) {
		throw new CliUsageError("Pass either --params or --params-file, not both.");
	}
	if (paramsJson !== undefined) {
		return parseParamsJson(paramsJson, "--params");
	}
	if (paramsFile !== undefined) {
		return parseParamsJson(
			readFileSync(paramsFile, "utf-8"),
			`params file '${paramsFile}'`,
		);
	}
	if (process.stdin.isTTY) {
		throw new CliUsageError(
			"No parameters given. Pass --params '<json>', --params-file <path>, or pipe JSON via stdin.",
		);
	}
	return parseParamsJson(readFileSync(0, "utf-8"), "stdin");
}

interface Writer {
	write(chunk: string): unknown;
}

/** Runs one CLI command and returns the process exit code. */
export async function runCli(
	argv: string[],
	out: Writer = process.stdout,
	err: Writer = process.stderr,
): Promise<number> {
	const [command, ...rest] = argv;

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
			case "list":
			case "list-tools":
				out.write(`${listToolsText()}\n`);
				return 0;
			case "describe": {
				const toolName = rest[0];
				if (!toolName) {
					throw new CliUsageError("describe requires a tool name.");
				}
				out.write(`${describeToolText(toolName)}\n`);
				return 0;
			}
			case "call": {
				const toolName = rest[0];
				if (!toolName || toolName.startsWith("-")) {
					throw new CliUsageError("call requires a tool name.");
				}
				const params = readCallParams(rest.slice(1));
				const outcome = await callToolOnce(toolName, params);
				out.write(`${outcome.text}\n`);
				return outcome.isError ? 1 : 0;
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
