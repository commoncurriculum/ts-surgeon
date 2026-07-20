import { describe, it, expect } from "vitest";
import { type Statement, SyntaxKind } from "ts-morph";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { getStatement } from "../_test-utils/get-statement.js";
import { collectNeededExternalImports } from "./collect-external-imports.js";

const setupTest = (
	code: string,
	targetSymbolNames: string[],
	targetKind: SyntaxKind = SyntaxKind.VariableStatement,
) => {
	const project = createInMemoryProject();
	const sourceFile = project.createSourceFile("/src/module.ts", code);
	const targetStatements: Statement[] = targetSymbolNames.map(
		(name) => getStatement(sourceFile, name, targetKind) as Statement,
	);
	return { sourceFile, targetStatements };
};

describe("collectNeededExternalImports", () => {
	it("can collect import information from statements that use named imports", () => {
		const code = `
			import { utilA, utilB } from './utils';
			export const func1 = () => utilA();
			export const func2 = () => utilB() + 1;
		`;
		const { sourceFile, targetStatements } = setupTest(code, [
			"func1",
			"func2",
		]);

		const neededImports = collectNeededExternalImports(
			targetStatements,
			sourceFile,
		);

		expect(neededImports.size).toBe(1);
		const utilsImport = neededImports.get("./utils");
		expect(utilsImport).toBeDefined();
		expect(utilsImport?.names).toEqual(new Set(["utilA", "utilB"]));
		// Skipping declaration check here (verified in implementation)
	});

	it("can collect import information from statements that use default imports", () => {
		const code = `
			import myDefaultUtil from '../defaultUtils';
			export const processor = () => myDefaultUtil.process();
		`;
		const { sourceFile, targetStatements } = setupTest(code, ["processor"]);

		const neededImports = collectNeededExternalImports(
			targetStatements,
			sourceFile,
		);

		expect(neededImports.size).toBe(1);
		const defaultImport = neededImports.get("../defaultUtils");
		expect(defaultImport).toBeDefined();
		// Default imports are expected to be collected under the special name 'default'
		expect(defaultImport?.names).toEqual(new Set(["default"]));
	});

	it("can collect import information from statements that use aliased imports", () => {
		const code = `
			import { originalName as aliasName } from '@/lib/core';
			export const taskRunner = () => aliasName.run();
		`;
		const { sourceFile, targetStatements } = setupTest(code, ["taskRunner"]);

		const neededImports = collectNeededExternalImports(
			targetStatements,
			sourceFile,
		);

		expect(neededImports.size).toBe(1);
		const coreImport = neededImports.get("@/lib/core");
		expect(coreImport).toBeDefined();
		// Expected to be collected under the alias name
		expect(coreImport?.names).toEqual(new Set(["aliasName"]));
	});

	it("collects nothing from statements that do not use external imports", () => {
		const code = `
			const localVar = 10;
			export const simpleFunc = () => localVar * 2;
		`;
		const { sourceFile, targetStatements } = setupTest(code, ["simpleFunc"]);

		const neededImports = collectNeededExternalImports(
			targetStatements,
			sourceFile,
		);

		expect(neededImports.size).toBe(0);
	});

	it("correctly collects when multiple import types (named, default, aliased) are mixed", () => {
		const code = `
			import defaultUtil from './default';
			import { utilA } from './utils';
			import { oldFunc as newFunc } from '@/legacy';

			export const complexTask = () => {
				const resA = utilA();
				const resB = defaultUtil(resA);
				return newFunc(resB);
			};
		`;
		const { sourceFile, targetStatements } = setupTest(code, ["complexTask"]);

		const neededImports = collectNeededExternalImports(
			targetStatements,
			sourceFile,
		);

		expect(neededImports.size).toBe(3);

		// Verify default import
		const defaultImport = neededImports.get("./default");
		expect(defaultImport?.names).toEqual(new Set(["default"]));

		// Verify named import
		const utilsImport = neededImports.get("./utils");
		expect(utilsImport?.names).toEqual(new Set(["utilA"]));

		// Verify aliased import
		const legacyImport = neededImports.get("@/legacy");
		expect(legacyImport?.names).toEqual(new Set(["newFunc"])); // alias name
	});

	it("can collect import information from statements that use namespace imports (import * as)", () => {
		const code = `
			import * as path from 'node:path';
			export const resolvePath = (dir: string, file: string) => {
				return path.resolve(dir, file);
			};
		`;
		const { sourceFile, targetStatements } = setupTest(code, ["resolvePath"]);

		const neededImports = collectNeededExternalImports(
			targetStatements,
			sourceFile,
		);

		expect(neededImports.size).toBe(1);
		const pathImport = neededImports.get("node:path");
		expect(pathImport).toBeDefined();
		// Namespace imports are expected to be collected via the namespaceImportName property
		expect(pathImport?.isNamespaceImport).toBe(true);
		expect(pathImport?.namespaceImportName).toBe("path");
		expect(pathImport?.names).toEqual(new Set()); // names set should be empty
	});
});
