import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import {
	disableProjectCache,
	enableProjectCache,
	getTsConfigAliasKeys,
	getTsConfigBaseUrl,
	getTsConfigPaths,
	initializeProject,
} from "./ts-morph-project";

// Real tsconfig on disk for the cache tests (initializeProject reads the filesystem)
const cacheFixtureDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "tsmorph-project-cache-"),
);
const cacheTsconfigPath = path.join(cacheFixtureDir, "tsconfig.json");
fs.writeFileSync(
	cacheTsconfigPath,
	JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
);
fs.writeFileSync(path.join(cacheFixtureDir, "a.ts"), "export const a = 1;\n");

afterAll(() => {
	fs.rmSync(cacheFixtureDir, { recursive: true, force: true });
});

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

describe("project cache (batch mode)", () => {
	afterEach(() => {
		disableProjectCache();
	});

	it("returns fresh instances when the cache is off", () => {
		const a = initializeProject(cacheTsconfigPath);
		const b = initializeProject(cacheTsconfigPath);
		expect(a).not.toBe(b);
	});

	it("reuses one instance per tsconfig while everything is saved", () => {
		enableProjectCache();
		const a = initializeProject(cacheTsconfigPath);
		const b = initializeProject(cacheTsconfigPath);
		expect(a).toBe(b);
	});

	it("refuses to reuse a project with unsaved mutations", () => {
		enableProjectCache();
		const a = initializeProject(cacheTsconfigPath);
		// Simulate a dry run / failed op: mutate without saving.
		a.getSourceFiles()[0].insertText(0, "// dirty\n");

		const b = initializeProject(cacheTsconfigPath);
		expect(b).not.toBe(a);
		// the fresh, fully-saved instance is cached and reused again
		expect(initializeProject(cacheTsconfigPath)).toBe(b);
	});

	it("disable drops everything", () => {
		enableProjectCache();
		const a = initializeProject(cacheTsconfigPath);
		disableProjectCache();
		expect(initializeProject(cacheTsconfigPath)).not.toBe(a);
	});
});
