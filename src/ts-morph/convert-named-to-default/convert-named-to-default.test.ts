import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import { getFileText } from "../_test-utils/get-file-text";
import { convertNamedExportToDefaultOnProject } from "./convert-named-to-default";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	project.saveSync();
	return project;
}

describe("convertNamedExportToDefault", () => {
	describe("target file conversion", () => {
		it("converts an inline exported function to a default export", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {\n\treturn 1;\n}\n",
			});

			await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			expect(getFileText(project, "/src/button.ts")).toBe(
				"export default function Button() {\n\treturn 1;\n}\n",
			);
		});

		it("converts an inline exported class to a default export", async () => {
			const project = setup({
				"/src/widget.ts": "export class Widget {}\n",
			});

			await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/widget.ts",
				exportName: "Widget",
			});

			expect(getFileText(project, "/src/widget.ts")).toBe(
				"export default class Widget {}\n",
			);
		});

		it("converts an exported const via a trailing default statement", async () => {
			const project = setup({
				"/src/button.ts": "export const Button = () => 1;\n",
			});

			await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			expect(getFileText(project, "/src/button.ts")).toBe(
				"const Button = () => 1;\nexport default Button;\n",
			);
		});

		it("converts a `export { foo }` specifier form", async () => {
			const project = setup({
				"/src/button.ts": "function Button() {}\nexport { Button };\n",
			});

			await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			expect(getFileText(project, "/src/button.ts")).toBe(
				"export default function Button() {}\n",
			);
		});
	});

	describe("importer rewriting", () => {
		it("rewrites a sole named import to a default import", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {}\n",
				"/src/app.ts": 'import { Button } from "./button";\nButton();\n',
			});

			const result = await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			expect(result.updatedImportSites).toBe(1);
			expect(getFileText(project, "/src/app.ts")).toBe(
				'import Button from "./button";\nButton();\n',
			);
		});

		it("preserves the local alias as the default import name", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {}\n",
				"/src/app.ts": 'import { Button as Btn } from "./button";\nBtn();\n',
			});

			await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			expect(getFileText(project, "/src/app.ts")).toBe(
				'import Btn from "./button";\nBtn();\n',
			);
		});

		it("splits the converted name out of a combined named import", async () => {
			const project = setup({
				"/src/button.ts":
					"export function Button() {}\nexport const size = 1;\n",
				"/src/app.ts":
					'import { Button, size } from "./button";\nButton();\nconsole.log(size);\n',
			});

			await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const importDecl = app.getImportDeclarations()[0];
			expect(importDecl.getDefaultImport()?.getText()).toBe("Button");
			expect(importDecl.getNamedImports().map((n) => n.getText())).toEqual([
				"size",
			]);
		});

		it("preserves a type-only import", async () => {
			const project = setup({
				"/src/value.ts": "export const Thing = 1;\n",
				"/src/typed.ts":
					'import type { Thing } from "./value";\ntype T = typeof Thing;\nexport type { T };\n',
			});

			await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/value.ts",
				exportName: "Thing",
			});

			const importDecl = project
				.getSourceFileOrThrow("/src/typed.ts")
				.getImportDeclarations()[0];
			expect(importDecl.isTypeOnly()).toBe(true);
			expect(importDecl.getDefaultImport()?.getText()).toBe("Thing");
			expect(importDecl.getNamedImports()).toHaveLength(0);
		});

		it("resolves named imports written through a path alias", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {}\n",
				"/src/app.ts": 'import { Button } from "@/button";\nButton();\n',
			});

			const result = await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			expect(result.updatedImportSites).toBe(1);
			expect(getFileText(project, "/src/app.ts")).toBe(
				'import Button from "@/button";\nButton();\n',
			);
		});

		it("leaves namespace-member access untouched (documented limitation)", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {}\n",
				"/src/app.ts": 'import * as ns from "./button";\nns.Button();\n',
			});

			const result = await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			// Namespace imports are not rewritten; the site is left intact.
			expect(result.updatedImportSites).toBe(0);
			expect(getFileText(project, "/src/app.ts")).toBe(
				'import * as ns from "./button";\nns.Button();\n',
			);
		});

		it("converts an aliased target specifier `export { local as Name }`", async () => {
			const project = setup({
				"/src/button.ts": "function impl() {}\nexport { impl as Button };\n",
				"/src/app.ts": 'import { Button } from "./button";\nButton();\n',
			});

			await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			expect(getFileText(project, "/src/button.ts")).toBe(
				"function impl() {}\nexport default impl;\n",
			);
			expect(getFileText(project, "/src/app.ts")).toBe(
				'import Button from "./button";\nButton();\n',
			);
		});
	});

	describe("re-export rewriting", () => {
		it("rewrites `export { name } from` to `export { default as name } from`", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {}\n",
				"/src/index.ts": 'export { Button } from "./button";\n',
			});

			const result = await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			expect(result.updatedReExportSites).toBe(1);
			expect(getFileText(project, "/src/index.ts")).toBe(
				'export { default as Button } from "./button";\n',
			);
		});

		it("rewrites an aliased re-export, keeping the external name", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {}\n",
				"/src/index.ts": 'export { Button as Btn } from "./button";\n',
			});

			await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
			});

			expect(getFileText(project, "/src/index.ts")).toBe(
				'export { default as Btn } from "./button";\n',
			);
		});
	});

	describe("dryRun", () => {
		it("reports changes without saving", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {}\n",
				"/src/app.ts": 'import { Button } from "./button";\nButton();\n',
			});

			const result = await convertNamedExportToDefaultOnProject(project, {
				targetFilePath: "/src/button.ts",
				exportName: "Button",
				dryRun: true,
			});

			expect(result.changedFiles.sort()).toEqual([
				"/src/app.ts",
				"/src/button.ts",
			]);
			expect(project.getSourceFileOrThrow("/src/button.ts").isSaved()).toBe(
				false,
			);
		});
	});

	describe("errors", () => {
		it("throws when the file already has a default export", async () => {
			const project = setup({
				"/src/button.ts":
					"export default function Other() {}\nexport function Button() {}\n",
			});

			await expect(
				convertNamedExportToDefaultOnProject(project, {
					targetFilePath: "/src/button.ts",
					exportName: "Button",
				}),
			).rejects.toThrow(/already has a default export/);
		});

		it("throws when the named export does not exist", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {}\n",
			});

			await expect(
				convertNamedExportToDefaultOnProject(project, {
					targetFilePath: "/src/button.ts",
					exportName: "Missing",
				}),
			).rejects.toThrow(/No exported declaration named/);
		});

		it("throws when the export is a type", async () => {
			const project = setup({
				"/src/types.ts": "export type Options = { id: number };\n",
			});

			await expect(
				convertNamedExportToDefaultOnProject(project, {
					targetFilePath: "/src/types.ts",
					exportName: "Options",
				}),
			).rejects.toThrow(/is a type/);
		});

		it("throws when the export is re-exported from another file", async () => {
			const project = setup({
				"/src/button.ts": "export function Button() {}\n",
				"/src/index.ts": 'export { Button } from "./button";\n',
			});

			await expect(
				convertNamedExportToDefaultOnProject(project, {
					targetFilePath: "/src/index.ts",
					exportName: "Button",
				}),
			).rejects.toThrow(/re-exported from another file/);
		});

		it("throws for the file-not-found case", async () => {
			const project = setup({ "/src/a.ts": "export const a = 1;\n" });

			await expect(
				convertNamedExportToDefaultOnProject(project, {
					targetFilePath: "/src/missing.ts",
					exportName: "a",
				}),
			).rejects.toThrow(/File not found/);
		});
	});
});
