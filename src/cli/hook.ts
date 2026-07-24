import { answerSearchViaCli, type SearchAnswerer } from "./guard/answer.js";
import { isInPlaceSourceEdit } from "./guard/edits.js";
import {
	DYNAMIC_SEARCH_BLOCK_MESSAGE,
	EDIT_BLOCK_MESSAGE,
	isOperatorAllowed,
	withInertPrefixNote,
} from "./guard/messages.js";
import { analyzePatterns, SHELL_EXPANSION_RE } from "./guard/pattern-intent.js";
import { isExplicitFile, resolveSearchScope } from "./guard/scope.js";
import {
	invocationFromGrepTool,
	parseSearchInvocation,
	type SearchInvocation,
} from "./guard/search-invocation.js";
import { splitSimpleCommands } from "./guard/shell.js";
import { CliUsageError, type StdinReader } from "./params.js";

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
 *
 * A companion `ts-surgeon hook --post` (PostToolUse) teaches the exact
 * ts-surgeon equivalent after a search actually ran.
 */

export {
	ALLOW_MARKER,
	INERT_PREFIX_NOTE,
	isOperatorAllowed,
} from "./guard/messages.js";
export {
	answerSearchViaCli,
	formatSearchAnswer,
	mapBatchResults,
	type PerSymbolResult,
	type SearchAnswer,
	type SearchAnswerer,
	type SearchAnswerRequest,
} from "./guard/answer.js";
// compile.ts is deliberately NOT re-exported here: it reads package.json for
// the version, which does not exist inside the compiled guard, and hook.ts is
// on the guard's import graph.
export { installClaudeHook, installOpencodeHook } from "./guard/install.js";

export type HookEvaluation =
	| { kind: "allow" }
	| { kind: "block"; reason: string }
	| { kind: "answer-search"; symbolNames: string[]; searchRoot?: string };

type SignificantSearch =
	| { kind: "dynamic-source" }
	| { kind: "identifiers"; symbolNames: string[]; searchRoot?: string }
	| { kind: "opaque-source" };

/**
 * The shared policy core: what does ONE search invocation mean? Skips (→
 * undefined) everything the guard has no opinion about — non-recursive
 * greps, explicit-file reads, non-source scopes, runtime-computed roots,
 * inverted matches — then classifies the pattern intent.
 */
function classifySearch(inv: SearchInvocation): SignificantSearch | undefined {
	if (inv.patterns.length === 0) {
		return undefined;
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
		return undefined;
	}
	const scope = resolveSearchScope(inv);
	if (scope === "non-source") {
		return undefined;
	}
	if (inv.paths.some((p) => SHELL_EXPANSION_RE.test(p))) {
		// A runtime-computed search root (`grep name $(...)`, `grep name $DIR`)
		// cannot be scoped — answering from the wrong project would be worse
		// than letting the search run (mined 2026-07-20: a $() root that
		// resolved into node_modules).
		return undefined;
	}
	if (inv.invert) {
		// -v/-L hunt the ABSENCE of the pattern — not a reference lookup.
		return undefined;
	}
	const intent = analyzePatterns(inv.patterns, inv.syntax);
	if (intent.kind === "dynamic") {
		// A runtime-computed pattern (loop variable, substitution) is the
		// canonical evasion — but only when the search demonstrably targets
		// sources; a dynamic grep over unknown paths is too common to block.
		return scope === "source"
			? { kind: "dynamic-source" }
			: { kind: "opaque-source" };
	}
	if (intent.kind === "identifiers") {
		return {
			kind: "identifiers",
			symbolNames: intent.symbols,
			searchRoot: inv.paths[0],
		};
	}
	// opaque: free text, true regexes, markers — nothing to answer, but worth
	// a generic pointer after the search runs.
	return { kind: "opaque-source" };
}

/**
 * Finds the first search in a Bash command the guard has an opinion about;
 * every grep/rg/git grep is inspected, including inside loops and command
 * substitutions.
 */
