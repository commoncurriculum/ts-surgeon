import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { CliUsageError, type StdinReader } from "./params";
import { findNearestTsconfig } from "./paths";

/**
 * PreToolUse guard for coding-agent harnesses (Claude Code hooks and
 * compatible). The harness pipes the pending tool call as JSON to
 * `ts-surgeon hook`; the guard has three outcomes:
 *
 * - Hand-rolled TS/JS refactors (in-place sed/perl over source files) and
 *   runtime-dynamic recursive search loops are blocked (exit 2 with a message
 *   on stderr naming the ts-surgeon tool to use instead).
 * - Recursive identifier searches are ANSWERED: the hook runs
 *   find_references itself and returns the real, AST-accurate references in
 *   the exit-2 message — the agent gets better data than the grep would have
 *   produced, in the same turn. When the answer cannot be produced (no
 *   tsconfig, the name is not a project symbol, the lookup errors or times
 *   out) the search is allowed through: fail-open on reads, so a legitimate
 *   grep is never stranded.
 * - Everything else — including anything the hook cannot parse — is allowed
 *   (exit 0): the guard must never break the harness.
 */

/**
 * Operator-only escape hatch: the guard is bypassed when TS_SURGEON_ALLOW=1 is
 * set in the hook process's own environment (i.e. by the human who launched
 * the agent session). It used to also work as an inline command prefix, but a
 * real transcript (2026-07-19) showed agents cargo-culting the prefix onto
 * every search, so the inline form is now deliberately inert.
 */
export const ALLOW_MARKER = "TS_SURGEON_ALLOW=1";

/** True when a human enabled the escape hatch in the hook's environment. */
export function isOperatorAllowed(env: NodeJS.ProcessEnv = process.env) {
	return env.TS_SURGEON_ALLOW === "1";
}

const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)\b/;
const IN_PLACE_SED_RE = /\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*\b|--in-place\b)/;
const IN_PLACE_PERL_RE = /\bperl\s+-[a-zA-Z]*i/;

/** Directory names that never hold project TS/JS sources worth guarding. */
const NON_SOURCE_DIRS = new Set([
	"docs",
	"doc",
	"documentation",
	"logs",
	"log",
	"tmp",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	".git",
	"etc",
	"var",
	"usr",
	"opt",
	"proc",
	"sys",
	"dev",
]);

/** Bare words that look like identifiers but are comment markers, not code. */
const COMMENT_MARKER_WORDS = new Set([
	"TODO",
	"FIXME",
	"XXX",
	"HACK",
	"NOTE",
	"WIP",
]);

const SHELL_KEYWORDS = new Set([
	"do",
	"then",
	"else",
	"elif",
	"if",
	"while",
	"until",
	"for",
	"{",
	"}",
	"!",
	"time",
]);

/** Commands that hand their arguments (incl. many files) to another command. */
const WRAPPER_COMMANDS = new Set([
	"xargs",
	"find",
	"sudo",
	"env",
	"command",
	"timeout",
	"nice",
	"nohup",
]);

const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg"]);

/** Flags whose value is the next token (so it must not be read as a positional). */
const GREP_ARG_FLAGS = new Set([
	"-e",
	"-f",
	"-m",
	"-A",
	"-B",
	"-C",
	"-d",
	"-D",
	"--include",
	"--exclude",
	"--exclude-dir",
	"--label",
	"--regexp",
	"--file",
	"--max-count",
]);
const RG_ARG_FLAGS = new Set([
	...GREP_ARG_FLAGS,
	"-g",
	"-t",
	"-T",
	"-j",
	"-M",
	"-E",
	"--glob",
	"--iglob",
	"--type",
	"--type-not",
	"--max-depth",
	"--threads",
	"--encoding",
	"--sort",
	"--sortr",
	"--color",
	"--colors",
	"--pre",
]);

const RG_SOURCE_TYPES = new Set(["ts", "typescript", "js", "javascript"]);

/**
 * Appended to every block message. Deliberately names no typeable bypass: a
 * real transcript (2026-07-19) showed that advertising the prefix trains
 * agents to cargo-cult it instead of using the tools. Reading the identifier
 * out of specific files stays open (non-recursive greps on named files are
 * always allowed), so a blocked agent is never stuck.
 */
