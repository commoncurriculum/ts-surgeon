import { describe, expect, it } from "vitest";
import { parseSearchInvocation } from "./search-invocation";
import { splitSimpleCommands } from "./shell";

/** Parses the FIRST simple command of a shell string as a search invocation. */
function parse(command: string) {
	return parseSearchInvocation(splitSimpleCommands(command)[0]);
}

describe("parseSearchInvocation", () => {
	it("models a plain recursive grep", () => {
		const inv = parse("grep -rn calculateSum src/");
		expect(inv).toMatchObject({
			tool: "grep",
			syntax: "bre",
			patterns: ["calculateSum"],
			recursiveFlag: true,
			invert: false,
			paths: ["src/"],
		});
	});

	it("detects the regex syntax per tool and flag", () => {
		expect(parse("grep -r foo src/")?.syntax).toBe("bre");
		expect(parse("grep -rE 'foo|bar' src/")?.syntax).toBe("ere");
		expect(parse("grep -r -E 'foo|bar' src/")?.syntax).toBe("ere");
		expect(parse("grep -r --extended-regexp foo src/")?.syntax).toBe("ere");
		expect(parse("grep -rP 'foo' src/")?.syntax).toBe("ere");
		expect(parse("grep -rF 'a|b' src/")?.syntax).toBe("fixed");
		expect(parse("grep -r --fixed-strings 'a|b' src/")?.syntax).toBe("fixed");
		expect(parse("egrep -r foo src/")?.syntax).toBe("ere");
		expect(parse("fgrep -r foo src/")?.syntax).toBe("fixed");
		expect(parse("rg foo src/")?.syntax).toBe("ere");
		expect(parse("rg -F 'a|b' src/")?.syntax).toBe("fixed");
		expect(parse("git grep -n foo")?.syntax).toBe("bre");
		expect(parse("git grep -En 'foo|bar'")?.syntax).toBe("ere");
	});

	it("treats rg's -E as --encoding (a value flag), not a syntax flag", () => {
		const inv = parse("rg -E utf-8 calculateSum src/");
		expect(inv?.syntax).toBe("ere");
		expect(inv?.patterns).toEqual(["calculateSum"]);
		expect(inv?.paths).toEqual(["src/"]);
	});

	it("collects every -e/--regexp pattern; positionals become paths", () => {
		const inv = parse("grep -rn -e calculateSum -e cartTotal src/ lib/");
		expect(inv?.patterns).toEqual(["calculateSum", "cartTotal"]);
		expect(inv?.paths).toEqual(["src/", "lib/"]);
	});

	it("flags inverted and files-without-match searches", () => {
		expect(parse("grep -rv calculateSum src/")?.invert).toBe(true);
		expect(parse("grep -r --invert-match foo src/")?.invert).toBe(true);
		expect(parse("grep -rL calculateSum src/")?.invert).toBe(true);
		expect(parse("rg --files-without-match foo src/")?.invert).toBe(true);
	});

	it("captures scope filters", () => {
		const inv = parse("grep -rn --include='*.md' foo docs/");
		expect(inv?.includeGlobs).toEqual(["*.md"]);
		expect(parse("rg -t md foo")?.rgTypes).toEqual(["md"]);
	});

	it("returns undefined for non-search commands and grep-as-argument", () => {
		expect(parse("ls -la")).toBeUndefined();
		expect(parse("echo grep foo")).toBeUndefined();
	});

	it("sees through wrappers and leading assignments", () => {
		expect(parse("TS_SURGEON_ALLOW=1 grep -rn foo src/")?.tool).toBe("grep");
		expect(parse("xargs grep -n useThing")?.viaWrapper).toBe(true);
	});
});
