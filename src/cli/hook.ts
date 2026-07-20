import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { answerSearchViaCli, type SearchAnswerer } from "./guard/answer";
import { isInPlaceSourceEdit } from "./guard/edits";
import {
	ALLOW_MARKER,
	DYNAMIC_SEARCH_BLOCK_MESSAGE,
	EDIT_BLOCK_MESSAGE,
	INERT_PREFIX_NOTE,
	isOperatorAllowed,
} from "./guard/messages";
import { analyzePatterns } from "./guard/pattern-intent";
import {
	isExplicitFile,
	isNonSourcePath,
	resolveSearchScope,
	RG_SOURCE_TYPES,
	SOURCE_EXT_RE,
} from "./guard/scope";
import { parseSearchInvocation } from "./guard/search-invocation";
import { splitSimpleCommands } from "./guard/shell";
import { CliUsageError, type StdinReader } from "./params";

/**
 * PreToolUse guard for coding-agent harnesses (Claude Code hooks and
 * compatible). The harness pipes the pending tool call as JSON to
 * `ts-surgeon hook`; the guard runs a pipeline —
 *
 *   shell split (guard/shell) → search invocation model
 *   (guard/search-invocation) → pattern intent (guard/pattern-intent) →
 *   scope (guard/scope) → policy (this file) → answer (guard/answer)
 *
 * — with three outcomes:
 *
 * - Hand-rolled TS/JS refactors (in-place sed/perl over source files) and
 *   runtime-dynamic recursive search loops are blocked (exit 2 with a message
 *   on stderr naming the ts-surgeon tool to use instead).
 * - Recursive identifier searches (including alternations, declaration
 *   hunts, and decorated forms like `\bname\b` / `name\(`) are ANSWERED: the
 *   hook runs find_references for every hunted symbol and returns the real,
 *   AST-accurate references in the exit-2 message. When the answer cannot be
 *   produced (no tsconfig, no hunted name is a project symbol, the lookup
 *   errors or times out) the search is allowed through: fail-open on reads,
 *   so a legitimate grep is never stranded.
 * - Everything else — including anything the hook cannot parse — is allowed
 *   (exit 0): the guard must never break the harness.
 */

export {
	ALLOW_MARKER,
	INERT_PREFIX_NOTE,
	isOperatorAllowed,
} from "./guard/messages";
export {
	answerSearchViaCli,
	formatSearchAnswer,
	mapBatchResults,
	type PerSymbolResult,
	type SearchAnswer,
	type SearchAnswerer,
	type SearchAnswerRequest,
} from "./guard/answer";

export type HookEvaluation =
	| { kind: "allow" }
	| { kind: "block"; reason: string }
	| { kind: "answer-search"; symbolNames: string[]; searchRoot?: string };

/**
 * Evaluates a Bash command: in-place text edits of TS/JS sources (sed/perl
 * -i) and runtime-dynamic search loops are blocked; recursive identifier
 * searches (every grep/rg/git grep in the command is inspected, including
 * inside loops and command substitutions) come back as "answer-search" so
 * the hook can run find_references on the agent's behalf. The old
 * strict/default split (--strict flag, TS_SURGEON_STRICT env) is retired.
 */
export function evaluateBashCommand(command: string): HookEvaluation {
	const block = (reason: string): HookEvaluation => ({
		kind: "block",
		// A cargo-culted TS_SURGEON_ALLOW=1 prefix gets an explicit "that does
		// nothing" preface so the agent stops reaching for it.
		reason: command.includes("TS_SURGEON_ALLOW")
			? `${INERT_PREFIX_NOTE}\n${reason}`
			: reason,
	});
	if (isInPlaceSourceEdit(command)) {
		return block(EDIT_BLOCK_MESSAGE);
	}
	for (const tokens of splitSimpleCommands(command)) {
		const inv = parseSearchInvocation(tokens);
		if (inv === undefined || inv.patterns.length === 0) {
			continue;
		}
		// Non-recursive greps read stdin or named files — always fine. So are
		// recursive flags pointed at explicitly named files (agents reflexively
		// add -rn even when reading context out of two known files; observed
		// 2026-07-19) — but not globs like src/**/*.ts, which are project-wide.
		const explicitFilesOnly =
			inv.paths.length > 0 && inv.paths.every(isExplicitFile);
		const multiFile =
			inv.tool === "git-grep" ||
			inv.viaWrapper ||
			((inv.recursiveFlag || inv.tool === "rg") && !explicitFilesOnly);
		if (!multiFile) {
			continue;
		}
		const scope = resolveSearchScope(inv);
		if (scope === "non-source") {
			continue;
		}
		if (inv.invert) {
			// -v/-L hunt the ABSENCE of the pattern — not a reference lookup.
			continue;
		}
		const intent = analyzePatterns(inv.patterns, inv.syntax);
		if (intent.kind === "dynamic") {
			// A runtime-computed pattern (loop variable, substitution) is the
			// canonical evasion — but only when the search demonstrably targets
			// sources; a dynamic grep over unknown paths is too common to block.
			if (scope === "source") {
				return block(DYNAMIC_SEARCH_BLOCK_MESSAGE);
			}
			continue;
		}
		if (intent.kind === "identifiers") {
			return {
				kind: "answer-search",
				symbolNames: intent.symbols,
				searchRoot: inv.paths[0],
			};
		}
		// opaque: free text, true regexes, markers — nothing to answer.
	}
	return { kind: "allow" };
}