const NO_BYPASS_FOOTER =
	"This guard has no in-session bypass; do not try to work around it. If this exact search is truly required (e.g. the ts-surgeon CLI itself fails in this project), grep the specific files by name — that is always allowed — or ask the user; the operator escape hatch is documented in the ts-surgeon README.";

/**
 * Prepended when a blocked command carries the old inline escape-hatch prefix.
 */
export const INERT_PREFIX_NOTE = `ts-surgeon: the ${ALLOW_MARKER} command prefix is ignored — the escape hatch is operator-only, read from the hook's own environment, which your commands cannot set.`;

const EDIT_BLOCK_MESSAGE = `ts-surgeon: this command hand-edits TypeScript/JavaScript sources with text replacement (sed/perl -i).
Text replacement misses imports, re-exports, and same-name collisions. Use the AST-accurate CLI instead:
  npx -y @commoncurriculum/ts-surgeon guide     # when to use which tool
  e.g. call rename_symbol / change_signature for symbol changes, or
  call rewrite_pattern --pattern 'console.log($$$A)' --rewrite 'logger.debug($$$A)'
  for sed-style codemods (all support --dry-run)
${NO_BYPASS_FOOTER}`;

const DYNAMIC_SEARCH_BLOCK_MESSAGE = `ts-surgeon: this command loops a recursive text search over TS/JS sources with a runtime-computed pattern.
Text search misses aliased imports/re-exports and matches unrelated same-name tokens. Use the AST-aware lookups instead — no need to know the declaring file:
  npx -y @commoncurriculum/ts-surgeon call find_references --symbol-name <name>   # per symbol; tsconfig is auto-discovered
Auditing which exports are unused? One call replaces the whole loop:
  npx -y @commoncurriculum/ts-surgeon call find_unused_exports --tsconfig-path <path/to/tsconfig.json>
${NO_BYPASS_FOOTER}`;

/**
 * Splits a shell command string into simple commands (token lists), cutting at
 * pipes, `;`, `&&`/`||`, newlines, subshells, and loops, and recursing into
 * `$(...)` / backtick substitutions so nested invocations are inspected too.
 * Quoting is honored ('...' and "..." become part of one token); redirects and
 * their targets are dropped. This is deliberately an approximation — it only
 * has to be good enough to find every grep/rg invocation, never to execute.
 */
