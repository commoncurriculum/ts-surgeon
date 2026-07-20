import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { getFileText } from "../_test-utils/get-file-text.js";
import { addMissingImportsOnProject } from "./add-missing-imports.js";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	// Persist the baseline so only files changed by the tool show up as modified.
	project.saveSync();
	return project;
}

describe("addMissingImports", () => {
	it("adds an import for an unresolved identifier", async () => {
		const project = setup({
			"/src/button.ts": "export function Button() {}\n",
			"/src/app.ts": "Button();\n",
		});

		const result = await addMissingImportsOnProject(project, {
			filePaths: ["/src/app.ts"],
		});

		expect(result.changedFiles).toEqual(["/src/app.ts"]);
		expect(getFileText(project, "/src/app.ts")).toContain(
			'import { Button } from "./button"',
		);
	});

	it("adds a missing specifier to an existing import declaration", async () => {
		const project = setup({
			"/src/m.ts": "export const a = 1;\nexport const b = 2;\n",
			"/src/app.ts": 'import { a } from "./m";\nconsole.log(a, b);\n',
		});

		await addMissingImportsOnProject(project, { filePaths: ["/src/app.ts"] });

		const text = getFileText(project, "/src/app.ts");
		expect(text).toContain("a");
		expect(text).toContain("b");
		expect(text).toMatch(/import \{[^}]*\bb\b[^}]*\} from "\.\/m"/);
	});

	it("leaves a file with no missing imports unchanged", async () => {
		const project = setup({
			"/src/app.ts": "export const x = 1;\nconsole.log(x);\n",
		});

		const result = await addMissingImportsOnProject(project, {
			filePaths: ["/src/app.ts"],
		});

		expect(result.changedFiles).toEqual([]);
	});

	it("processes every non-declaration file when no paths are given", async () => {
		const project = setup({
			"/src/button.ts": "export function Button() {}\n",
			"/src/a.ts": "Button();\n",
			"/src/b.ts": "export const y = 1;\n",
		});

		const result = await addMissingImportsOnProject(project, {});

		expect(result.processedFileCount).toBe(3);
		expect(result.changedFiles).toEqual(["/src/a.ts"]);
		expect(getFileText(project, "/src/a.ts")).toContain(
			'import { Button } from "./button"',
		);
	});

	it("does not save in dryRun mode", async () => {
		const project = setup({
			"/src/button.ts": "export function Button() {}\n",
			"/src/app.ts": "Button();\n",
		});

		const result = await addMissingImportsOnProject(project, {
			filePaths: ["/src/app.ts"],
			dryRun: true,
		});

		expect(result.changedFiles).toEqual(["/src/app.ts"]);
		expect(project.getSourceFileOrThrow("/src/app.ts").isSaved()).toBe(false);
	});

	it("throws when a requested file does not exist", async () => {
		const project = setup({ "/src/app.ts": "export const x = 1;\n" });

		await expect(
			addMissingImportsOnProject(project, { filePaths: ["/src/missing.ts"] }),
		).rejects.toThrow(/File not found/);
	});
});