/**
 * Same policy for a harness's native Grep tool (always recursive; ripgrep
 * regex syntax): identifier lookups over sources are answered; everything
 * else — non-source scopes, single files, real regexes — is allowed.
 */
export function evaluateGrepToolInput(input: {
	pattern?: unknown;
	path?: unknown;
	glob?: unknown;
	type?: unknown;
}): HookEvaluation {
	const { pattern, path: searchPath, glob, type } = input;
	if (typeof pattern !== "string") {
		return { kind: "allow" };
	}
	if (typeof glob === "string" && !SOURCE_EXT_RE.test(glob)) {
		return { kind: "allow" };
	}
	if (typeof type === "string" && !RG_SOURCE_TYPES.has(type)) {
		return { kind: "allow" };
	}
	if (
		typeof searchPath === "string" &&
		searchPath !== "" &&
		isNonSourcePath(searchPath)
	) {
		return { kind: "allow" };
	}
	if (typeof searchPath === "string" && SOURCE_EXT_RE.test(searchPath)) {
		// A single-file lookup is not a project-wide reference hunt.
		return { kind: "allow" };
	}
	const intent = analyzePatterns([pattern], "ere");
	if (intent.kind === "identifiers") {
		return {
			kind: "answer-search",
			symbolNames: intent.symbols,
			searchRoot:
				typeof searchPath === "string" && searchPath !== ""
					? searchPath
					: undefined,
		};
	}
	return { kind: "allow" };
}

interface Writer {
	write(chunk: string): unknown;
}

/**
 * `ts-surgeon hook` — reads the harness's PreToolUse JSON payload from stdin
 * ({ tool_name, tool_input, cwd }) and exits 2 with a stderr message to block
 * or answer, 0 to allow. Handles Bash commands and the harness's native Grep
 * tool. `--strict` is accepted as a deprecated no-op.
 */
export function runHook(
	rest: string[],
	readStdin: StdinReader,
	err: Writer,
	answerSearch: SearchAnswerer = answerSearchViaCli,
): number {
	for (const arg of rest) {
		if (arg !== "--strict") {
			throw new CliUsageError(`Unknown option for hook: '${arg}'`);
		}
	}
	if (isOperatorAllowed()) {
		// The operator disabled the guard for this session.
		return 0;
	}
	if (process.stdin.isTTY) {
		// Not being driven by a harness; nothing to check.
		return 0;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(readStdin());
	} catch {
		return 0;
	}
	if (payload === null || typeof payload !== "object") {
		return 0;
	}
	const { tool_name, tool_input, cwd } = payload as {
		tool_name?: string;
		tool_input?: Record<string, unknown>;
		cwd?: unknown;
	};
	let evaluation: HookEvaluation = { kind: "allow" };
	if (tool_name === "Bash" && typeof tool_input?.command === "string") {
		evaluation = evaluateBashCommand(tool_input.command);
	} else if (tool_name === "Grep" && tool_input) {
		evaluation = evaluateGrepToolInput(tool_input);
	}
	if (evaluation.kind === "block") {
		err.write(`${evaluation.reason}\n`);
		return 2;
	}
	if (evaluation.kind === "answer-search") {
		const answer = answerSearch({
			symbolNames: evaluation.symbolNames,
			searchRoot: evaluation.searchRoot,
			cwd: typeof cwd === "string" ? cwd : process.cwd(),
		});
		if (!answer.ok) {
			// Fail open: the search could not be answered, so let it run.
			return 0;
		}
		const command =
			tool_name === "Bash" && typeof tool_input?.command === "string"
				? tool_input.command
				: "";
		err.write(
			`${
				command.includes("TS_SURGEON_ALLOW")
					? `${INERT_PREFIX_NOTE}\n${answer.text}`
					: answer.text
			}\n`,
		);
		return 2;
	}
	return 0;
}

