import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { CliUsageError, type StdinReader } from "./params";

/**
 * PreToolUse guard for coding-agent harnesses (Claude Code hooks and
 * compatible). The harness pipes the pending tool call as JSON to
 * `ts-surgeon hook`; when the command is a hand-rolled TS/JS refactor
 * (in-place sed/perl over source files), the hook exits 2 with a message on
 * stderr telling the agent to use ts-surgeon instead. Everything else —
 * including anything the hook cannot parse — is allowed (exit 0): the guard
 * must never break the harness.
 */

/** Escape hatch: prefix a command with this to bypass the guard. */
export const ALLOW_MARKER = "TS_SURGEON_ALLOW=1";

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

const EDIT_BLOCK_MESSAGE = `ts-surgeon: this command hand-edits TypeScript/JavaScript sources with text replacement (sed/perl -i).
Text replacement misses imports, re-exports, and same-name collisions. Use the AST-accurate CLI instead:
  npx -y @commoncurriculum/ts-surgeon guide     # when to use which tool
  e.g. call rename_symbol / change_signature / organize_imports (all support --dry-run)
If this is genuinely not a refactor, re-run the command prefixed with ${ALLOW_MARKER}.`;

const SEARCH_BLOCK_MESSAGE = `ts-surgeon: this command recursively text-searches TS/JS sources for a code identifier.
Text search misses aliased imports/re-exports and matches unrelated same-name tokens. Use the type-aware lookup instead:
  npx -y @commoncurriculum/ts-surgeon call find_references --target-file-path <file-that-declares-it> --symbol-name <name>
Auditing which exports are unused? Use:
  npx -y @commoncurriculum/ts-surgeon call find_unused_exports --tsconfig-path <path/to/tsconfig.json>
If you really need a text search (strings, comments, non-code), re-run the command prefixed with ${ALLOW_MARKER}.`;

