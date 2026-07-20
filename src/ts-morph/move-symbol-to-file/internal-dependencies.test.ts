import { describe, it, expect } from "vitest";
import { type SourceFile, SyntaxKind } from "ts-morph";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { getStatement } from "../_test-utils/get-statement.js";
import { getInternalDependencies } from "./internal-dependencies.js";

const fnDecl = (sourceFile: SourceFile, name: string) =>
	getStatement(sourceFile, name, SyntaxKind.FunctionDeclaration);

const varStmt = (sourceFile: SourceFile, name: string) =>
	getStatement(sourceFile, name, SyntaxKind.VariableStatement);

describe("getInternalDependencies", () => {
	it("can identify the internal functions and variables that a function declaration depends on", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"/src/test.ts",
			`
			const configValue = 10;
			const calculatedValue = configValue * 2;
			function helperFunc(n: number): number { return n + calculatedValue; }
			export function mainFunc(x: number): void { const result = helperFunc(x); console.log(result); }
		`,
		);

		const dependencies = getInternalDependencies(
			fnDecl(sourceFile, "mainFunc"),
		);

		expect(dependencies).toEqual(
			expect.arrayContaining([
				fnDecl(sourceFile, "helperFunc"),
				varStmt(sourceFile, "calculatedValue"),
				varStmt(sourceFile, "configValue"),
			]),
		);
		expect(dependencies).toHaveLength(3);
	});

	it("can identify the internal variables that a function declaration depends on (indirect dependency)", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"/src/test.ts",
			`
			const configValue = 10;
			const calculatedValue = configValue * 2;
			function helperFunc(n: number): number { return n + calculatedValue; }
		`,
		);

		const dependencies = getInternalDependencies(
			fnDecl(sourceFile, "helperFunc"),
		);

		expect(dependencies).toEqual(
			expect.arrayContaining([
				varStmt(sourceFile, "calculatedValue"),
				varStmt(sourceFile, "configValue"),
			]),
		);
		expect(dependencies).toHaveLength(2);
	});

	it("can identify the internal variables that a variable declaration depends on", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"/src/test.ts",
			`
			const configValue = 10;
			const calculatedValue = configValue * 2;
			export const derivedConst = calculatedValue + 5;
		`,
		);

		const dependencies = getInternalDependencies(
			varStmt(sourceFile, "derivedConst"),
		);

		expect(dependencies).toEqual(
			expect.arrayContaining([
				varStmt(sourceFile, "calculatedValue"),
				varStmt(sourceFile, "configValue"),
			]),
		);
		expect(dependencies).toHaveLength(2);
	});

	it("can identify the internal variables that a variable declaration depends on (direct dependency)", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"/src/test.ts",
			`
			const configValue = 10;
			const calculatedValue = configValue * 2;
		`,
		);

		const configValueStmt = varStmt(sourceFile, "configValue");
		const dependencies = getInternalDependencies(
			varStmt(sourceFile, "calculatedValue"),
		);

		expect(dependencies).toHaveLength(1);
		expect(dependencies[0]).toBe(configValueStmt);
	});

	it("returns an empty array when there are no dependencies", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"/src/test.ts",
			`
			const configValue = 10;
			function unusedFunc() {}
		`,
		);

		expect(getInternalDependencies(varStmt(sourceFile, "configValue"))).toEqual(
			[],
		);
		expect(getInternalDependencies(fnDecl(sourceFile, "unusedFunc"))).toEqual(
			[],
		);
	});

	it("can identify non-exported arrow functions that a function declaration depends on", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"/src/test.ts",
			`
			const arrowHelper = (n: number): number => n * n;
			export function mainFunc(x: number): number { return arrowHelper(x); }
		`,
		);

		const dependencies = getInternalDependencies(
			fnDecl(sourceFile, "mainFunc"),
		);

		expect(dependencies).toEqual([varStmt(sourceFile, "arrowHelper")]);
	});

	it("can recursively identify multiple indirect internal dependencies", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"/src/test.ts",
			`
			const d = 4;
			const c = () => d;
			const b = () => c();
			export const a = () => b(); // a -> b -> c -> d
			const e = () => d; // d is also referenced from outside a, but here we only look at a's dependencies
		`,
		);

		const dependencies = getInternalDependencies(varStmt(sourceFile, "a"));

		expect(dependencies).toEqual(
			expect.arrayContaining([
				varStmt(sourceFile, "b"),
				varStmt(sourceFile, "c"),
				varStmt(sourceFile, "d"),
			]),
		);
		expect(dependencies).toHaveLength(3);
	});
});
