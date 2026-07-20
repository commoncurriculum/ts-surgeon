import { describe, it, expect } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { updateTargetFile } from "./update-target-file.js";
import type { ImportMap } from "./generate-content/build-new-file-import-section.js";

describe("updateTargetFile", () => {
	it("can add and merge new declarations and their required named imports into an existing file", () => {
		const project = createInMemoryProject();
		const targetFilePath = "/src/target.ts";
		project.createSourceFile(
			"/utils.ts",
			"export const foo = 1; export const bar = 2; export const qux = 3;",
		);

		const initialContent = `import { foo, bar } from "../utils";

console.log(foo);
console.log(bar);
`;
		const targetSourceFile = project.createSourceFile(
			targetFilePath,
			initialContent,
		);

		const requiredImportMap: ImportMap = new Map([
			[
				"../utils",
				{
					namedImports: new Set(["qux"]),
					isNamespaceImport: false,
				},
			],
		]);

		const declarationStrings: string[] = [
			"export function baz() { return qux(); }",
		];

		const expectedContent = `import { bar, foo, qux } from "../utils";

console.log(foo);
console.log(bar);

export function baz() { return qux(); }
`;

		updateTargetFile(targetSourceFile, requiredImportMap, declarationStrings);

		expect(targetSourceFile.getFullText().trim()).toBe(expectedContent.trim());
	});

	it("does not add a self-referential import even if requiredImportMap contains a self-referential path, and preserves surrounding existing statements", () => {
		const project = createInMemoryProject();
		const initialContent = `export type ExistingType = number;

console.log('hello');
`;
		const targetSourceFile = project.createSourceFile(
			"/src/target.ts",
			initialContent,
		);

		updateTargetFile(
			targetSourceFile,
			new Map([
				[
					".",
					{ namedImports: new Set(["ExistingType"]), isNamespaceImport: false },
				],
			]),
			[],
		);

		expect(targetSourceFile.getFullText().trim()).toBe(initialContent.trim());
	});

	it("can add a new default import when no existing import exists", () => {
		const project = createInMemoryProject();
		const targetSourceFile = project.createSourceFile(
			"/src/target.ts",
			"console.log('start');\n",
		);

		updateTargetFile(
			targetSourceFile,
			new Map([
				[
					"./logger",
					{
						defaultName: "logger",
						namedImports: new Set(),
						isNamespaceImport: false,
					},
				],
			]),
			["export const tap = () => logger.info('x');"],
		);

		expect(targetSourceFile.getFullText()).toContain(
			'import logger from "./logger";',
		);
	});

	it("can add a new namespace import when no existing import exists", () => {
		const project = createInMemoryProject();
		const targetSourceFile = project.createSourceFile(
			"/src/target.ts",
			"console.log('start');\n",
		);

		updateTargetFile(
			targetSourceFile,
			new Map([
				[
					"node:path",
					{
						namedImports: new Set(),
						isNamespaceImport: true,
						namespaceImportName: "path",
					},
				],
			]),
			["export const resolve = (a: string, b: string) => path.resolve(a, b);"],
		);

		expect(targetSourceFile.getFullText()).toContain(
			'import * as path from "node:path";',
		);
	});

	it("prefers the existing default import when attempting to add a different one", () => {
		const project = createInMemoryProject();
		const targetSourceFile = project.createSourceFile(
			"/src/target.ts",
			'import original from "./logger";\noriginal();\n',
		);

		updateTargetFile(
			targetSourceFile,
			new Map([
				[
					"./logger",
					{
						defaultName: "renamed",
						namedImports: new Set(),
						isNamespaceImport: false,
					},
				],
			]),
			[],
		);

		expect(targetSourceFile.getFullText()).toContain(
			'import original from "./logger";',
		);
		expect(targetSourceFile.getFullText()).not.toContain("renamed");
	});

	it("prefers the existing import when a namespace import and a regular import conflict", () => {
		const project = createInMemoryProject();
		const targetSourceFile = project.createSourceFile(
			"/src/target.ts",
			'import { existing } from "./mod";\nexisting();\n',
		);

		updateTargetFile(
			targetSourceFile,
			new Map([
				[
					"./mod",
					{
						namedImports: new Set(),
						isNamespaceImport: true,
						namespaceImportName: "mod",
					},
				],
			]),
			[],
		);

		expect(targetSourceFile.getFullText()).toContain(
			'import { existing } from "./mod";',
		);
		expect(targetSourceFile.getFullText()).not.toContain("import * as mod");
	});
});
