import { describe, expect, it } from "vitest";
import { isPathAlias } from "./path-alias.js";

describe("isPathAlias", () => {
	it("returns true when the specifier starts with the wildcard alias prefix", () => {
		expect(isPathAlias("@/components/Button", ["@/*"])).toBe(true);
	});

	it("returns false when the specifier does not match the wildcard alias prefix", () => {
		expect(isPathAlias("react", ["@/*"])).toBe(false);
	});

	it("returns true only for an exact match against a non-wildcard alias", () => {
		expect(isPathAlias("@app", ["@app"])).toBe(true);
		expect(isPathAlias("@app/router", ["@app"])).toBe(false);
	});

	it("does not false-positively match a different alias with a similar prefix", () => {
		// "@foobar/baz" is a different alias from "@foo" and should return false
		expect(isPathAlias("@foobar/baz", ["@foo"])).toBe(false);
		// Even with `/*`, the prefix must match up to and including the trailing `/`
		expect(isPathAlias("@foobar/baz", ["@foo/*"])).toBe(false);
	});

	it("always returns false when the alias array is empty", () => {
		expect(isPathAlias("@/components", [])).toBe(false);
	});

	it("returns true when the specifier matches any one of multiple aliases", () => {
		expect(isPathAlias("@components/Card", ["@/*", "@components/*"])).toBe(
			true,
		);
	});

	it("returns true for a hierarchical-prefix wildcard only when the entire prefix matches", () => {
		expect(isPathAlias("@foo/bar/x", ["@foo/bar/*"])).toBe(true);
		// `@foo/barz` does not start with `@foo/bar/` so returns false
		expect(isPathAlias("@foo/barz", ["@foo/bar/*"])).toBe(false);
	});

	// Fixing as spec: wildcards that do not end with `/*` are treated as exact match only
	it.each([
		// "*" alone: exact match only (effectively almost always false)
		{ specifier: "anything", alias: "*", expected: false },
		{ specifier: "*", alias: "*", expected: true },
		// trailing asterisk without `/` like "@*": exact match only, not prefix match
		{ specifier: "@foo", alias: "@*", expected: false },
		{ specifier: "@*", alias: "@*", expected: true },
		// trailing `/` only (no `*`): exact match only
		{ specifier: "@/foo", alias: "@/", expected: false },
		{ specifier: "@/", alias: "@/", expected: true },
		// empty string alias (defense against malformed tsconfig)
		{ specifier: "x", alias: "", expected: false },
		{ specifier: "", alias: "", expected: true },
	])(
		"alias=$alias / specifier=$specifier returns $expected",
		({ specifier, alias, expected }) => {
			expect(isPathAlias(specifier, [alias])).toBe(expected);
		},
	);
});
