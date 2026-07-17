import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";

/** Error in how the CLI was invoked (bad command, malformed params). Exit code 2. */
export class CliUsageError extends Error {}

export type StdinReader = () => string;

export const readStdinDefault: StdinReader = () => readFileSync(0, "utf-8");

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

type FlagType = "string" | "number" | "boolean" | "json";

/** Strips optional/default/nullable/effects (refine) wrappers off a Zod schema. */
function unwrapSchema(schema: ZodTypeAny | undefined): ZodTypeAny | undefined {
	let current = schema;
	for (;;) {
		if (
			current instanceof z.ZodOptional ||
			current instanceof z.ZodDefault ||
			current instanceof z.ZodNullable
		) {
			current = (current._def as { innerType: ZodTypeAny }).innerType;
		} else if (current instanceof z.ZodEffects) {
			current = current.innerType();
		} else {
			return current;
		}
	}
}

/**
 * Looks up what a flag's dot-path points at in the tool's schema, so the raw
 * string can be converted to what the field actually expects — `--symbol-name
 * 123` stays a string while `--position.line 1` becomes a number.
 */
function expectedTypeAt(shape: ZodRawShape, segments: string[]): FlagType {
	let current: ZodTypeAny | undefined = shape[segments[0]];
	for (const segment of segments.slice(1)) {
		const unwrapped = unwrapSchema(current);
		if (!(unwrapped instanceof z.ZodObject)) {
			return "json";
		}
		current = (unwrapped.shape as ZodRawShape)[segment];
	}
	const unwrapped = unwrapSchema(current);
	if (unwrapped instanceof z.ZodString || unwrapped instanceof z.ZodEnum) {
		return "string";
	}
	if (unwrapped instanceof z.ZodNumber) {
		return "number";
	}
	if (unwrapped instanceof z.ZodBoolean) {
		return "boolean";
	}
	// arrays, objects, unions, and fields the schema doesn't know
	return "json";
}

function convertFlagValue(raw: string, expected: FlagType): unknown {
	switch (expected) {
		case "string":
			return raw;
		case "number": {
			const parsed = Number(raw);
			return Number.isNaN(parsed) ? raw : parsed;
		}
		case "boolean":
			return raw === "true" ? true : raw === "false" ? false : raw;
		case "json":
			try {
				return JSON.parse(raw);
			} catch {
				return raw;
			}
	}
}

