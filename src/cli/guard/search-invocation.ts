/**
 * Stage 2 of the guard pipeline: turn one simple command's tokens into a
 * structured model of the search it performs — which tool, which regex
 * syntax the pattern is written in, every pattern, and the flags that change
 * what the search means (recursion, inversion, scope filters).
 */

export type PatternSyntax = "bre" | "ere" | "fixed";

export interface SearchInvocation {
	tool: "grep" | "rg" | "git-grep";
	syntax: PatternSyntax;
	/** Every pattern: all -e/--regexp values, or the first positional. */
	patterns: string[];
	/** -r/-R/--recursive was passed (rg and git grep recurse by default). */
	recursiveFlag: boolean;
	/** The search runs under xargs/find/etc. — file set unknown, assume many. */
	viaWrapper: boolean;
	/** -v/-L: matches (or files) WITHOUT the pattern — not a reference hunt. */
	invert: boolean;
	includeGlobs: string[];
	rgTypes: string[];
	paths: string[];
}

/**
 * A harness's native Grep tool call IS an rg invocation: always recursive,
 * ripgrep regex syntax, one pattern, optional path/glob/type scope filters.
 * Modeling it as one lets the whole guard pipeline (scope, pattern intent,
 * policy, teaching) treat both entry points identically.
 */
export function invocationFromGrepTool(input: {
	pattern?: unknown;
	path?: unknown;
	glob?: unknown;
	type?: unknown;
}): SearchInvocation | undefined {
	if (typeof input.pattern !== "string") {
		return undefined;
	}
	return {
		tool: "rg",
		syntax: "ere",
		patterns: [input.pattern],
		recursiveFlag: true,
		viaWrapper: false,
		invert: false,
		includeGlobs: typeof input.glob === "string" ? [input.glob] : [],
		rgTypes: typeof input.type === "string" ? [input.type] : [],
		paths:
			typeof input.path === "string" && input.path !== "" ? [input.path] : [],
	};
}

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
	"-E", // rg's -E is --encoding, not extended-regexp
	"--glob",
	"--iglob",
	"--type",
	"--type-not",
	"--type-add",
	"--max-depth",
	"--threads",
	"--encoding",
	"--sort",
	"--sortr",
	"--color",
	"--colors",
	"--pre",
]);

function baseName(token: string): string {
	return token.split("/").pop() ?? token;
}

export function parseSearchInvocation(
	tokens: string[],
): SearchInvocation | undefined {
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
	const cmd = baseName(tokens[idx]);
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

	const tool: SearchInvocation["tool"] = isGitGrep
		? "git-grep"
		: cmd === "rg"
			? "rg"
			: "grep";
	let syntax: PatternSyntax =
		cmd === "rg" || cmd === "egrep" ? "ere" : cmd === "fgrep" ? "fixed" : "bre";
	// grep/git grep syntax letters inside a short-flag cluster (-E, -F, -P, -G);
	// rg only has -F (its -E takes an encoding value, handled below).
	const clusterSyntax = (letters: string) => {
		if (letters.includes("F")) syntax = "fixed";
		else if (tool !== "rg" && /[EP]/.test(letters)) syntax = "ere";
		else if (tool !== "rg" && letters.includes("G")) syntax = "bre";
	};

	const argFlags = tool === "rg" ? RG_ARG_FLAGS : GREP_ARG_FLAGS;
	let recursiveFlag = false;
	let invert = false;
	let afterDashDash = false;
	const ePatterns: string[] = [];
	const positionals: string[] = [];
	const includeGlobs: string[] = [];
	const rgTypes: string[] = [];
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
				(tool === "rg" &&
					(name === "-g" || name === "--glob" || name === "--iglob"))
			) {
				const v = value();
				if (v !== undefined) includeGlobs.push(v);
			} else if (tool === "rg" && (name === "-t" || name === "--type")) {
				const v = value();
				if (v !== undefined) rgTypes.push(v);
			} else if (name === "-e" || name === "--regexp") {
				const v = value();
				if (v !== undefined) ePatterns.push(v);
			} else if (name === "--extended-regexp" || name === "--perl-regexp") {
				syntax = "ere";
			} else if (name === "--fixed-strings") {
				syntax = "fixed";
			} else if (name === "--basic-regexp") {
				syntax = "bre";
			} else if (
				name === "--invert-match" ||
				name === "--files-without-match"
			) {
				invert = true;
			} else if (name === "--recursive" || name === "--dereference-recursive") {
				recursiveFlag = true;
			} else if (argFlags.has(name) && inline === undefined) {
				i++; // consume the flag's value
			} else if (!name.startsWith("--")) {
				// Short-flag cluster: pick out the letters that change meaning.
				const letters = name.slice(1);
				if (/[rR]/.test(letters)) recursiveFlag = true;
				if (/[vL]/.test(letters)) invert = true;
				clusterSyntax(letters);
			}
			continue;
		}
		positionals.push(t);
	}

	const patterns = ePatterns.length > 0 ? ePatterns : positionals.slice(0, 1);
	const paths = ePatterns.length > 0 ? positionals : positionals.slice(1);

	return {
		tool,
		syntax,
		patterns,
		recursiveFlag,
		viaWrapper,
		invert,
		includeGlobs,
		rgTypes,
		paths,
	};
}
