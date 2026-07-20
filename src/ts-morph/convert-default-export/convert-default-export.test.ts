import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { getFileText } from "../_test-utils/get-file-text.js";
import { convertDefaultExportToNamedOnProject } from "./convert-default-export.js";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	return project;
}

describe("convertDefaultExportToNamed", () => {
	describe("target file conversion", () => {
		it("converts a named function default export, keeping its name", async () => {
			const project = setup({
				"/src/button.ts":
					"export default function Button() {\n\treturn 1;\n}\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.exportName).toBe("Button");
			expect(getFileText(project, "/src/button.ts")).toBe(
				"export function Button() {\n\treturn 1;\n}\n",
			);
		});

		it("converts a named class default export, keeping its name", async () => {
			const project = setup({
				"/src/widget.ts": "export default class Widget {}\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/widget.ts",
			});

			expect(result.exportName).toBe("Widget");
			expect(getFileText(project, "/src/widget.ts")).toBe(
				"export class Widget {}\n",
			);
		});

		it("converts `export default <identifier>` to a named re-export", async () => {
			const project = setup({
				"/src/value.ts": "const value = 42;\nexport default value;\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/value.ts",
			});

			expect(result.exportName).toBe("value");
			expect(getFileText(project, "/src/value.ts")).toBe(
				"const value = 42;\nexport { value };\n",
			);
		});

		it("renames `export default <identifier>` when newName differs", async () => {
			const project = setup({
				"/src/value.ts": "const v = 42;\nexport default v;\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/value.ts",
				newName: "answer",
			});

			expect(result.exportName).toBe("answer");
			expect(getFileText(project, "/src/value.ts")).toBe(
				"const v = 42;\nexport { v as answer };\n",
			);
		});

		it("converts an anonymous arrow expression with newName", async () => {
			const project = setup({
				"/src/fn.ts": "export default () => 1;\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/fn.ts",
				newName: "fn",
			});

			expect(result.exportName).toBe("fn");
			expect(getFileText(project, "/src/fn.ts")).toBe(
				"export const fn = () => 1;\n",
			);
		});

		it("converts an anonymous object-literal expression with newName", async () => {
			const project = setup({
				"/src/config.ts": "export default { a: 1, b: 2 };\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/config.ts",
				newName: "config",
			});

			expect(result.exportName).toBe("config");
			expect(getFileText(project, "/src/config.ts")).toBe(
				"export const config = { a: 1, b: 2 };\n",
			);
		});

		it("converts an anonymous function declaration with newName", async () => {
			const project = setup({
				"/src/fn.ts": "export default function () {\n\treturn 1;\n}\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/fn.ts",
				newName: "run",
			});

			expect(result.exportName).toBe("run");
			expect(getFileText(project, "/src/fn.ts")).toBe(
				"export const run = function () {\n\treturn 1;\n};\n",
			);
		});

		it("converts an anonymous class declaration with `extends` and newName", async () => {
			const project = setup({
				"/src/base.ts": "export class Base {}\n",
				"/src/widget.ts":
					'import { Base } from "./base";\nexport default class extends Base {}\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/widget.ts",
				newName: "Widget",
			});

			expect(result.exportName).toBe("Widget");
			expect(getFileText(project, "/src/widget.ts")).toBe(
				'import { Base } from "./base";\nexport const Widget = class extends Base {};\n',
			);
		});

		it("converts `export { foo as default }` to a named export", async () => {
			const project = setup({
				"/src/value.ts": "const foo = 1;\nexport { foo as default };\n",
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/value.ts",
			});

			expect(result.exportName).toBe("foo");
			expect(getFileText(project, "/src/value.ts")).toBe(
				"const foo = 1;\nexport { foo };\n",
			);
		});
	});

	describe("importer rewriting", () => {
		it("rewrites a sole default import to a named import", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts": 'import Button from "./button";\nButton();\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedImportSites).toBe(1);
			expect(getFileText(project, "/src/app.ts")).toBe(
				'import { Button } from "./button";\nButton();\n',
			);
		});

		it("aliases the named import when the local name differs", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts": 'import Btn from "./button";\nBtn();\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(getFileText(project, "/src/app.ts")).toBe(
				'import { Button as Btn } from "./button";\nBtn();\n',
			);
		});

		it("merges into an existing named import on the same declaration", async () => {
			const project = setup({
				"/src/button.ts":
					"export default function Button() {}\nexport const size = 1;\n",
				"/src/app.ts":
					'import Button, { size } from "./button";\nButton();\nconsole.log(size);\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const importDecl = app.getImportDeclarations()[0];
			expect(importDecl.getDefaultImport()).toBeUndefined();
			expect(importDecl.getNamedImports().map((n) => n.getText())).toEqual([
				"size",
				"Button",
			]);
		});

		it("splits into a separate declaration when a namespace import is present", async () => {
			const project = setup({
				"/src/button.ts":
					"export default function Button() {}\nexport const size = 1;\n",
				"/src/app.ts":
					'import Button, * as btn from "./button";\nButton();\nconsole.log(btn.size);\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const decls = app.getImportDeclarations();
			// Original declaration keeps the namespace import, default removed.
			const namespaceDecl = decls.find((d) => d.getNamespaceImport());
			expect(namespaceDecl?.getDefaultImport()).toBeUndefined();
			// A new declaration carries the named import.
			const namedDecl = decls.find((d) => d.getNamedImports().length > 0);
			expect(namedDecl?.getModuleSpecifierValue()).toBe("./button");
			expect(namedDecl?.getNamedImports().map((n) => n.getText())).toEqual([
				"Button",
			]);
		});

		it("preserves a type-only default import", async () => {
			const project = setup({
				"/src/types.ts":
					"type Options = { id: number };\nexport default Options;\n",
				"/src/app.ts":
					'import type Options from "./types";\nconst o: Options = { id: 1 };\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/types.ts",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const importDecl = app.getImportDeclarations()[0];
			expect(importDecl.isTypeOnly()).toBe(true);
			expect(importDecl.getDefaultImport()).toBeUndefined();
			expect(importDecl.getNamedImports().map((n) => n.getText())).toEqual([
				"Options",
			]);
		});

		it("resolves default imports written through a path alias", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts": 'import Button from "@/button";\nButton();\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedImportSites).toBe(1);
			expect(getFileText(project, "/src/app.ts")).toBe(
				'import { Button } from "@/button";\nButton();\n',
			);
		});

		it("updates default imports across multiple files", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/a.ts": 'import Button from "./button";\nButton();\n',
				"/src/b.ts": 'import B from "./button";\nB();\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedImportSites).toBe(2);
			expect(getFileText(project, "/src/a.ts")).toBe(
				'import { Button } from "./button";\nButton();\n',
			);
			expect(getFileText(project, "/src/b.ts")).toBe(
				'import { Button as B } from "./button";\nB();\n',
			);
		});

		it("rewrites a default imported via a named specifier `{ default as Foo }`", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts": 'import { default as Btn } from "./button";\nBtn();\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedImportSites).toBe(1);
			expect(getFileText(project, "/src/app.ts")).toBe(
				'import { Button as Btn } from "./button";\nBtn();\n',
			);
		});

		it("does not create a duplicate specifier when the named import already exists", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts":
					'import Button, { Button as Button2 } from "./button";\nButton();\nButton2();\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const named = app.getImportDeclarations()[0].getNamedImports();
			// `{ Button as Button2 }` is the renamed default specifier; the default
			// clause collapses to `{ Button }` without duplicating `Button as Button2`.
			expect(named.map((n) => n.getText())).toEqual([
				"Button as Button2",
				"Button",
			]);
		});

		it("merges the namespace-split named import into an existing declaration for the same module", async () => {
			const project = setup({
				"/src/m.ts":
					"export default function Button() {}\nexport const other = 1;\n",
				"/src/app.ts":
					'import Button, * as ns from "./m";\nimport { other } from "./m";\nButton();\nconsole.log(ns, other);\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/m.ts",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const decls = app.getImportDeclarations();
			// No third declaration is added; the default folds into `{ other }`.
			expect(decls).toHaveLength(2);
			const namedDecl = decls.find((d) => !d.getNamespaceImport());
			expect(namedDecl?.getNamedImports().map((n) => n.getText())).toEqual([
				"other",
				"Button",
			]);
		});

		it("preserves type-only-ness when splitting a namespace import", async () => {
			const project = setup({
				"/src/types.ts": "type T = { id: number };\nexport default T;\n",
				"/src/app.ts":
					'import type Opts, * as ns from "./types";\nconst o: Opts = { id: 1 };\nexport type { ns };\n',
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/types.ts",
			});

			const app = project.getSourceFileOrThrow("/src/app.ts");
			const namedDecl = app
				.getImportDeclarations()
				.find((d) => d.getNamedImports().length > 0);
			expect(namedDecl?.isTypeOnly()).toBe(true);
			expect(namedDecl?.getNamedImports().map((n) => n.getText())).toEqual([
				"T as Opts",
			]);
		});
	});

	describe("comment preservation", () => {
		it("keeps a leading JSDoc comment when rewriting an anonymous expression", async () => {
			const project = setup({
				"/src/fn.ts": "/** my fn */\nexport default () => 1;\n",
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/fn.ts",
				newName: "fn",
			});

			expect(getFileText(project, "/src/fn.ts")).toBe(
				"/** my fn */\nexport const fn = () => 1;\n",
			);
		});

		it("keeps a leading comment when rewriting `export default <identifier>`", async () => {
			const project = setup({
				"/src/value.ts": "const foo = 1;\n/** keep */\nexport default foo;\n",
			});

			await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/value.ts",
			});

			expect(getFileText(project, "/src/value.ts")).toBe(
				"const foo = 1;\n/** keep */\nexport { foo };\n",
			);
		});
	});

	describe("re-export rewriting", () => {
		it("rewrites `export { default } from` to a named re-export", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/index.ts": 'export { default } from "./button";\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedReExportSites).toBe(1);
			expect(getFileText(project, "/src/index.ts")).toBe(
				'export { Button } from "./button";\n',
			);
		});

		it("rewrites `export { default as X } from`, keeping the alias", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/index.ts": 'export { default as Btn } from "./button";\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
			});

			expect(result.updatedReExportSites).toBe(1);
			expect(getFileText(project, "/src/index.ts")).toBe(
				'export { Button as Btn } from "./button";\n',
			);
		});
	});

	describe("dryRun", () => {
		it("reports changes without saving", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
				"/src/app.ts": 'import Button from "./button";\nButton();\n',
			});

			const result = await convertDefaultExportToNamedOnProject(project, {
				targetFilePath: "/src/button.ts",
				dryRun: true,
			});

			expect(result.changedFiles.sort()).toEqual([
				"/src/app.ts",
				"/src/button.ts",
			]);
			// Each touched file is left unsaved (the integration test asserts the
			// on-disk content is unchanged; in-memory edits apply to the AST only).
			expect(project.getSourceFileOrThrow("/src/button.ts").isSaved()).toBe(
				false,
			);
			expect(project.getSourceFileOrThrow("/src/app.ts").isSaved()).toBe(false);
		});
	});

	describe("errors", () => {
		it("throws when the file has no default export", async () => {
			const project = setup({
				"/src/util.ts": "export const a = 1;\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/util.ts",
				}),
			).rejects.toThrow(/No default export/);
		});

		it("throws when the default export resolves to multiple declarations", async () => {
			const project = setup({
				"/src/overloads.ts":
					"export default function fn(a: number): number;\n" +
					"export default function fn(a: string): string;\n" +
					"export default function fn(a: unknown): unknown {\n\treturn a;\n}\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/overloads.ts",
				}),
			).rejects.toThrow(/resolves to \d+ declarations/);
		});

		it("throws when the file is not found", async () => {
			const project = setup({ "/src/a.ts": "export const a = 1;\n" });

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/missing.ts",
				}),
			).rejects.toThrow(/File not found/);
		});

		it("throws when an anonymous default export has no newName", async () => {
			const project = setup({
				"/src/fn.ts": "export default () => 1;\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/fn.ts",
				}),
			).rejects.toThrow(/anonymous/);
		});

		it("throws when newName conflicts with an already-named default export", async () => {
			const project = setup({
				"/src/button.ts": "export default function Button() {}\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/button.ts",
					newName: "Other",
				}),
			).rejects.toThrow(/already named/);
		});

		it("throws when newName is not a valid identifier", async () => {
			const project = setup({
				"/src/fn.ts": "export default () => 1;\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/fn.ts",
					newName: "not valid",
				}),
			).rejects.toThrow(/not a usable identifier/);
		});

		it("throws when newName is a reserved word", async () => {
			const project = setup({
				"/src/fn.ts": "export default () => 1;\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/fn.ts",
					newName: "class",
				}),
			).rejects.toThrow(/not a usable identifier/);
		});

		it("throws for an anonymous abstract class default export", async () => {
			const project = setup({
				"/src/widget.ts": "export default abstract class {}\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/widget.ts",
					newName: "Widget",
				}),
			).rejects.toThrow(/abstract class/);
		});

		it("throws when the resulting name already exists as a named export", async () => {
			const project = setup({
				"/src/value.ts": "export const foo = 1;\nexport default foo;\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/value.ts",
				}),
			).rejects.toThrow(/already exports a symbol/);
		});

		it("throws when newName collides with an existing named export", async () => {
			const project = setup({
				"/src/fn.ts": "export const run = 0;\nexport default () => 1;\n",
			});

			await expect(
				convertDefaultExportToNamedOnProject(project, {
					targetFilePath: "/src/fn.ts",
					newName: "run",
				}),
			).rejects.toThrow(/already exports a symbol/);
		});
	});
});
