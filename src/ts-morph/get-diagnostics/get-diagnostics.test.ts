import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { getDiagnosticsOnProject } from "./get-diagnostics.js";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	return project;
}

describe("getDiagnostics", () => {
	it("reports a type error with location, code, and message", () => {
		const project = setup({
			"/src/a.ts": "const x: number = 'oops';\n",
		});

		const result = getDiagnosticsOnProject(project, {});

		expect(result.errorCount).toBeGreaterThanOrEqual(1);
		const error = result.diagnostics.find((d) => d.category === "error");
		expect(error?.filePath).toBe("/src/a.ts");
		expect(error?.line).toBe(1);
		expect(error?.column).toBe(7);
		expect(error?.code).toBe(2322); // Type 'string' is not assignable to type 'number'.
		expect(error?.message).toContain("not assignable");
	});

	it("returns no diagnostics for a clean project", () => {
		const project = setup({
			"/src/a.ts": "export const x: number = 1;\n",
		});

		const result = getDiagnosticsOnProject(project, {});

		expect(result.totalCount).toBe(0);
		expect(result.diagnostics).toEqual([]);
		expect(result.errorCount).toBe(0);
	});

	it("scopes diagnostics to the requested files", () => {
		const project = setup({
			"/src/bad.ts": "const x: number = 'oops';\n",
			"/src/good.ts": "export const y = 1;\n",
		});

		const result = getDiagnosticsOnProject(project, {
			filePaths: ["/src/good.ts"],
		});

		expect(result.totalCount).toBe(0);
	});

	it("surfaces errors before warnings/suggestions in the list", () => {
		const project = setup({
			// Unreachable code is a suggestion; the type mismatch is an error.
			"/src/a.ts":
				"function f(): number {\n\treturn 1;\n\tconst dead = 2;\n}\nconst x: string = 1;\n",
		});

		const result = getDiagnosticsOnProject(project, {});

		expect(result.diagnostics[0]?.category).toBe("error");
	});

	it("truncates to maxResults and flags truncation", () => {
		const project = setup({
			"/src/a.ts": "const a: number = 'x';\nconst b: number = 'y';\n",
		});

		const result = getDiagnosticsOnProject(project, { maxResults: 1 });

		expect(result.totalCount).toBeGreaterThanOrEqual(2);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.truncated).toBe(true);
	});

	it("reports a project-global diagnostic with no associated file", () => {
		// A missing `types` entry produces TS2688, which has no source file.
		const project = new Project({
			useInMemoryFileSystem: true,
			compilerOptions: { types: ["totally-missing-type-pkg"] },
		});
		project.createSourceFile("/src/a.ts", "export const x = 1;\n");

		const result = getDiagnosticsOnProject(project, {});

		const global = result.diagnostics.find((d) => d.filePath === undefined);
		expect(global).toBeDefined();
		expect(global?.line).toBeUndefined();
		expect(global?.column).toBeUndefined();
		expect(global?.category).toBe("error");
	});

	it("throws when a requested file does not exist", () => {
		const project = setup({ "/src/a.ts": "export const x = 1;\n" });

		expect(() =>
			getDiagnosticsOnProject(project, { filePaths: ["/src/missing.ts"] }),
		).toThrow(/File not found/);
	});
});
