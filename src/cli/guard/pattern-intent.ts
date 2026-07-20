import type { PatternSyntax } from "./search-invocation";

/**
 * Stage 3 of the guard pipeline: what is this pattern actually hunting?
 *
 * A search pattern decomposes — per regex syntax — into top-level alternation
 * branches; each branch is an identifier once its decorations are stripped
 * (anchors, word boundaries, call parens, whitespace atoms), or it is not.
 * Only when EVERY branch names an identifier can find_references answer the
 * whole search; one opaque branch (free text, a true regex, a comment
 * marker) means the search wants something the AST lookup cannot cover, so
 * the guard must not intercept it.
 */

export type PatternIntent =
	| { kind: "identifiers"; symbols: string[] }
	| { kind: "dynamic" }
	| { kind: "opaque" };

/** Above this, an alternation is an audit sweep, not a symbol lookup. */
export const MAX_ANSWERABLE_SYMBOLS = 8;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A hunt for a declaration site ("function renderStringAsData", "export const
 * cartTotal") is an identifier lookup wearing a two-word coat — observed in a
 * real transcript, 2026-07-19. Regex-y patterns (`function\s+\w+`) don't match.
 */
const DECLARATION_PATTERN_RE =
	/^(export +)?(async +)?(function|const|let|var|class|interface|type|enum) +[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * `$name` / `${name}` / `$(cmd)` — a shell expansion, so the text is
 * runtime-computed. Applies to patterns here and to search roots in policy.
 */
export const SHELL_EXPANSION_RE = /\$[A-Za-z_{(]/;

/** Bare words that look like identifiers but are comment markers, not code. */
const COMMENT_MARKER_WORDS = new Set([
	"TODO",
	"FIXME",
	"XXX",
	"HACK",
	"NOTE",
	"WIP",
]);

/**
 * TS/JS reserved words and primitive type names. A pattern like `^export` or
 * `import` is a structure sweep (mined from real transcripts, 2026-07-20),
 * not a symbol lookup — find_references has nothing to say about it.
 */
const RESERVED_WORDS = new Set([
	"export",
	"import",
	"function",
	"const",
	"let",
	"var",
	"class",
	"interface",
	"type",
	"enum",
	"return",
	"async",
	"await",
	"default",
	"from",
	"extends",
	"implements",
	"new",
	"this",
	"super",
	"void",
	"typeof",
	"delete",
	"in",
	"of",
	"if",
	"else",
	"for",
	"while",
	"do",
	"switch",
	"case",
	"break",
	"continue",
	"try",
	"catch",
	"finally",
	"throw",
	"yield",
	"static",
	"public",
	"private",
	"protected",
	"readonly",
	"abstract",
	"as",
	"is",
	"keyof",
	"infer",
	"namespace",
	"module",
	"declare",
	"require",
	"null",
	"undefined",
	"true",
	"false",
	"string",
	"number",
	"boolean",
	"object",
	"symbol",
	"any",
	"unknown",
	"never",
]);

/**
 * Zero-width / punctuation atoms that decorate an identifier without changing
 * which symbol is hunted. A trailing paren is included when the syntax makes
 * it (or its escaped form) a literal — `calculateSum\(` in ERE, or
 * `calculateSum(` where `(` is literal (BRE) or could not open a valid group
 * anyway (a dangling `(` in ERE).
 */
const PREFIX_ATOMS: Record<PatternSyntax, string[]> = {
	// "new " covers constructor-site hunts (`grep -rn "new SurfaceArbiter"` —
	// mined from a real transcript, 2026-07-20).
	bre: ["^", "\\b", "\\<", "\\s*", "\\s+", "\\.", "new "],
	ere: ["^", "\\b", "\\<", "\\s*", "\\s+", "\\.", "new "],
	fixed: [".", "new "],
};
const SUFFIX_ATOMS: Record<PatternSyntax, string[]> = {
	// "=" (with optional space) covers assignment-site hunts
	// (`grep -rn "CardColorType ="` — mined from a real transcript, 2026-07-20).
	bre: ["$", "\\b", "\\>", "\\s*", "\\s+", "()", "(", "=", " "],
	ere: [
		"$",
		"\\b",
		"\\>",
		"\\s*",
		"\\s+",
		"\\(\\)",
		"\\(",
		"()",
		"(",
		"=",
		" ",
	],
	fixed: ["()", "(", "=", " "],
};

function stripDecorations(pattern: string, syntax: PatternSyntax): string {
	let cur = pattern.trim();
	let changed = true;
	while (changed) {
		changed = false;
		for (const atom of PREFIX_ATOMS[syntax]) {
			if (cur.startsWith(atom) && cur.length > atom.length) {
				cur = cur.slice(atom.length);
				changed = true;
			}
		}
		for (const atom of SUFFIX_ATOMS[syntax]) {
			if (cur.endsWith(atom) && cur.length > atom.length) {
				cur = cur.slice(0, -atom.length);
				changed = true;
			}
		}
	}
	return cur;
}

/**
 * Splits a pattern at top-level alternation operators: `|` in ERE, `\|` in
 * BRE, never in fixed strings. Escapes, character classes, and group nesting
 * are honored so `(a|b)c` does not split at the inner `|`.
 */
function splitTopLevelAlternation(
	pattern: string,
	syntax: PatternSyntax,
): string[] {
	if (syntax === "fixed") {
		return [pattern];
	}
	const parts: string[] = [];
	let cur = "";
	let depth = 0;
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "\\" && i + 1 < pattern.length) {
			const next = pattern[i + 1];
			if (syntax === "bre" && !inClass) {
				if (next === "|" && depth === 0) {
					parts.push(cur);
					cur = "";
					i++;
					continue;
				}
				if (next === "(") depth++;
				if (next === ")") depth = Math.max(0, depth - 1);
			}
			cur += c + next;
			i++;
			continue;
		}
		if (inClass) {
			if (c === "]") inClass = false;
			cur += c;
			continue;
		}
		if (c === "[") {
			inClass = true;
			cur += c;
			continue;
		}
		if (syntax === "ere") {
			if (c === "(") depth++;
			if (c === ")") depth = Math.max(0, depth - 1);
			if (c === "|" && depth === 0) {
				parts.push(cur);
				cur = "";
				continue;
			}
		}
		cur += c;
	}
	parts.push(cur);
	return parts;
}

/**
 * When one group wraps the ENTIRE pattern — `(a|b)` in ERE (incl. `(?:...)`),
 * `\(a\|b\)` in BRE — returns the inner text; otherwise undefined.
 */
function unwrapWholeGroup(
	pattern: string,
	syntax: PatternSyntax,
): string | undefined {
	if (syntax === "ere") {
		if (!pattern.startsWith("(") || !pattern.endsWith(")")) {
			return undefined;
		}
		let depth = 0;
		for (let i = 0; i < pattern.length; i++) {
			const c = pattern[i];
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === "(") depth++;
			else if (c === ")") {
				depth--;
				if (depth === 0 && i !== pattern.length - 1) return undefined;
			}
		}
		if (depth !== 0) return undefined;
		let inner = pattern.slice(1, -1);
		if (inner.startsWith("?:")) inner = inner.slice(2);
		return inner;
	}
	if (syntax === "bre") {
		if (!pattern.startsWith("\\(") || !pattern.endsWith("\\)")) {
			return undefined;
		}
		let depth = 0;
		for (let i = 0; i < pattern.length - 1; i++) {
			if (pattern[i] !== "\\") continue;
			const next = pattern[i + 1];
			if (next === "(") depth++;
			else if (next === ")") {
				depth--;
				if (depth === 0 && i + 1 !== pattern.length - 1) return undefined;
			}
			i++;
		}
		if (depth !== 0) return undefined;
		return pattern.slice(2, -2);
	}
	return undefined;
}

/**
 * The identifiers one alternation branch hunts, or undefined when the branch
 * is anything else (free text, a true regex, a comment marker).
 */
function collectBranchSymbols(
	branch: string,
	syntax: PatternSyntax,
	depth: number,
): string[] | undefined {
	if (depth > 4) {
		return undefined;
	}
	const core = stripDecorations(branch, syntax);
	if (core === "") {
		return undefined;
	}
	if (IDENTIFIER_RE.test(core)) {
		return COMMENT_MARKER_WORDS.has(core.toUpperCase()) ||
			RESERVED_WORDS.has(core)
			? undefined
			: [core];
	}
	if (DECLARATION_PATTERN_RE.test(core)) {
		const name = core.split(/\s+/).pop();
		return name === undefined ? undefined : [name];
	}
	const inner = unwrapWholeGroup(core, syntax);
	if (inner !== undefined) {
		const symbols: string[] = [];
		for (const sub of splitTopLevelAlternation(inner, syntax)) {
			const found = collectBranchSymbols(sub, syntax, depth + 1);
			if (found === undefined) {
				return undefined;
			}
			symbols.push(...found);
		}
		return symbols;
	}
	return undefined;
}

/** Classifies what a search's pattern set is hunting. */
export function analyzePatterns(
	patterns: string[],
	syntax: PatternSyntax,
): PatternIntent {
	if (patterns.some((p) => SHELL_EXPANSION_RE.test(p))) {
		return { kind: "dynamic" };
	}
	// grep treats embedded newlines as additional patterns.
	const expanded = patterns
		.flatMap((p) => p.split("\n"))
		.filter((p) => p.trim() !== "");
	if (expanded.length === 0) {
		return { kind: "opaque" };
	}
	const symbols: string[] = [];
	for (const pattern of expanded) {
		for (const branch of splitTopLevelAlternation(pattern, syntax)) {
			const found = collectBranchSymbols(branch, syntax, 0);
			if (found === undefined) {
				return { kind: "opaque" };
			}
			symbols.push(...found);
		}
	}
	const unique = [...new Set(symbols)];
	if (unique.length === 0 || unique.length > MAX_ANSWERABLE_SYMBOLS) {
		return { kind: "opaque" };
	}
	return { kind: "identifiers", symbols: unique };
}