const GREP_TOOL_BLOCK_MESSAGE = `ts-surgeon: this Grep call looks up a code identifier across TS/JS sources.
Text search misses aliased imports/re-exports and matches unrelated same-name tokens. Use the type-aware lookup instead (via Bash):
  npx -y @commoncurriculum/ts-surgeon call find_references --target-file-path <file-that-declares-it> --symbol-name <name>
Auditing which exports are unused? Use:
  npx -y @commoncurriculum/ts-surgeon call find_unused_exports --tsconfig-path <path/to/tsconfig.json>
If you really need a text match (strings, comments, non-code), run it via Bash prefixed with ${ALLOW_MARKER}, e.g.:
  ${ALLOW_MARKER} grep -rn <pattern> <path>`;

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
/** `$name` / `${name}` / `$(cmd)` anywhere in the pattern → runtime-dynamic. */
const DYNAMIC_PATTERN_RE = /\$[A-Za-z_{(]/;

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

/**
 * Inspects one simple command; returns why its grep/rg should be blocked
 * ("identifier" | "dynamic"), or undefined when it is fine.
 */
function classifySearchCommand(
	tokens: string[],
): "identifier" | "dynamic" | undefined {
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

	// Non-recursive greps read stdin or named files — always fine.
	const multiFile =
		isGitGrep ||
		viaWrapper ||
		recursiveFlag ||
		(isRg && !(paths.length > 0 && paths.every(hasFileExtension)));
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
		return scope === "source" ? "dynamic" : undefined;
	}
	if (
		IDENTIFIER_RE.test(pattern) &&
		!COMMENT_MARKER_WORDS.has(pattern.toUpperCase())
	) {
		return "identifier";
	}
	return undefined;
}

export interface HookVerdict {
	block: boolean;
	reason?: string;
}

/**
 * Decides whether a Bash command should be redirected to ts-surgeon: in-place
 * text edits of TS/JS sources (sed/perl -i) and recursive identifier searches
 * (every grep/rg in the command is inspected, including inside loops and
 * command substitutions).
 */
export function evaluateBashCommand(command: string): HookVerdict {
	if (command.includes(ALLOW_MARKER)) {
		return { block: false };
	}
	const touchesSources = SOURCE_EXT_RE.test(command);
	if (
		touchesSources &&
		(IN_PLACE_SED_RE.test(command) || IN_PLACE_PERL_RE.test(command))
	) {
		return { block: true, reason: EDIT_BLOCK_MESSAGE };
	}
	for (const tokens of splitSimpleCommands(command)) {
		if (classifySearchCommand(tokens) !== undefined) {
			return { block: true, reason: SEARCH_BLOCK_MESSAGE };
		}
	}
	return { block: false };
}

/**
 * Same policy for a harness's native Grep tool (always recursive): block bare
 * identifier lookups unless the call is scoped to non-source files or a single
 * file.
 */
export function evaluateGrepToolInput(input: {
	pattern?: unknown;
	path?: unknown;
	glob?: unknown;
	type?: unknown;
}): HookVerdict {
	const { pattern, path, glob, type } = input;
	if (typeof pattern !== "string") {
		return { block: false };
	}
	if (typeof glob === "string" && !SOURCE_EXT_RE.test(glob)) {
		return { block: false };
	}
	if (typeof type === "string" && !RG_SOURCE_TYPES.has(type)) {
		return { block: false };
	}
	if (typeof path === "string" && path !== "" && isNonSourcePath(path)) {
		return { block: false };
	}
	if (typeof path === "string" && SOURCE_EXT_RE.test(path)) {
		// A single-file lookup is not a project-wide reference hunt.
		return { block: false };
	}
	if (
		IDENTIFIER_RE.test(pattern) &&
		!COMMENT_MARKER_WORDS.has(pattern.toUpperCase())
	) {
		return { block: true, reason: GREP_TOOL_BLOCK_MESSAGE };
	}
	return { block: false };
}

interface Writer {
	write(chunk: string): unknown;
}

/**
 * `ts-surgeon hook` — reads the harness's PreToolUse JSON payload from stdin
 * ({ tool_name, tool_input }) and exits 2 with a stderr message to block, 0 to
 * allow. Handles Bash commands and the harness's native Grep tool. `--strict`
 * is accepted as a deprecated no-op (the strict/default split is retired; the
 * one shipped mode both blocks in-place edits and redirects searches).
 */
export function runHook(
	rest: string[],
	readStdin: StdinReader,
	err: Writer,
): number {
	for (const arg of rest) {
		if (arg !== "--strict") {
			throw new CliUsageError(`Unknown option for hook: '${arg}'`);
		}
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
	const { tool_name, tool_input } = payload as {
		tool_name?: string;
		tool_input?: Record<string, unknown>;
	};
	let verdict: HookVerdict = { block: false };
	if (tool_name === "Bash" && typeof tool_input?.command === "string") {
		verdict = evaluateBashCommand(tool_input.command);
	} else if (tool_name === "Grep" && tool_input) {
		verdict = evaluateGrepToolInput(tool_input);
	}
	if (verdict.block) {
		err.write(`${verdict.reason}\n`);
		return 2;
	}
	return 0;
}

const HOOK_COMMAND = "npx -y @commoncurriculum/ts-surgeon hook";

/** Contents of the generated opencode plugin (see installOpencodeHook). */
const OPENCODE_PLUGIN = `// Installed by \`ts-surgeon init --opencode-hook\`.
// Guards against hand-rolled TS/JS refactors: every bash tool call is checked
// by \`ts-surgeon hook\` (exit 2 = block, stderr explains what to use instead).
// Prefix a command with ${ALLOW_MARKER} to bypass. Delete this file to remove.
import { spawnSync } from "node:child_process";

export const TsSurgeonGuard = async () => ({
	"tool.execute.before": async (input, output) => {
		if (input.tool !== "bash") return;
		const command = output?.args?.command;
		if (typeof command !== "string") return;
		const payload = JSON.stringify({
			tool_name: "Bash",
			tool_input: { command },
		});
		const result = spawnSync(
			"npx",
			["-y", "@commoncurriculum/ts-surgeon", "hook"],
			{ input: payload, encoding: "utf-8" },
		);
		if (result.status === 2) {
			throw new Error(
				(result.stderr || "").trim() || "ts-surgeon blocked this command",
			);
		}
	},
});
`;

/**
 * Installs the guard as an opencode plugin
 * (.opencode/plugin/ts-surgeon.js). Idempotent.
 */
export function installOpencodeHook(cwd: string, out: Writer): void {
	const pluginPath = path.join(cwd, ".opencode", "plugin", "ts-surgeon.js");
	if (existsSync(pluginPath)) {
		out.write(`${pluginPath} already exists — nothing to do.\n`);
		return;
	}
	mkdirSync(path.dirname(pluginPath), { recursive: true });
	writeFileSync(pluginPath, OPENCODE_PLUGIN);
	out.write(
		`Installed the ts-surgeon guard as an opencode plugin at ${pluginPath} (blocks sed/perl -i on TS/JS sources and recursive identifier searches; prefix a command with ${ALLOW_MARKER} to bypass).\n`,
	);
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
		hooks?: Array<{ type?: string; command?: string }>;
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
		hooks: [{ type: "command", command: HOOK_COMMAND }],
	});

	mkdirSync(path.dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	out.write(
		`Installed the ts-surgeon PreToolUse guard in ${settingsPath} (blocks sed/perl -i on TS/JS sources and recursive identifier searches; prefix a command with ${ALLOW_MARKER} to bypass).\n`,
	);
}