function findSignificantSearch(command: string): SignificantSearch | undefined {
	let sawOpaqueSourceSearch = false;
	for (const tokens of splitSimpleCommands(command)) {
		const inv = parseSearchInvocation(tokens);
		if (inv === undefined) {
			continue;
		}
		const found = classifySearch(inv);
		if (found === undefined) {
			continue;
		}
		if (found.kind !== "opaque-source") {
			return found;
		}
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
	if (isInPlaceSourceEdit(command)) {
		return {
			kind: "block",
			reason: withInertPrefixNote(command, EDIT_BLOCK_MESSAGE),
		};
	}
	const found = findSignificantSearch(command);
	if (found?.kind === "dynamic-source") {
		return {
			kind: "block",
			reason: withInertPrefixNote(command, DYNAMIC_SEARCH_BLOCK_MESSAGE),
		};
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
 * Same policy for a harness's native Grep tool: the call is modeled as an rg
 * invocation and flows through the shared classifier. Identifier lookups
 * over sources are answered; everything else is allowed (the Grep tool never
 * hard-blocks — a dynamic-looking pattern there is regex text, not a shell
 * loop).
 */
export function evaluateGrepToolInput(input: {
	pattern?: unknown;
	path?: unknown;
	glob?: unknown;
	include?: unknown;
	type?: unknown;
}): HookEvaluation {
	const inv = invocationFromGrepTool(input);
	const found = inv === undefined ? undefined : classifySearch(inv);
	if (found?.kind === "identifiers") {
		return {
			kind: "answer-search",
			symbolNames: found.symbolNames,
			searchRoot: found.searchRoot,
		};
	}
	return { kind: "allow" };
}

// ── Post-run teaching ───────────────────────────────────────────────────────

const NPX_TS_SURGEON = "npx -y @commoncurriculum/ts-surgeon";

/**
 * Appended to every teaching line: agents reach for grep/sed because they do
 * not know the toolset exists, so each nudge also advertises the breadth —
 * search is one tool of many.
 */
const TOOLSET_TEACHING = `ts-surgeon is a full refactoring toolkit, not just search: rename_symbol, rename_file_system_entry, move_symbol_to_file, change_signature, safe_delete_symbol, organize_imports, search_pattern/rewrite_pattern (structural), get_diagnostics, and more. Use the ts-surgeon skill if it is installed, or run \`${NPX_TS_SURGEON} guide\` for the full list.`;

function exactTeachingLine(symbolNames: string[]): string {
	const perSymbol =
		symbolNames.length > 1
			? ` Run it once per symbol: ${symbolNames.join(", ")}.`
			: "";
	return `ts-surgeon: next time, use ts-surgeon: \`${NPX_TS_SURGEON} call find_references --symbol-name ${symbolNames[0]}\` for faster, more accurate results (AST-accurate: no comment/string false hits; aliased imports and re-exports included).${perSymbol}\n${TOOLSET_TEACHING}`;
}

const GENERIC_TEACHING_LINE = `ts-surgeon: next time, use ts-surgeon for code searches — \`${NPX_TS_SURGEON} call search_pattern --pattern '<code shape with $META vars>'\` for structural shapes.\n${TOOLSET_TEACHING}`;

/**
 * Teaching is intentionally broader than interception. A grep over one known
 * source file is legitimate context reading, so the pre-hook lets it run, but
 * find_references/search_pattern can still answer that search and should be
 * advertised afterward.
 */
function classifySearchForTeaching(
	inv: SearchInvocation,
): SignificantSearch | undefined {
	if (inv.patterns.length === 0 || inv.invert) {
		return undefined;
	}
	if (resolveSearchScope(inv) === "non-source") {
		return undefined;
	}
	if (inv.paths.some((p) => SHELL_EXPANSION_RE.test(p))) {
		return undefined;
	}
	// Plain grep without a path reads stdin. Unlike rg/git grep or a wrapped
	// grep, there is no project source search for ts-surgeon to replace.
	if (
		inv.tool === "grep" &&
		!inv.recursiveFlag &&
		!inv.viaWrapper &&
		inv.paths.length === 0
	) {
		return undefined;
	}
	const intent = analyzePatterns(inv.patterns, inv.syntax);
	if (intent.kind === "dynamic") {
		return undefined;
	}
	if (intent.kind === "identifiers") {
		return {
			kind: "identifiers",
			symbolNames: intent.symbols,
			searchRoot: inv.paths[0],
		};
	}
	return { kind: "opaque-source" };
}

function findTeachableSearch(command: string): SignificantSearch | undefined {
	let sawOpaqueSourceSearch = false;
	for (const tokens of splitSimpleCommands(command)) {
		const inv = parseSearchInvocation(tokens);
		if (inv === undefined) continue;
		const found = classifySearchForTeaching(inv);
		if (found?.kind === "identifiers") return found;
		if (found?.kind === "opaque-source") sawOpaqueSourceSearch = true;
	}
	return sawOpaqueSourceSearch ? { kind: "opaque-source" } : undefined;
}

/**
 * The line a post-run hook appends after an executed search: the exact
 * ts-surgeon equivalent when one exists (identifier hunts → find_references
 * with the symbol filled in), a generic pointer when the search targeted
 * sources but has no direct translation, undefined when ts-surgeon has no
 * business in it (non-source scopes, pipes, non-searches).
 */
export function buildSearchTeaching(
	toolName: string,
	toolInput: Record<string, unknown> | undefined,
): string | undefined {
	let found: SignificantSearch | undefined;
	if (toolName === "Bash" && typeof toolInput?.command === "string") {
		found = findTeachableSearch(toolInput.command);
	} else if (toolName === "Grep" && toolInput) {
		const inv = invocationFromGrepTool(toolInput);
		found = inv === undefined ? undefined : classifySearchForTeaching(inv);
	}
	if (found === undefined) {
		return undefined;
	}
	return found.kind === "identifiers"
		? exactTeachingLine(found.symbolNames)
		: GENERIC_TEACHING_LINE;
}

// ── Hook entry points ───────────────────────────────────────────────────────

interface Writer {
	write(chunk: string): unknown;
}

interface HookPayload {
	tool_name?: unknown;
	tool_input?: Record<string, unknown>;
	cwd?: unknown;
}

function readHookPayload(readStdin: StdinReader): HookPayload | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(readStdin());
	} catch {
		return undefined;
	}
	if (payload === null || typeof payload !== "object") {
		return undefined;
	}
	return payload as HookPayload;
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
	const payload = readHookPayload(readStdin);
	if (payload === undefined || typeof payload.tool_name !== "string") {
		return 0;
	}
	const teaching = buildSearchTeaching(payload.tool_name, payload.tool_input);
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
	const payload = readHookPayload(readStdin);
	if (payload === undefined) {
		return 0;
	}
	const { tool_name, tool_input, cwd } = payload;
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
		err.write(`${withInertPrefixNote(command, answer.text)}\n`);
		return 2;
	}
	return 0;
}
