import { describe, it, expect, vi } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import {
	getTsConfigAliasKeys,
	getTsConfigBaseUrl,
	getTsConfigPaths,
} from "./ts-morph-project";

vi.mock("../../utils/logger");

describe("getTsConfigPaths", () => {
	it("returns undefined when paths is not configured", () => {
		const project = createInMemoryProject({ pathAliases: {} });
		project.compilerOptions.set({ baseUrl: ".", paths: undefined });
		expect(getTsConfigPaths(project)).toBeUndefined();
	});

	it("returns valid paths", () => {
		const project = createInMemoryProject({
			pathAliases: { "@/*": ["src/*"], "@lib/*": ["lib/*"] },
		});
		expect(getTsConfigPaths(project)).toEqual({
			"@/*": ["src/*"],
			"@lib/*": ["lib/*"],
		});
	});

	it("skips entries whose paths value is not a string array", () => {
		const project = createInMemoryProject();
		project.compilerOptions.set({
			baseUrl: ".",
			paths: {
				"@/*": ["src/*"],
				// @ts-expect-error verify behavior with invalid value
				"@bad": "not-an-array",
				// @ts-expect-error verify behavior with invalid value
				"@mixed/*": [123, "lib/*"],
			},
		});

		expect(getTsConfigPaths(project)).toEqual({ "@/*": ["src/*"] });
	});

	it("returns undefined when paths is not an object", () => {
		const project = createInMemoryProject();
		// @ts-expect-error verify behavior with invalid value
		project.compilerOptions.set({ baseUrl: ".", paths: "invalid" });
		expect(getTsConfigPaths(project)).toBeUndefined();
	});
});

describe("getTsConfigAliasKeys", () => {
	it("returns the list of keys from paths", () => {
		const project = createInMemoryProject({
			pathAliases: { "@/*": ["src/*"], "@lib/*": ["lib/*"] },
		});
		expect(getTsConfigAliasKeys(project).sort()).toEqual(["@/*", "@lib/*"]);
	});

	it("returns an empty array when paths is absent", () => {
		const project = createInMemoryProject({ pathAliases: {} });
		project.compilerOptions.set({ baseUrl: ".", paths: undefined });
		expect(getTsConfigAliasKeys(project)).toEqual([]);
	});
});

describe("getTsConfigBaseUrl", () => {
	it("returns the baseUrl", () => {
		const project = createInMemoryProject();
		expect(getTsConfigBaseUrl(project)).toBe(".");
	});

	it("returns undefined when baseUrl is not configured", () => {
		const project = createInMemoryProject();
		project.compilerOptions.set({ baseUrl: undefined });
		expect(getTsConfigBaseUrl(project)).toBeUndefined();
	});
});
