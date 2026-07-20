import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { getFileText } from "../_test-utils/get-file-text.js";
import { organizeImportsOnProject } from "./organize-imports.js";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	// Persist the baseline so only files changed by organizeImports show up as
	// modified (on disk, source files start saved).
	project.saveSync();
	return project;
}

describe("organizeImports", () => {
	it("removes an unused named import specifier", async () => {
		const project = setup({
			"/src/m.ts": "export const used = 1;\nexport const unused = 2;\n",
			"/src/app.ts":
				'import { used, unused } from "./m";\nconsole.log(used);\n',
		});

		const result = await organizeImportsOnProject(project, {
			filePaths: ["/src/app.ts"],
		});

		expect(result.changedFiles).toEqual(["/src/app.ts"]);
		expect(getFileText(project, "/src/app.ts")).toBe(
			'import { used } from "./m";\nconsole.log(used);\n',
		);
	});

	it("removes an entirely unused import declaration", async () => {
		const project = setup({
			"/src/m.ts": "export const foo = 1;\n",
			"/src/app.ts": 'import { foo } from "./m";\nexport const x = 1;\n',
		});

		await organizeImportsOnProject(project, { filePaths: ["/src/app.ts"] });

		expect(getFileText(project, "/src/app.ts")).toBe("export const x = 1;\n");
	});

	it("coalesces and sorts imports from the same module", async () => {
		const project = setup({
			"/src/m.ts": "export const a = 1;\nexport const b = 2;\n",
			"/src/app.ts":
				'import { b } from "./m";\nimport { a } from "./m";\nconsole.log(a, b);\n',
		});

		await organizeImportsOnProject(project, { filePaths: ["/src/app.ts"] });

		expect(getFileText(project, "/src/app.ts")).toBe(
			'import { a, b } from "./m";\nconsole.log(a, b);\n',
		);
	});

	it("keeps side-effect-only imports", async () => {
		const project = setup({
			"/src/side.ts": "console.log('side effect');\n",
			"/src/app.ts": 'import "./side";\nexport const x = 1;\n',
		});

		const result = await organizeImportsOnProject(project, {
			filePaths: ["/src/app.ts"],
		});

		expect(result.changedFiles).toEqual([]);
		expect(getFileText(project, "/src/app.ts")).toBe(
			'import "./side";\nexport const x = 1;\n',
		);
	});

	it("organizes every non-declaration file when no paths are given", async () => {
		const project = setup({
			"/src/m.ts": "export const used = 1;\nexport const unused = 2;\n",
			"/src/a.ts": 'import { used, unused } from "./m";\nconsole.log(used);\n',
			"/src/b.ts": 'import { unused } from "./m";\nexport const y = 1;\n',
		});

		const result = await organizeImportsOnProject(project, {});

		expect(result.organizedFileCount).toBe(3);
		expect(result.changedFiles.sort()).toEqual(["/src/a.ts", "/src/b.ts"]);
		expect(getFileText(project, "/src/a.ts")).toBe(
			'import { used } from "./m";\nconsole.log(used);\n',
		);
		expect(getFileText(project, "/src/b.ts")).toBe("export const y = 1;\n");
	});

	it("does not save in dryRun mode", async () => {
		const project = setup({
			"/src/m.ts": "export const used = 1;\nexport const unused = 2;\n",
			"/src/app.ts":
				'import { used, unused } from "./m";\nconsole.log(used);\n',
		});

		const result = await organizeImportsOnProject(project, {
			filePaths: ["/src/app.ts"],
			dryRun: true,
		});

		expect(result.changedFiles).toEqual(["/src/app.ts"]);
		expect(project.getSourceFileOrThrow("/src/app.ts").isSaved()).toBe(false);
	});

	it("throws when a requested file does not exist", async () => {
		const project = setup({ "/src/app.ts": "export const x = 1;\n" });

		await expect(
			organizeImportsOnProject(project, { filePaths: ["/src/missing.ts"] }),
		).rejects.toThrow(/File not found/);
	});
});
