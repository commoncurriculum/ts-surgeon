import { describe, expect, it } from "vitest";
import { analyzePatterns, MAX_ANSWERABLE_SYMBOLS } from "./pattern-intent";
import type { PatternSyntax } from "./search-invocation";

/**
 * Table-driven coverage of pattern semantics per regex syntax. Each row is a
 * pattern shape agents actually type; `expect` is either the symbol list an
 * answer should target, "opaque" (nothing to answer — let the search run or
 * fall through to other policy), or "dynamic" (runtime-computed).
 */
type Expected = string[] | "opaque" | "dynamic";

const CASES: Array<{
	patterns: string[];
	syntax: PatternSyntax;
	expected: Expected;
	why?: string;
}> = [
	// ── Bare identifiers (all syntaxes) ─────────────────────────────────────
	{ patterns: ["calculateSum"], syntax: "bre", expected: ["calculateSum"] },
	{ patterns: ["calculateSum"], syntax: "ere", expected: ["calculateSum"] },
	{ patterns: ["calculateSum"], syntax: "fixed", expected: ["calculateSum"] },
	{ patterns: ["_privateThing"], syntax: "ere", expected: ["_privateThing"] },

	// ── Alternation: syntax decides what `|` means ──────────────────────────
	{ patterns: ["foo|bar"], syntax: "ere", expected: ["foo", "bar"] },
	{
		patterns: ["standardNode|cardNode|googleClassroomCardNode"],
		syntax: "ere",
		expected: ["standardNode", "cardNode", "googleClassroomCardNode"],
	},
	{
		// BRE alternation is \| — the exact transcript shape.
		patterns: [
			"standardNode\\|export function cardNode\\|googleClassroomCardNode",
		],
		syntax: "bre",
		expected: ["standardNode", "cardNode", "googleClassroomCardNode"],
	},
	{
		patterns: ["foo|bar"],
		syntax: "bre",
		expected: "opaque",
		why: "in BRE a plain | is a literal pipe character",
	},
	{
		patterns: ["foo\\|bar"],
		syntax: "ere",
		expected: "opaque",
		why: "in ERE \\| is a literal pipe character",
	},
	{
		patterns: ["foo|bar"],
		syntax: "fixed",
		expected: "opaque",
		why: "fixed strings have no alternation",
	},
	{ patterns: ["(foo|bar)"], syntax: "ere", expected: ["foo", "bar"] },
	{ patterns: ["(?:foo|bar)"], syntax: "ere", expected: ["foo", "bar"] },
	{ patterns: ["\\(foo\\|bar\\)"], syntax: "bre", expected: ["foo", "bar"] },

	// ── Decorated identifiers: anchors, word boundaries, call sites ─────────
	{ patterns: ["^cartTotal$"], syntax: "ere", expected: ["cartTotal"] },
	{
		patterns: ["\\bcalculateSum\\b"],
		syntax: "ere",
		expected: ["calculateSum"],
	},
	{ patterns: ["\\<cartTotal\\>"], syntax: "bre", expected: ["cartTotal"] },
	{ patterns: ["calculateSum\\("], syntax: "ere", expected: ["calculateSum"] },
	{
		patterns: ["calculateSum\\s*\\("],
		syntax: "ere",
		expected: ["calculateSum"],
	},
	{
		patterns: ["calculateSum("],
		syntax: "bre",
		expected: ["calculateSum"],
		why: "in BRE a paren is literal — this hunts call sites",
	},
	{ patterns: ["calculateSum("], syntax: "fixed", expected: ["calculateSum"] },
	{ patterns: ["\\.pushSlide"], syntax: "ere", expected: ["pushSlide"] },
	{ patterns: [".pushSlide"], syntax: "fixed", expected: ["pushSlide"] },
	{ patterns: ["(foo|bar)\\("], syntax: "ere", expected: ["foo", "bar"] },

	// ── Declaration hunts ───────────────────────────────────────────────────
	{
		patterns: ["function renderStringAsData"],
		syntax: "bre",
		expected: ["renderStringAsData"],
	},
	{
		patterns: ["export const cartTotal"],
		syntax: "ere",
		expected: ["cartTotal"],
	},
	{
		patterns: ["^export const cartTotal"],
		syntax: "ere",
		expected: ["cartTotal"],
	},

	// ── Multiple patterns (-e / embedded newlines) ──────────────────────────
	{ patterns: ["foo", "bar"], syntax: "ere", expected: ["foo", "bar"] },
	{ patterns: ["foo\nbar"], syntax: "bre", expected: ["foo", "bar"] },
	{ patterns: ["foo", "some free text"], syntax: "ere", expected: "opaque" },

	// ── Genuinely opaque: free text, true regexes, markers ──────────────────
	{ patterns: ["foo bar"], syntax: "ere", expected: "opaque" },
	{ patterns: ["function\\s+\\w+"], syntax: "ere", expected: "opaque" },
	{ patterns: ["foo.*bar"], syntax: "ere", expected: "opaque" },
	{
		patterns: ["export (function|const) [A-Za-z_]+"],
		syntax: "ere",
		expected: "opaque",
	},
	{ patterns: ["TODO"], syntax: "ere", expected: "opaque" },
	{ patterns: ["TODO|FIXME"], syntax: "ere", expected: "opaque" },
	{
		patterns: ["TODO|calculateSum"],
		syntax: "ere",
		expected: "opaque",
		why: "a marker branch means comment context — cannot answer the whole search",
	},
	{
		patterns: [".pushSlide"],
		syntax: "ere",
		expected: "opaque",
		why: "a bare leading dot is any-char in a regex — do not guess",
	},
	{
		patterns: Array.from(
			{ length: MAX_ANSWERABLE_SYMBOLS + 2 },
			(_, i) => `sym${i}`,
		),
		syntax: "ere",
		expected: "opaque",
		why: "a giant alternation is a sweep, not a lookup",
	},

	// ── Dynamic (runtime-computed) ──────────────────────────────────────────
	{ patterns: ["$name"], syntax: "bre", expected: "dynamic" },
	{ patterns: ["${name}"], syntax: "ere", expected: "dynamic" },
	{ patterns: ["prefix$(cmd)"], syntax: "ere", expected: "dynamic" },
];

describe("analyzePatterns", () => {
	for (const { patterns, syntax, expected, why } of CASES) {
		const label = `${syntax}: ${JSON.stringify(patterns)} → ${JSON.stringify(expected)}${why ? ` (${why})` : ""}`;
		it(label, () => {
			const intent = analyzePatterns(patterns, syntax);
			if (expected === "opaque" || expected === "dynamic") {
				expect(intent.kind).toBe(expected);
			} else {
				expect(intent).toEqual({ kind: "identifiers", symbols: expected });
			}
		});
	}

	it("dedupes repeated symbols across branches and patterns", () => {
		expect(analyzePatterns(["foo|bar", "foo"], "ere")).toEqual({
			kind: "identifiers",
			symbols: ["foo", "bar"],
		});
	});
});