/** Sets a value at a (camelCased) segment path on a params object. */
function setSegmentPath(
	target: Record<string, unknown>,
	segments: string[],
	value: unknown,
): void {
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

/** Resolves --params / --params-file / piped stdin into a JSON source string. */
function readJsonSource(
	inline: string | undefined,
	file: string | undefined,
	readStdin: StdinReader,
	stdinAllowed: boolean,
): { source: string; origin: string } | undefined {
	if (inline !== undefined && file !== undefined) {
		throw new CliUsageError("Pass either --params or --params-file, not both.");
	}
	if (inline !== undefined) {
		return { source: inline, origin: "--params" };
	}
	if (file !== undefined) {
		return {
			source: readFileSync(file, "utf-8"),
			origin: `params file '${file}'`,
		};
	}
	if (stdinAllowed && !process.stdin.isTTY) {
		return { source: readStdin(), origin: "stdin" };
	}
	return undefined;
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

/**
 * Runs `git diff --name-only [--staged]` and returns the listed paths,
 * resolved and filtered like a --stdin-files list. Sugar over the
 * `git diff --name-only | ts-surgeon call <tool> --stdin-files` pipe.
 */
function gitDiffFileList(staged: boolean, cwd: string): string[] {
	const flag = staged ? "--git-staged" : "--git-changed";
	const run = (args: string[]) =>
		spawnSync("git", args, { cwd, encoding: "utf-8" });
	// Also the "are we in a git repo" check; diff paths are repo-root-relative.
	const top = run(["rev-parse", "--show-toplevel"]);
	if (top.error || top.status !== 0) {
		const detail = top.error?.message ?? top.stderr?.trim();
		throw new CliUsageError(
			`${flag}: not inside a git repository${detail ? ` (${detail})` : ""}.`,
		);
	}
	const diffArgs = ["diff", "--name-only"];
	if (staged) {
		diffArgs.push("--staged");
	}
	const diff = run(diffArgs);
	if (diff.error || diff.status !== 0) {
		const detail = diff.error?.message ?? diff.stderr?.trim();
		throw new CliUsageError(
			`${flag}: git diff failed${detail ? `: ${detail}` : ""}.`,
		);
	}
	return parseStdinFileList(diff.stdout, top.stdout.trim());
}

/**
 * Parses `call` arguments: --params/--params-file/stdin JSON as the base,
 * with individual --field flags (converted per the tool's schema) merged on
 * top, and --stdin-files / --git-changed / --git-staged turned into filePaths.
 */
export function readCallParams(
	rest: string[],
	readStdin: StdinReader,
	schemaShape: ZodRawShape,
	cwd: string = process.cwd(),
): Record<string, unknown> {
	let paramsJson: string | undefined;
	let paramsFile: string | undefined;
	let stdinFiles = false;
	let gitChanged = false;
	let gitStaged = false;
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
			case "stdin-files":
				stdinFiles = true;
				break;
			case "git-changed":
				gitChanged = true;
				break;
			case "git-staged":
				gitStaged = true;
				break;
			default: {
				sawFieldFlags = true;
				const segments = flagName.split(".").map(kebabToCamel);
				const hasValue =
					inlineValue !== undefined ||
					(rest[i + 1] !== undefined && !rest[i + 1].startsWith("--"));
				const value = hasValue
					? convertFlagValue(takeValue(), expectedTypeAt(schemaShape, segments))
					: true;
				setSegmentPath(flagParams, segments, value);
			}
		}
	}

	const fileListFlags = [
		stdinFiles && "--stdin-files",
		gitChanged && "--git-changed",
		gitStaged && "--git-staged",
	].filter((flag): flag is string => typeof flag === "string");
	if (fileListFlags.length > 1) {
		throw new CliUsageError(
			`Pass at most one of --stdin-files, --git-changed, --git-staged (got ${fileListFlags.join(" and ")}).`,
		);
	}

	// When --stdin-files is set, stdin carries the file list, not params JSON;
	// with a git flag the file list needs no stdin at all (use --params/--params-file
	// for extra parameters).
	const jsonSource = readJsonSource(
		paramsJson,
		paramsFile,
		readStdin,
		fileListFlags.length === 0 && !sawFieldFlags,
	);
	if (
		jsonSource === undefined &&
		!sawFieldFlags &&
		fileListFlags.length === 0
	) {
		throw new CliUsageError(
			"No parameters given. Pass --<field> flags, --params '<json>', --params-file <path>, or pipe JSON via stdin.",
		);
	}
	const base = jsonSource
		? asParamsObject(
				parseParamsJson(jsonSource.source, jsonSource.origin),
				jsonSource.origin,
			)
		: {};

	const params = { ...base, ...flagParams };
	if (stdinFiles) {
		const files = parseStdinFileList(readStdin(), cwd);
		if (files.length === 0) {
			throw new CliUsageError(
				"--stdin-files: no existing TS/JS source files found on stdin. Refusing to run without filePaths (that would process the whole project).",
			);
		}
		params.filePaths = files;
	} else if (gitChanged || gitStaged) {
		const files = gitDiffFileList(gitStaged, cwd);
		if (files.length === 0) {
			throw new CliUsageError(
				`${gitStaged ? "--git-staged" : "--git-changed"}: git diff --name-only${
					gitStaged ? " --staged" : ""
				} lists no existing TS/JS source files. Refusing to run without filePaths (that would process the whole project).`,
			);
		}
		params.filePaths = files;
	}
	return params;
}

export interface BatchItem {
	tool: string;
	params?: Record<string, unknown>;
}

export interface BatchOptions {
	items: BatchItem[];
	continueOnError: boolean;
	freshProject: boolean;
}

/** Parses `batch` arguments: option flags plus the JSON array of operations. */
export function readBatchItems(
	rest: string[],
	readStdin: StdinReader,
): BatchOptions {
	let paramsJson: string | undefined;
	let paramsFile: string | undefined;
	let continueOnError = false;
	let freshProject = false;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--continue-on-error") {
			continueOnError = true;
		} else if (arg === "--fresh-project") {
			freshProject = true;
		} else if (arg === "--params") {
			paramsJson = rest[++i];
		} else if (arg === "--params-file") {
			paramsFile = rest[++i];
			if (paramsFile === undefined) {
				throw new CliUsageError("--params-file requires a path argument.");
			}
		} else {
			throw new CliUsageError(`Unknown option for batch: '${arg}'`);
		}
	}

	const jsonSource = readJsonSource(paramsJson, paramsFile, readStdin, true);
	if (jsonSource === undefined) {
		throw new CliUsageError(
			"batch needs a JSON array of { tool, params } via --params, --params-file, or stdin.",
		);
	}
	const parsed = parseParamsJson(jsonSource.source, jsonSource.origin);
	if (!Array.isArray(parsed)) {
		throw new CliUsageError(
			`${jsonSource.origin} must be a JSON array for batch.`,
		);
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
