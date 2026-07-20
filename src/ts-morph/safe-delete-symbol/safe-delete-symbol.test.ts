import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { getFileText } from "../_test-utils/get-file-text.js";
import { safeDeleteSymbolOnProject } from "./safe-delete-symbol.js";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	project.saveSync();
	return project;
}

describe("safeDeleteSymbol", () => {
	it("deletes an unreferenced function declaration", async () => {
		const project = setup({
			"/src/util.ts": "export function used() {}\nfunction dead() {}\n",
		});

		const result = await safeDeleteSymbolOnProject(project, {
			targetFilePath: "/src/util.ts",
			symbolName: "dead",
		});

		expect(result.deleted).toBe(true);
		expect(result.changedFiles).toEqual(["/src/util.ts"]);
		expect(getFileText(project, "/src/util.ts")).toBe(
			"export function used() {}\n",
		);
	});

	it("refuses to delete a symbol referenced in another file", async () => {
		const project = setup({
			"/src/util.ts": "export function helper() {}\n",
			"/src/app.ts": 'import { helper } from "./util";\nhelper();\n',
		});

		const result = await safeDeleteSymbolOnProject(project, {
			targetFilePath: "/src/util.ts",
			symbolName: "helper",
		});

		expect(result.deleted).toBe(false);
		expect(result.changedFiles).toEqual([]);
		expect(result.blockingReferences.length).toBeGreaterThanOrEqual(1);
		expect(result.blockingReferences[0]?.filePath).toBe("/src/app.ts");
		// The declaration is untouched.
		expect(getFileText(project, "/src/util.ts")).toContain("function helper");
	});

	it("refuses to delete a symbol referenced within the same file", async () => {
		const project = setup({
			"/src/util.ts":
				"function dead() {}\nexport function caller() {\n\tdead();\n}\n",
		});

		const result = await safeDeleteSymbolOnProject(project, {
			targetFilePath: "/src/util.ts",
			symbolName: "dead",
		});

		expect(result.deleted).toBe(false);
		expect(result.blockingReferences[0]?.line).toBe(3);
	});

	it("ignores a self-reference inside the symbol's own body", async () => {
		const project = setup({
			"/src/util.ts":
				"function recur(n: number): number {\n\treturn n <= 0 ? 0 : recur(n - 1);\n}\n",
		});

		const result = await safeDeleteSymbolOnProject(project, {
			targetFilePath: "/src/util.ts",
			symbolName: "recur",
		});

		expect(result.deleted).toBe(true);
		expect(getFileText(project, "/src/util.ts")).toBe("");
	});

	it("deletes all overload signatures plus the implementation", async () => {
		const project = setup({
			"/src/util.ts":
				"function fn(a: number): number;\nfunction fn(a: string): string;\nfunction fn(a: unknown): unknown {\n\treturn a;\n}\n",
		});

		const result = await safeDeleteSymbolOnProject(project, {
			targetFilePath: "/src/util.ts",
			symbolName: "fn",
		});

		expect(result.deleted).toBe(true);
		expect(getFileText(project, "/src/util.ts")).toBe("");
	});

	it("deletes only the matching declarator of a multi-variable statement", async () => {
		const project = setup({
			"/src/util.ts": "const a = 1,\n\tdead = 2;\nexport const keep = a;\n",
		});

		const result = await safeDeleteSymbolOnProject(project, {
			targetFilePath: "/src/util.ts",
			symbolName: "dead",
		});

		expect(result.deleted).toBe(true);
		const text = getFileText(project, "/src/util.ts");
		expect(text).toContain("a = 1");
		expect(text).not.toContain("dead");
	});

	it("treats a local re-export as a blocking reference", async () => {
		const project = setup({
			"/src/util.ts": "function foo() {}\nexport { foo };\n",
		});

		const result = await safeDeleteSymbolOnProject(project, {
			targetFilePath: "/src/util.ts",
			symbolName: "foo",
		});

		expect(result.deleted).toBe(false);
		expect(result.blockingReferences.length).toBeGreaterThanOrEqual(1);
	});

	it("reference-checks each half of a value/type merge independently", async () => {
		// `function Foo` (value) and `type Foo` (type alias) are DISTINCT symbols in
		// ts-morph, so deleting the value half is blocked by the value call `Foo()`
		// while the type alias — still used by `x: Foo` — is correctly left alone
		// rather than being swept into the deletion or treated as a value reference.
		const project = setup({
			"/src/util.ts":
				"export function Foo() {}\ntype Foo = number;\nexport const x: Foo = 1;\nFoo();\n",
		});

		const result = await safeDeleteSymbolOnProject(project, {
			targetFilePath: "/src/util.ts",
			symbolName: "Foo",
		});

		expect(result.deleted).toBe(false);
		expect(result.blockingReferences.length).toBeGreaterThanOrEqual(1);
		expect(result.blockingReferences.some((ref) => ref.line === 4)).toBe(true);
		expect(getFileText(project, "/src/util.ts")).toContain("function Foo");
	});

	it("does not save in dryRun mode", async () => {
		const project = setup({
			"/src/util.ts": "function dead() {}\nexport const x = 1;\n",
		});

		const result = await safeDeleteSymbolOnProject(project, {
			targetFilePath: "/src/util.ts",
			symbolName: "dead",
			dryRun: true,
		});

		expect(result.deleted).toBe(true);
		expect(result.changedFiles).toEqual(["/src/util.ts"]);
		expect(project.getSourceFileOrThrow("/src/util.ts").isSaved()).toBe(false);
	});

	it("throws when the symbol is not found", async () => {
		const project = setup({ "/src/util.ts": "export const a = 1;\n" });

		await expect(
			safeDeleteSymbolOnProject(project, {
				targetFilePath: "/src/util.ts",
				symbolName: "missing",
			}),
		).rejects.toThrow(/No top-level declaration named/);
	});

	it("throws when the file is not found", async () => {
		const project = setup({ "/src/a.ts": "export const a = 1;\n" });

		await expect(
			safeDeleteSymbolOnProject(project, {
				targetFilePath: "/src/missing.ts",
				symbolName: "a",
			}),
		).rejects.toThrow(/File not found/);
	});
});
