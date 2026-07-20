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

type SignificantSearch =
	| { kind: "dynamic-source" }
	| { kind: "identifiers"; symbolNames: string[]; searchRoot?: string }
	| { kind: "opaque-source" };

/**
 * Finds the first search in a Bash command the guard has an opinion about:
 * every grep/rg/git grep is inspected (including inside loops and command
 * substitutions); non-recursive greps, explicit-file reads, non-source
 * scopes, dynamic roots, and inverted matches are skipped.
 */
function findSignificantSearch(command: string): SignificantSearch | undefined {
	let sawOpaqueSourceSearch = false;
	for (const tokens of splitSimpleCommands(command)) {
		const inv = parseSearchInvocation(tokens);
		if (inv === undefined || inv.patterns.length === 0) {
			continue;
		}
		// Non-recursive greps read stdin or named files — always fine. So are
		// recursive tools pointed at explicitly named files (agents reflexively
		// add -rn even when reading context out of two known files, and run
		// `git grep -- a.ts b.ts`; observed 2026-07-19/20) — but not globs like
		// src/**/*.ts, which are project-wide.
		const explicitFilesOnly =
			inv.paths.length > 0 && inv.paths.every(isExplicitFile);
		const multiFile =
			inv.viaWrapper ||
			((inv.recursiveFlag || inv.tool === "rg" || inv.tool === "git-grep") &&
				!explicitFilesOnly);
		if (!multiFile) {
			continue;
		}
		const scope = resolveSearchScope(inv);
		if (scope === "non-source") {
			continue;
		}
		if (inv.paths.some((p) => /\$[A-Za-z_{(]/.test(p))) {
			// A runtime-computed search root (`grep name $(...)`, `grep name
			// $DIR`) cannot be scoped — answering from the wrong project would be
			// worse than letting the search run (mined 2026-07-20: a $() root
			// that resolved into node_modules).
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
				return { kind: "dynamic-source" };
			}
			sawOpaqueSourceSearch = true;
			continue;
		}
		if (intent.kind === "identifiers") {
			return {
				kind: "identifiers",
				symbolNames: intent.symbols,
				searchRoot: inv.paths[0],
			};
		}
		// opaque: free text, true regexes, markers — nothing to answer, but
		// worth a generic pointer after the search runs.
		sawOpaqueSourceSearch = true;
	}
	return sawOpaqueSourceSearch ? { kind: "opaque-source" } : undefined;
}

/**
 * Evaluates a Bash command: in-place text edits of TS/JS sources (sed/perl
 * -i) and runtime-dynamic search loops are blocked; recursive identifier
 * searches come back as "answer-search" so the hook can run find_references
 * on the agent's behalf. The old strict/default split (--strict flag,
 * TS_SURGEON_STRICT env) is retired.
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
	const found = findSignificantSearch(command);
	if (found?.kind === "dynamic-source") {
		return block(DYNAMIC_SEARCH_BLOCK_MESSAGE);
	}
	if (found?.kind === "identifiers") {
		return {
			kind: "answer-search",
			symbolNames: found.symbolNames,
			searchRoot: found.searchRoot,
		};
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

// ── Post-run teaching ───────────────────────────────────────────────────────

const NPX_TS_SURGEON = "npx -y @commoncurriculum/ts-surgeon";

function exactTeachingLine(symbolNames: string[]): string {
	const perSymbol =
		symbolNames.length > 1
			? ` Run it once per symbol: ${symbolNames.join(", ")}.`
			: "";
	return `ts-surgeon: next time, use \`${NPX_TS_SURGEON} call find_references --symbol-name ${symbolNames[0]}\` for faster, more accurate results (AST-accurate: no comment/string false hits; aliased imports and re-exports included).${perSymbol}`;
}

const GENERIC_TEACHING_LINE = `ts-surgeon: next time, a ts-surgeon lookup is usually faster and more accurate for code searches — \`${NPX_TS_SURGEON} call search_pattern --pattern '<code shape with $META vars>'\` for structural shapes; \`${NPX_TS_SURGEON} guide\` lists the tools.`;

/**
 * The line a post-run hook appends after an executed search: the exact
 * ts-surgeon equivalent when one exists (identifier hunts → find_references
 * with the symbol filled in), a generic pointer when the search targeted
 * sources but has no direct translation, undefined when ts-surgeon has no
 * business in it (non-source scopes, explicit files, pipes, non-searches).
 */
export function buildSearchTeaching(
	toolName: string,
	toolInput: Record<string, unknown> | undefined,
): string | undefined {
	if (toolName === "Bash" && typeof toolInput?.command === "string") {
		const found = findSignificantSearch(toolInput.command);
		if (found === undefined) {
			return undefined;
		}
		return found.kind === "identifiers"
			? exactTeachingLine(found.symbolNames)
			: GENERIC_TEACHING_LINE;
	}
	if (toolName === "Grep" && toolInput) {
		const verdict = evaluateGrepToolInput(toolInput);
		if (verdict.kind === "answer-search") {
			return exactTeachingLine(verdict.symbolNames);
		}
		const { pattern, path: searchPath, glob, type } = toolInput;
		if (typeof pattern !== "string") return undefined;
		if (typeof glob === "string" && !SOURCE_EXT_RE.test(glob)) return undefined;
		if (typeof type === "string" && !RG_SOURCE_TYPES.has(type))
			return undefined;
		if (
			typeof searchPath === "string" &&
			searchPath !== "" &&
			isNonSourcePath(searchPath)
		) {
			return undefined;
		}
		if (typeof searchPath === "string" && SOURCE_EXT_RE.test(searchPath)) {
			return undefined;
		}
		return GENERIC_TEACHING_LINE;
	}
	return undefined;
}

interface Writer {
	write(chunk: string): unknown;
}

/**
 * `ts-surgeon hook --post` — reads the harness's PostToolUse JSON payload
 * from stdin and, when the just-executed command was a source-directed
 * search, emits `additionalContext` teaching the exact (or generic)
 * ts-surgeon equivalent. Never blocks; always exits 0.
 */
export function runPostHook(readStdin: StdinReader, out: Writer): number {
	if (isOperatorAllowed()) {
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
	const { tool_name, tool_input } = payload as {
		tool_name?: unknown;
		tool_input?: Record<string, unknown>;
	};
	if (typeof tool_name !== "string") {
		return 0;
	}
	const teaching = buildSearchTeaching(tool_name, tool_input);
	if (teaching === undefined) {
		return 0;
	}
	out.write(
		`${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: teaching,
			},
		})}\n`,
	);
	return 0;
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
const POST_HOOK_COMMAND = "npx -y @commoncurriculum/ts-surgeon hook --post";

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
	hooks.PostToolUse ??= [];
	type HookEntry = {
		matcher?: string;
		hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
	};
	const preToolUse = hooks.PreToolUse as HookEntry[];
	const postToolUse = hooks.PostToolUse as HookEntry[];
	const notes: string[] = [];

	const existing = preToolUse.find((entry) =>
		entry.hooks?.some((hook) => hook.command?.includes("ts-surgeon hook")),
	);
	if (existing) {
		if (existing.matcher === "Bash") {
			// Older installs only guarded Bash; extend them to the native Grep tool.
			existing.matcher = "Bash|Grep";
			notes.push(
				`Upgraded the ts-surgeon hook matcher in ${settingsPath} from Bash to Bash|Grep (the guard now also redirects the native Grep tool).\n`,
			);
		}
	} else {
		preToolUse.push({
			matcher: "Bash|Grep",
			// Generous timeout: answering a search runs find_references in-process,
			// which loads the ts-morph project (bounded by TS_SURGEON_ANSWER_TIMEOUT_MS).
			hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 120 }],
		});
		notes.push(
			`Installed the ts-surgeon PreToolUse guard in ${settingsPath} (blocks sed/perl -i on TS/JS sources; answers recursive identifier searches with find_references output and fails open when it cannot answer; operators can disable it by launching the agent with ${ALLOW_MARKER} in the environment).\n`,
		);
	}

	const existingPost = postToolUse.some((entry) =>
		entry.hooks?.some((hook) => hook.command?.includes("hook --post")),
	);
	if (!existingPost) {
		postToolUse.push({
			matcher: "Bash|Grep",
			hooks: [{ type: "command", command: POST_HOOK_COMMAND, timeout: 30 }],
		});
		notes.push(
			`Added the ts-surgeon PostToolUse teaching hook in ${settingsPath} (after an executed search it suggests the exact ts-surgeon equivalent — e.g. call find_references --symbol-name <name>).\n`,
		);
	}

	if (notes.length === 0) {
		out.write(
			`${settingsPath} already runs the ts-surgeon hooks — nothing to do.\n`,
		);
		return;
	}
	mkdirSync(path.dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	for (const note of notes) {
		out.write(note);
	}
}
