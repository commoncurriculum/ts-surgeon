import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import { getFileText } from "../_test-utils/get-file-text";
import { applyCodeFixOnProject } from "./apply-code-fix";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	project.saveSync();
	return project;
}

describe("applyCodeFix", () => {
	describe("remove_unused", () => {
		it("removes an unused local and an unused import", async () => {
			const project = setup({
				"/src/m.ts": "export const used = 1;\nexport const dead = 2;\n",
				"/src/app.ts":
					'import { used, dead } from "./m";\nfunction f() {\n\tconst x = 1;\n\treturn used;\n}\nconsole.log(f());\n',
			});

			const result = await applyCodeFixOnProject(project, {
				fix: "remove_unused",
				filePaths: ["/src/app.ts"],
			});

			expect(result.changedFiles).toEqual(["/src/app.ts"]);
			const text = getFileText(project, "/src/app.ts");
			expect(text).toContain('import { used } from "./m"');
			expect(text).not.toContain("dead");
			expect(text).not.toContain("const x = 1");
		});
	});

	describe("implement_interface", () => {
		it("stubs out missing interface members", async () => {
			const project = setup({
				"/src/c.ts":
					"interface I {\n\tfoo(): number;\n}\nclass C implements I {}\n",
			});

			await applyCodeFixOnProject(project, {
				fix: "implement_interface",
				filePaths: ["/src/c.ts"],
			});

			const text = getFileText(project, "/src/c.ts");
			expect(text).toContain("foo(): number");
			expect(text).toContain("Method not implemented");
		});
	});

	describe("implement_abstract_members", () => {
		it("stubs out inherited abstract members", async () => {
			const project = setup({
				"/src/c.ts":
					"abstract class A {\n\tabstract foo(): number;\n}\nclass C extends A {}\n",
			});

			await applyCodeFixOnProject(project, {
				fix: "implement_abstract_members",
				filePaths: ["/src/c.ts"],
			});

			expect(getFileText(project, "/src/c.ts")).toContain("foo(): number");
		});
	});

	describe("infer_types_from_usage", () => {
		it("infers a parameter type from usage", async () => {
			// inferFromUsage is only offered when implicit-any is an error.
			const project = new Project({
				useInMemoryFileSystem: true,
				compilerOptions: { noImplicitAny: true },
			});
			project.createSourceFile(
				"/src/e.ts",
				"function f(a) {\n\treturn a * 2;\n}\n",
				{
					overwrite: true,
				},
			);
			project.saveSync();

			await applyCodeFixOnProject(project, {
				fix: "infer_types_from_usage",
				filePaths: ["/src/e.ts"],
			});

			expect(getFileText(project, "/src/e.ts")).toContain("a: number");
		});
	});

	it("leaves a file with nothing to fix unchanged", async () => {
		const project = setup({
			"/src/app.ts": "export const x = 1;\nconsole.log(x);\n",
		});

		const result = await applyCodeFixOnProject(project, {
			fix: "remove_unused",
			filePaths: ["/src/app.ts"],
		});

		expect(result.changedFiles).toEqual([]);
	});

	it("processes every non-declaration file when no paths are given", async () => {
		const project = setup({
			"/src/a.ts":
				"function f() {\n\tconst dead = 1;\n\treturn 2;\n}\nconsole.log(f());\n",
			"/src/b.ts": "export const y = 1;\n",
		});

		const result = await applyCodeFixOnProject(project, {
			fix: "remove_unused",
		});

		expect(result.processedFileCount).toBe(2);
		expect(result.changedFiles).toEqual(["/src/a.ts"]);
	});

	it("does not save in dryRun mode", async () => {
		const project = setup({
			"/src/c.ts":
				"interface I {\n\tfoo(): number;\n}\nclass C implements I {}\n",
		});

		const result = await applyCodeFixOnProject(project, {
			fix: "implement_interface",
			filePaths: ["/src/c.ts"],
			dryRun: true,
		});

		expect(result.changedFiles).toEqual(["/src/c.ts"]);
		expect(project.getSourceFileOrThrow("/src/c.ts").isSaved()).toBe(false);
	});

	it("throws when a requested file does not exist", async () => {
		const project = setup({ "/src/app.ts": "export const x = 1;\n" });

		await expect(
			applyCodeFixOnProject(project, {
				fix: "remove_unused",
				filePaths: ["/src/missing.ts"],
			}),
		).rejects.toThrow(/File not found/);
	});
});