const HOOK_COMMAND = "npx -y @commoncurriculum/ts-surgeon hook";

/** npm package opencode loads as the guard plugin (this package itself). */
const OPENCODE_PLUGIN_PACKAGE = "@commoncurriculum/ts-surgeon";

/**
 * Registers the guard in the project's opencode.json `"plugin"` array — the
 * package's main export is the opencode plugin, and opencode auto-installs
 * npm plugins at startup. Merges with existing config; idempotent.
 */
export function installOpencodeHook(cwd: string, out: Writer): void {
	const configPath = path.join(cwd, "opencode.json");
	let config: Record<string, unknown> = {
		$schema: "https://opencode.ai/config.json",
	};
	if (existsSync(configPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (error) {
			throw new CliUsageError(
				`${configPath} is not valid JSON — fix it before installing the plugin: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			throw new CliUsageError(
				`${configPath} must contain a JSON object to register the plugin (found ${Array.isArray(parsed) ? "an array" : typeof parsed}).`,
			);
		}
		config = parsed as Record<string, unknown>;
	}

	config.plugin ??= [];
	if (!Array.isArray(config.plugin)) {
		throw new CliUsageError(
			`${configPath} has a non-array "plugin" field — fix it before installing (expected e.g. ["@commoncurriculum/ts-surgeon"]).`,
		);
	}
	const plugins: unknown[] = config.plugin;
	if (
		plugins.some(
			(entry) =>
				typeof entry === "string" && entry.startsWith(OPENCODE_PLUGIN_PACKAGE),
		)
	) {
		out.write(
			`${configPath} already lists the ${OPENCODE_PLUGIN_PACKAGE} plugin — nothing to do.\n`,
		);
		return;
	}
	plugins.push(OPENCODE_PLUGIN_PACKAGE);
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
	out.write(
		`Registered the ${OPENCODE_PLUGIN_PACKAGE} guard plugin in ${configPath} (blocks sed/perl -i on TS/JS sources; answers recursive identifier searches with find_references output and fails open when it cannot answer; operators can disable it by launching the agent with ${ALLOW_MARKER} in the environment).\n`,
	);

	// Older versions of this installer copied a standalone plugin file instead.
	for (const legacy of [
		path.join(cwd, ".opencode", "plugin", "ts-surgeon.js"),
		path.join(cwd, ".opencode", "plugins", "ts-surgeon.js"),
	]) {
		if (existsSync(legacy)) {
			out.write(
				`Note: ${legacy} is the old copy-installed guard — delete it to avoid running the check twice.\n`,
			);
		}
	}
}

/**
 * Installs the PreToolUse guard into a project's .claude/settings.json
 * (Claude Code hooks). Merges with existing settings; idempotent.
 */
export function installClaudeHook(cwd: string, out: Writer): void {
	const settingsPath = path.join(cwd, ".claude", "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch (error) {
			throw new CliUsageError(
				`${settingsPath} is not valid JSON — fix it before installing the hook: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	settings.hooks ??= {};
	const hooks = settings.hooks as Record<string, unknown>;
	hooks.PreToolUse ??= [];
	const preToolUse = hooks.PreToolUse as Array<{
		matcher?: string;
		hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
	}>;
	const existing = preToolUse.find((entry) =>
		entry.hooks?.some((hook) => hook.command?.includes("ts-surgeon hook")),
	);
	if (existing) {
		if (existing.matcher === "Bash") {
			// Older installs only guarded Bash; extend them to the native Grep tool.
			existing.matcher = "Bash|Grep";
			writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
			out.write(
				`Upgraded the ts-surgeon hook matcher in ${settingsPath} from Bash to Bash|Grep (the guard now also redirects the native Grep tool).\n`,
			);
			return;
		}
		out.write(
			`${settingsPath} already runs the ts-surgeon hook — nothing to do.\n`,
		);
		return;
	}
	preToolUse.push({
		matcher: "Bash|Grep",
		// Generous timeout: answering a search runs find_references in-process,
		// which loads the ts-morph project (bounded by TS_SURGEON_ANSWER_TIMEOUT_MS).
		hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 120 }],
	});

	mkdirSync(path.dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	out.write(
		`Installed the ts-surgeon PreToolUse guard in ${settingsPath} (blocks sed/perl -i on TS/JS sources; answers recursive identifier searches with find_references output and fails open when it cannot answer; operators can disable it by launching the agent with ${ALLOW_MARKER} in the environment).\n`,
	);
}
