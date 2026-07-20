import { describe, it, expect, vi } from "vitest";
import type { ImportDeclaration } from "ts-morph";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import type { DeclarationToUpdate, RenameOperation } from "../types.js";
import { updateModuleSpecifiers } from "./update-module-specifiers.js";

vi.mock("../../utils/logger");

const refOp = (
	sourceFile: RenameOperation["sourceFile"],
	oldPath: string,
	newPath: string,
): RenameOperation => ({ sourceFile, oldPath, newPath });

describe("updateModuleSpecifiers", () => {
	it("rewrites a normal import statement to the new path", () => {
		const project = createInMemoryProject();
		const target = project.createSourceFile(
			"/src/old.ts",
			"export const a = 1;",
		);
		const importer = project.createSourceFile(
			"/src/importer.ts",
			'import { a } from "./old";\nconsole.log(a);',
		);
		const importDecl = importer.getImportDeclarations()[0];

		updateModuleSpecifiers(
			[
				{
					declaration: importDecl,
					resolvedPath: "/src/old.ts",
					referencingFilePath: "/src/importer.ts",
					originalSpecifierText: "./old",
				},
			],
			[refOp(target, "/src/old.ts", "/src/new.ts")],
		);

		expect(importDecl.getModuleSpecifierValue()).toBe("./new");
	});

	it("skips declarations with no module specifier and leaves the declaration unchanged", () => {
		const project = createInMemoryProject();
		const sf = project.createSourceFile("/src/a.ts", "export {};");
		const exportDecl = sf.addExportDeclaration({ namedExports: [] });
		const before = exportDecl.getText();

		updateModuleSpecifiers(
			[
				{
					declaration: exportDecl,
					resolvedPath: "/src/old.ts",
					referencingFilePath: "/src/a.ts",
					originalSpecifierText: "",
				},
			],
			[refOp(sf, "/src/old.ts", "/src/new.ts")],
		);

		expect(exportDecl.getModuleSpecifier()).toBeUndefined();
		expect(exportDecl.getText()).toBe(before);
	});

	it("skips when no rename operation matches the resolvedPath", () => {
		const project = createInMemoryProject();
		const target = project.createSourceFile(
			"/src/other.ts",
			"export const a = 1;",
		);
		const importer = project.createSourceFile(
			"/src/importer.ts",
			'import { a } from "./other";\nconsole.log(a);',
		);
		const importDecl = importer.getImportDeclarations()[0];

		updateModuleSpecifiers(
			[
				{
					declaration: importDecl,
					resolvedPath: "/src/unrelated.ts",
					referencingFilePath: "/src/importer.ts",
					originalSpecifierText: "./other",
				},
			],
			[refOp(target, "/src/old.ts", "/src/new.ts")],
		);

		expect(importDecl.getModuleSpecifierValue()).toBe("./other");
	});

	it("preserves the .js extension when the specifier includes it", () => {
		const project = createInMemoryProject();
		const target = project.createSourceFile(
			"/src/old.js",
			"export const a = 1;",
		);
		const importer = project.createSourceFile(
			"/src/importer.ts",
			'import { a } from "./old.js";\nconsole.log(a);',
		);
		const importDecl = importer.getImportDeclarations()[0];

		updateModuleSpecifiers(
			[
				{
					declaration: importDecl,
					resolvedPath: "/src/old.js",
					referencingFilePath: "/src/importer.ts",
					originalSpecifierText: "./old.js",
				},
			],
			[refOp(target, "/src/old.js", "/src/new.js")],
		);

		expect(importDecl.getModuleSpecifierValue()).toBe("./new.js");
	});

	it("falls back to a relative path even when the import goes through a path alias", () => {
		const project = createInMemoryProject();
		const target = project.createSourceFile(
			"/src/old.ts",
			"export const a = 1;",
		);
		const importer = project.createSourceFile(
			"/src/feature/importer.ts",
			'import { a } from "@/old";\nconsole.log(a);',
		);
		const importDecl = importer.getImportDeclarations()[0];

		updateModuleSpecifiers(
			[
				{
					declaration: importDecl,
					resolvedPath: "/src/old.ts",
					referencingFilePath: "/src/feature/importer.ts",
					originalSpecifierText: "@/old",
					wasPathAlias: true,
				},
			],
			[refOp(target, "/src/old.ts", "/src/new.ts")],
		);

		expect(importDecl.getModuleSpecifierValue()).toBe("../new");
	});

	it("skips and continues processing when setModuleSpecifier throws", () => {
		const project = createInMemoryProject();
		const target = project.createSourceFile(
			"/src/old.ts",
			"export const a = 1;",
		);
		const importer = project.createSourceFile(
			"/src/importer.ts",
			'import { a } from "./old";\nconsole.log(a);',
		);
		const importDecl = importer.getImportDeclarations()[0];

		// Force it to throw
		const original = importDecl.setModuleSpecifier.bind(importDecl);
		(
			importDecl as unknown as { setModuleSpecifier: () => never }
		).setModuleSpecifier = () => {
			throw new Error("intentional");
		};

		try {
			expect(() =>
				updateModuleSpecifiers(
					[
						{
							declaration: importDecl,
							resolvedPath: "/src/old.ts",
							referencingFilePath: "/src/importer.ts",
							originalSpecifierText: "./old",
						},
					],
					[refOp(target, "/src/old.ts", "/src/new.ts")],
				),
			).not.toThrow();
		} finally {
			(
				importDecl as unknown as { setModuleSpecifier: typeof original }
			).setModuleSpecifier = original;
		}
	});

	it("can be aborted via AbortSignal", () => {
		const project = createInMemoryProject();
		const target = project.createSourceFile(
			"/src/old.ts",
			"export const a = 1;",
		);
		const controller = new AbortController();
		const abortReason = new Error("test-abort");
		controller.abort(abortReason);

		expect(() =>
			updateModuleSpecifiers(
				[],
				[refOp(target, "/src/old.ts", "/src/new.ts")],
				controller.signal,
			),
		).toThrow(abortReason);
	});
});