function splitSimpleCommands(command: string): string[][] {
	const commands: string[][] = [];
	const collect = (input: string): void => {
		let current: string[] = [];
		let tok = "";
		let hasTok = false;
		const pushTok = () => {
			if (hasTok) {
				current.push(tok);
			}
			tok = "";
			hasTok = false;
		};
		const pushCmd = () => {
			pushTok();
			if (current.length > 0) {
				commands.push(current);
			}
			current = [];
		};
		let i = 0;
		while (i < input.length) {
			const c = input[i];
			if (c === "'") {
				const end = input.indexOf("'", i + 1);
				tok += end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
				hasTok = true;
				i = end === -1 ? input.length : end + 1;
			} else if (c === '"') {
				let j = i + 1;
				while (j < input.length && input[j] !== '"') {
					if (input[j] === "\\" && j + 1 < input.length) {
						tok += input[j + 1];
						j += 2;
					} else {
						tok += input[j];
						j++;
					}
				}
				hasTok = true;
				i = j + 1;
			} else if (c === "\\") {
				if (i + 1 < input.length) {
					tok += input[i + 1];
					hasTok = true;
				}
				i += 2;
			} else if (c === "$" && input[i + 1] === "(") {
				// Command substitution: inspect the inner commands too, and keep the
				// literal `$(...)` so a substitution used as a pattern reads as dynamic.
				let depth = 1;
				let j = i + 2;
				while (j < input.length && depth > 0) {
					if (input[j] === "(") depth++;
					else if (input[j] === ")") depth--;
					if (depth > 0) j++;
				}
				collect(input.slice(i + 2, j));
				tok += input.slice(i, Math.min(j + 1, input.length));
				hasTok = true;
				i = j + 1;
			} else if (c === "`") {
				const end = input.indexOf("`", i + 1);
				const inner = end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
				collect(inner);
				tok += `$(${inner})`;
				hasTok = true;
				i = end === -1 ? input.length : end + 1;
			} else if (c === "#" && !hasTok) {
				const nl = input.indexOf("\n", i);
				i = nl === -1 ? input.length : nl;
			} else if (c === "\n") {
				pushCmd();
				i++;
			} else if (/\s/.test(c)) {
				pushTok();
				i++;
			} else if (
				c === "|" ||
				c === ";" ||
				c === "&" ||
				c === "(" ||
				c === ")"
			) {
				pushCmd();
				i++;
			} else if (c === "<" || c === ">") {
				// Redirect: drop an fd prefix ("2>"), the operator run, and its target.
				if (/^\d+$/.test(tok)) {
					tok = "";
					hasTok = false;
				} else {
					pushTok();
				}
				while (i < input.length && /[<>&]/.test(input[i])) i++;
				while (i < input.length && /\s/.test(input[i])) i++;
				while (i < input.length && !/[\s|;&()<>]/.test(input[i])) i++;
			} else {
				tok += c;
				hasTok = true;
				i++;
			}
		}
		pushCmd();
	};
	collect(command);
	return commands;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * A hunt for a declaration site ("function renderStringAsData", "export const
 * cartTotal") is an identifier lookup wearing a two-word coat — observed in a
 * real transcript, 2026-07-19. Regex-y patterns (`function\s+\w+`) don't match.
 */
const DECLARATION_PATTERN_RE =
	/^(export +)?(async +)?(function|const|let|var|class|interface|type|enum) +[A-Za-z_$][A-Za-z0-9_$]*$/;
/** `$name` / `${name}` / `$(cmd)` anywhere in the pattern → runtime-dynamic. */
const DYNAMIC_PATTERN_RE = /\$[A-Za-z_{(]/;

/** A path token that names one concrete file (an extension, no glob chars). */
function isExplicitFile(p: string): boolean {
	return !/[*?[]/.test(p) && hasFileExtension(p);
}

/**
 * The identifier a pattern is hunting: the pattern itself for bare identifier
 * lookups, the declared name for declaration hunts, undefined otherwise.
 */
function extractHuntedSymbol(pattern: string): string | undefined {
	if (
		IDENTIFIER_RE.test(pattern) &&
		!COMMENT_MARKER_WORDS.has(pattern.toUpperCase())
	) {
		return pattern;
	}
	if (DECLARATION_PATTERN_RE.test(pattern)) {
		return pattern.trim().split(/\s+/).pop();
	}
	return undefined;
}

function baseName(token: string): string {
	return token.split("/").pop() ?? token;
}

function hasFileExtension(p: string): boolean {
	return /\.[A-Za-z0-9]{1,8}$/.test(p) || SOURCE_EXT_RE.test(p);
}

function isNonSourcePath(p: string): boolean {
	if (SOURCE_EXT_RE.test(p)) {
		return false;
	}
	const top = p.replace(/^\.?\//, "").split("/")[0];
	return NON_SOURCE_DIRS.has(top) || hasFileExtension(p);
}

interface SearchClassification {
	kind: "identifier" | "dynamic";
	/** The hunted identifier (kind "identifier" only). */
	symbolName?: string;
	/** The first path argument, as written — locates the project to answer in. */
	searchRoot?: string;
}

/**
 * Inspects one simple command; returns what its grep/rg is doing wrong
 * (hunting an identifier, or looping a runtime-computed pattern), or
 * undefined when it is fine.
 */
function classifySearchCommand(
	tokens: string[],
): SearchClassification | undefined {
	// Skip leading shell keywords (do/then/...) and VAR=value assignments.
	let start = 0;
	while (
		start < tokens.length &&
		(SHELL_KEYWORDS.has(tokens[start]) ||
			/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]))
	) {
		start++;
	}
	let idx = -1;
	for (let i = start; i < tokens.length; i++) {
		if (SEARCH_COMMANDS.has(baseName(tokens[i]))) {
			idx = i;
			break;
		}
	}
	if (idx === -1) {
		return undefined;
	}
	const isRg = baseName(tokens[idx]) === "rg";
	const isGitGrep = idx > start && baseName(tokens[idx - 1]) === "git";
	let viaWrapper = false;
	for (let i = start; i < idx; i++) {
		if (WRAPPER_COMMANDS.has(baseName(tokens[i]))) {
			viaWrapper = true;
		}
	}
	if (idx > start && !isGitGrep && !viaWrapper) {
		// "grep" is an argument to a command we don't model (echo, etc.).
		return undefined;
	}

	const argFlags = isRg ? RG_ARG_FLAGS : GREP_ARG_FLAGS;
	let recursiveFlag = false;
	let afterDashDash = false;
	let pattern: string | undefined;
	const includeGlobs: string[] = [];
	const rgTypes: string[] = [];
	const paths: string[] = [];
	for (let i = idx + 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (!afterDashDash && t === "--") {
			afterDashDash = true;
			continue;
		}
		if (!afterDashDash && t.startsWith("-") && t.length > 1) {
			const eq = t.indexOf("=");
			const name = eq === -1 ? t : t.slice(0, eq);
			const inline = eq === -1 ? undefined : t.slice(eq + 1);
			const value = (): string | undefined =>
				inline !== undefined ? inline : tokens[++i];
			if (
				name === "--include" ||
				(isRg && (name === "-g" || name === "--glob" || name === "--iglob"))
			) {
				const v = value();
				if (v !== undefined) includeGlobs.push(v);
			} else if (isRg && (name === "-t" || name === "--type")) {
				const v = value();
				if (v !== undefined) rgTypes.push(v);
			} else if (name === "-e" || name === "--regexp") {
				const v = value();
				if (v !== undefined && pattern === undefined) pattern = v;
			} else if (name === "--recursive" || name === "--dereference-recursive") {
				recursiveFlag = true;
			} else if (argFlags.has(name) && inline === undefined) {
				i++; // consume the flag's value
			} else if (!name.startsWith("--") && /[rR]/.test(name.slice(1))) {
				recursiveFlag = true; // -r / -R inside a short-flag cluster
			}
			continue;
		}
		if (pattern === undefined) {
			pattern = t;
		} else {
			paths.push(t);
		}
	}

	// Non-recursive greps read stdin or named files — always fine. So are
	// recursive flags pointed at explicitly named files (agents reflexively add
	// -rn even when reading context out of two known files; observed 2026-07-19)
	// — but not at globs like src/**/*.ts, which are project-wide hunts.
	const explicitFilesOnly = paths.length > 0 && paths.every(isExplicitFile);
	const multiFile =
		isGitGrep || viaWrapper || ((recursiveFlag || isRg) && !explicitFilesOnly);
	if (!multiFile || pattern === undefined) {
		return undefined;
	}

	// Scope: explicit --include/--glob/--type filters win; otherwise judge the
	// path arguments. "unknown" (bare directories, no paths) counts as source —
	// that is where project code lives.
	let scope: "source" | "non-source" | "unknown";
	const filterSource =
		includeGlobs.some((g) => SOURCE_EXT_RE.test(g)) ||
		rgTypes.some((t) => RG_SOURCE_TYPES.has(t));
	// A glob only narrows scope away from sources when it names a concrete
	// non-source extension; wildcards like `*.*` or `src/**` cover sources too.
	const filterNeutral = includeGlobs.some(
		(g) => !SOURCE_EXT_RE.test(g) && !/\.[A-Za-z0-9]{1,8}$/.test(g),
	);
	if (filterSource) {
		scope = "source";
	} else if (
		(includeGlobs.length > 0 || rgTypes.length > 0) &&
		!filterNeutral
	) {
		scope = "non-source";
	} else if (paths.some((p) => SOURCE_EXT_RE.test(p))) {
		scope = "source";
	} else if (paths.length > 0 && paths.every(isNonSourcePath)) {
		scope = "non-source";
	} else {
		scope = "unknown";
	}
	if (scope === "non-source") {
		return undefined;
	}

	if (DYNAMIC_PATTERN_RE.test(pattern)) {
		// A runtime-computed pattern (loop variable, substitution) is the
		// canonical evasion — but only when the search demonstrably targets
		// sources; a dynamic grep over unknown paths is too common to block.
		return scope === "source" ? { kind: "dynamic" } : undefined;
	}
	const symbolName = extractHuntedSymbol(pattern);
	if (symbolName !== undefined) {
		return { kind: "identifier", symbolName, searchRoot: paths[0] };
	}
	return undefined;
}

export type HookEvaluation =
	| { kind: "allow" }
	| { kind: "block"; reason: string }
	| { kind: "answer-search"; symbolName: string; searchRoot?: string };

/**
 * Evaluates a Bash command: in-place text edits of TS/JS sources (sed/perl
 * -i) and runtime-dynamic search loops are blocked; recursive identifier
 * searches (every grep/rg in the command is inspected, including inside loops
 * and command substitutions) come back as "answer-search" so the hook can run
 * find_references on the agent's behalf. The old strict/default split
 * (--strict flag, TS_SURGEON_STRICT env) is retired — this is the one mode.
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
	const touchesSources = SOURCE_EXT_RE.test(command);
	if (
		touchesSources &&
		(IN_PLACE_SED_RE.test(command) || IN_PLACE_PERL_RE.test(command))
	) {
		return block(EDIT_BLOCK_MESSAGE);
	}
	for (const tokens of splitSimpleCommands(command)) {
		const found = classifySearchCommand(tokens);
		if (found === undefined) {
			continue;
		}
		if (found.kind === "dynamic" || found.symbolName === undefined) {
			return block(DYNAMIC_SEARCH_BLOCK_MESSAGE);
		}
		return {
			kind: "answer-search",
			symbolName: found.symbolName,
			searchRoot: found.searchRoot,
		};
	}
	return { kind: "allow" };
}

/**
 * Same policy for a harness's native Grep tool (always recursive): identifier
 * lookups over sources are answered; everything else — non-source scopes,
 * single files, real regexes — is allowed.
 */
export function evaluateGrepToolInput(input: {
	pattern?: unknown;
	path?: unknown;
	glob?: unknown;
	type?: unknown;
}): HookEvaluation {
	const { pattern, path, glob, type } = input;
	if (typeof pattern !== "string") {
		return { kind: "allow" };
	}
	if (typeof glob === "string" && !SOURCE_EXT_RE.test(glob)) {
		return { kind: "allow" };
	}
	if (typeof type === "string" && !RG_SOURCE_TYPES.has(type)) {
		return { kind: "allow" };
	}
	if (typeof path === "string" && path !== "" && isNonSourcePath(path)) {
		return { kind: "allow" };
	}
	if (typeof path === "string" && SOURCE_EXT_RE.test(path)) {
		// A single-file lookup is not a project-wide reference hunt.
		return { kind: "allow" };
	}
	const symbolName = extractHuntedSymbol(pattern);
	if (symbolName !== undefined) {
		return {
			kind: "answer-search",
			symbolName,
			searchRoot: typeof path === "string" && path !== "" ? path : undefined,
		};
	}
	return { kind: "allow" };
}

// ── Answering searches ──────────────────────────────────────────────────────

export interface SearchAnswerRequest {
	symbolName: string;
	searchRoot?: string;
	/** The harness session's working directory (from the hook payload). */
	cwd: string;
}

/** ok:false means "could not answer — let the original search run". */
export type SearchAnswer = { ok: true; text: string } | { ok: false };
export type SearchAnswerer = (req: SearchAnswerRequest) => SearchAnswer;

interface AnswerLocation {
	filePath: string;
	line: number;
	column: number;
	text: string;
}

const REFERENCE_DISPLAY_CAP = 40;

/** Renders find_references output as the hook's answer to a blocked search. */
export function formatSearchAnswer(
	symbolName: string,
	tsconfigPath: string,
	data: {
		definition: AnswerLocation | null;
		references: AnswerLocation[];
	},
): string {
	const loc = (l: AnswerLocation) =>
		`${l.filePath}:${l.line}:${l.column}  ${l.text}`;
	const lines: string[] = [
		`ts-surgeon: this search hunts the identifier '${symbolName}', so the hook ran find_references for you (AST-accurate: no comment/string false hits; aliased imports and re-exports included).`,
	];
	lines.push(
		data.definition
			? `Definition: ${loc(data.definition)}`
			: "Definition: (not reported)",
	);
	if (data.references.length === 0) {
		lines.push(
			`References: none — nothing else in the project references '${symbolName}'.`,
		);
	} else {
		lines.push(`References (${data.references.length}):`);
		for (const ref of data.references.slice(0, REFERENCE_DISPLAY_CAP)) {
			lines.push(`  ${loc(ref)}`);
		}
		if (data.references.length > REFERENCE_DISPLAY_CAP) {
			lines.push(
				`  … and ${data.references.length - REFERENCE_DISPLAY_CAP} more; run the command below for the full list.`,
			);
		}
	}
	lines.push(
		"Run this lookup directly next time:",
		`  npx -y @commoncurriculum/ts-surgeon call find_references --tsconfig-path ${tsconfigPath} --symbol-name ${symbolName}`,
		"Free-text/regex searches and greps over explicitly named files are never intercepted.",
	);
	return lines.join("\n");
}

function formatAmbiguityAnswer(
	symbolName: string,
	tsconfigPath: string,
	message: string,
): string {
	return [
		`ts-surgeon: this search hunts the identifier '${symbolName}', and a plain text search would conflate its distinct declarations. ${message}`,
		"Get exact references for the one you mean:",
		`  npx -y @commoncurriculum/ts-surgeon call find_references --tsconfig-path ${tsconfigPath} --symbol-name ${symbolName} --target-file-path <one of the candidates above>`,
	].join("\n");
}

/**
 * Hard ceiling for the in-hook find_references child process. The grep being
 * intercepted would return in about a second, so an answer is only worth a
 * few seconds' wait — beyond that, stalling the agent and then failing open
 * is strictly worse than letting the grep run. Projects that load slowly but
 * are worth answering can raise TS_SURGEON_ANSWER_TIMEOUT_MS.
 */
const ANSWER_TIMEOUT_MS = Number(
	process.env.TS_SURGEON_ANSWER_TIMEOUT_MS ?? "10000",
);

/**
 * The real answerer: locate the nearest tsconfig above the searched path,
 * then run this package's own CLI (`call find_references --symbol-name ...`)
 * in a child process with a time budget. Any failure — no tsconfig, no built
 * CLI, unknown symbol, crash, timeout — returns ok:false so the caller lets
 * the original search run. The one non-success worth relaying is an ambiguous
 * symbol: the candidate list is itself the answer.
 */
export const answerSearchViaCli: SearchAnswerer = (req) => {
	let rootDir = existsSync(req.cwd) ? req.cwd : process.cwd();
	if (req.searchRoot !== undefined) {
		// Reduce globs ("src/**/*.ts") and file paths to a directory to walk up
		// from; fall back to the session cwd when it does not exist.
		let dir = path.resolve(rootDir, req.searchRoot.split(/[*?[]/)[0]);
		if (hasFileExtension(dir)) {
			dir = path.dirname(dir);
		}
		while (dir !== path.dirname(dir) && !existsSync(dir)) {
			dir = path.dirname(dir);
		}
		if (existsSync(dir)) {
			rootDir = dir;
		}
	}
	const tsconfigPath = findNearestTsconfig(rootDir);
	if (tsconfigPath === undefined) {
		return { ok: false };
	}
	const cliEntry = path.join(__dirname, "..", "index.js");
	if (!existsSync(cliEntry)) {
		return { ok: false };
	}
	try {
		const stdout = execFileSync(
			process.execPath,
			[
				cliEntry,
				"call",
				"find_references",
				"--json",
				"--params",
				JSON.stringify({ tsconfigPath, symbolName: req.symbolName }),
			],
			{
				encoding: "utf-8",
				timeout: ANSWER_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: 64 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const parsed = JSON.parse(stdout) as {
			status?: string;
			data?: {
				definition: AnswerLocation | null;
				references: AnswerLocation[];
			};
		};
		if (parsed.status !== "success" || parsed.data == null) {
			return { ok: false };
		}
		return {
			ok: true,
			text: formatSearchAnswer(req.symbolName, tsconfigPath, parsed.data),
		};
	} catch (error) {
		const stdout = (error as { stdout?: unknown }).stdout;
		if (typeof stdout === "string") {
			try {
				const parsed = JSON.parse(stdout) as { message?: unknown };
				if (
					typeof parsed.message === "string" &&
					parsed.message.includes("declarations in the project")
				) {
					return {
						ok: true,
						text: formatAmbiguityAnswer(
							req.symbolName,
							tsconfigPath,
							parsed.message,
						),
					};
				}
			} catch {
				// Not the CLI's JSON envelope — fall through to fail-open.
			}
		}
		return { ok: false };
	}
};

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
			symbolName: evaluation.symbolName,
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
