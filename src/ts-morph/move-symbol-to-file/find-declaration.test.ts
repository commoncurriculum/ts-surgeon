import { describe, it, expect } from "vitest";
import {
	type ClassDeclaration,
	type FunctionDeclaration,
	type InterfaceDeclaration,
	SyntaxKind,
	type TypeAliasDeclaration,
	type SourceFile,
	type VariableStatement,
	type Statement,
} from "ts-morph";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import {
	findTopLevelDeclarationByName,
	getIdentifierFromDeclaration,
} from "./find-declaration.js";

// --- Test Data ---
const commonTestSource = `
import DefaultIface from './default-iface'; // should be ignored

// regular declarations
function funcA() {}
const varA = 1;
class ClassA {}
type TypeA = string;
interface IfaceA {}

// exported declarations
export function funcB() {}
export const varB = 2;
export class ClassB {}
export type TypeB = number;
export interface IfaceB<T> {} // with generics

// default export
export default function defaultFunc() {}
// export default class DefaultClass {} // commented out because duplicate names are not allowed
// export default const defaultVar = 3; // default-export variable (not common)

// declarations with the same name (different kinds)
const funcC = "hello";
function funcC() {} // re-declaration (function should take precedence)

// multiple declarations inside a VariableStatement
export const multiVar1 = 1, multiVar2 = 2;
`;

// --- Test Data Structure ---
type ExpectedResult = { kind: SyntaxKind; name: string };
type TestCase = [
	string,
	string,
	SyntaxKind | undefined,
	ExpectedResult | undefined,
];

const testCases: TestCase[] = [
	// description, nameToFind, kindToFind, expectedResult { kind, name } or undefined
	[
		"find function funcB with kind specified",
		"funcB",
		SyntaxKind.FunctionDeclaration,
		{ kind: SyntaxKind.FunctionDeclaration, name: "funcB" },
	],
	[
		"find variable varB with kind specified",
		"varB",
		SyntaxKind.VariableStatement,
		{ kind: SyntaxKind.VariableStatement, name: "varB" },
	],
	[
		"find class ClassB with kind specified",
		"ClassB",
		SyntaxKind.ClassDeclaration,
		{ kind: SyntaxKind.ClassDeclaration, name: "ClassB" },
	],
	[
		"find type TypeB with kind specified",
		"TypeB",
		SyntaxKind.TypeAliasDeclaration,
		{ kind: SyntaxKind.TypeAliasDeclaration, name: "TypeB" },
	],
	[
		"find interface IfaceB with kind specified",
		"IfaceB",
		SyntaxKind.InterfaceDeclaration,
		{ kind: SyntaxKind.InterfaceDeclaration, name: "IfaceB" },
	],
	[
		"find function funcA without kind specified",
		"funcA",
		undefined,
		{ kind: SyntaxKind.FunctionDeclaration, name: "funcA" },
	],
	[
		"find variable varA without kind specified",
		"varA",
		undefined,
		{ kind: SyntaxKind.VariableStatement, name: "varA" },
	],
	[
		"find multiVar1 from multiple declarations with kind specified",
		"multiVar1",
		SyntaxKind.VariableStatement,
		{ kind: SyntaxKind.VariableStatement, name: "multiVar1" },
	],
	[
		"find multiVar2 from multiple declarations with kind specified",
		"multiVar2",
		SyntaxKind.VariableStatement,
		{ kind: SyntaxKind.VariableStatement, name: "multiVar2" },
	],
	// ["find default function by 'default'", "default", SyntaxKind.FunctionDeclaration, { kind: SyntaxKind.FunctionDeclaration, name: "defaultFunc" }], // searching by default name is deferred for now
	[
		"find default function by its actual name (defaultFunc)",
		"defaultFunc",
		SyntaxKind.FunctionDeclaration,
		{ kind: SyntaxKind.FunctionDeclaration, name: "defaultFunc" },
	],
	[
		"when kind differs (searching funcB as a class)",
		"funcB",
		SyntaxKind.ClassDeclaration,
		undefined,
	],
	[
		"when name does not exist (nonExistent)",
		"nonExistent",
		undefined,
		undefined,
	],
	// ["same-name declaration funcC (function should take precedence)", "funcC", undefined, { kind: SyntaxKind.FunctionDeclaration, name: "funcC" }], // behavior for duplicate names depends on implementation
];

describe("findTopLevelDeclarationByName", () => {
	const setupSourceFile = (content: string): SourceFile => {
		const project = createInMemoryProject();
		const filePath = "/src/test-find.ts";
		return project.createSourceFile(filePath, content);
	};

	const sourceFile = setupSourceFile(commonTestSource);

	it.each<TestCase>(testCases)(
		"%s (name: %s, kind: %s)",
		(description, nameToFind, kindToFind, expectedResult) => {
			const foundDeclaration = findTopLevelDeclarationByName(
				sourceFile,
				nameToFind,
				kindToFind,
			);

			if (expectedResult) {
				// expect to find a match
				expect(foundDeclaration).toBeDefined();
				expect(foundDeclaration?.getKind()).toBe(expectedResult.kind);

				// check name match
				if (expectedResult.kind === SyntaxKind.VariableStatement) {
					// For VariableStatement, check that it contains a VariableDeclaration with the specified name
					const varDecls = (
						foundDeclaration as VariableStatement
					)?.getDeclarations();
					const specificVarDecl = varDecls?.find(
						(vd) => vd.getName() === expectedResult.name,
					);
					expect(specificVarDecl).toBeDefined();
				} else {
					// Function, Class, Interface, TypeAlias
					// Account for cases where getName() may be undefined for default exports (currently searching by actual name)
					// ANY TYPE HERE IS INTENTIONAL FOR NOW - will be fixed if test fails
					expect(
						(
							foundDeclaration as
								| FunctionDeclaration
								| ClassDeclaration
								| InterfaceDeclaration
								| TypeAliasDeclaration
						).getName?.(),
					).toBe(expectedResult.name);
				}
			} else {
				// expect not to find a match
				expect(foundDeclaration).toBeUndefined();
			}
		},
	);
	// TODO: add separate tests for searching default exports by 'default' name and for same-name declarations
});

describe("getIdentifierFromDeclaration", () => {
	const getFirstStatement = (code: string): Statement | undefined => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile("test.ts", code);
		return sourceFile.getStatements()[0];
	};

	type FirstStatementCase = {
		description: string;
		code: string;
		expected: string | undefined;
	};

	it.each<FirstStatementCase>([
		{
			description: "FunctionDeclaration",
			code: "function myFunction() {}",
			expected: "myFunction",
		},
		{
			description: "ClassDeclaration",
			code: "class MyClass {}",
			expected: "MyClass",
		},
		{
			description: "InterfaceDeclaration",
			code: "interface MyInterface {}",
			expected: "MyInterface",
		},
		{
			description: "TypeAliasDeclaration",
			code: "type MyType = string;",
			expected: "MyType",
		},
		{
			description: "EnumDeclaration",
			code: "enum MyEnum { A, B }",
			expected: "MyEnum",
		},
		{
			description: "VariableStatement (const)",
			code: "const myVar = 10;",
			expected: "myVar",
		},
		{
			description:
				"VariableStatement (multiple declarations, first identifier)",
			code: "let var1 = 1, var2 = 2;",
			expected: "var1",
		},
		{
			description: "exported FunctionDeclaration",
			code: "export function myFunction() {}",
			expected: "myFunction",
		},
		{
			description: "export default named FunctionDeclaration",
			code: "export default function myFunction() {}",
			expected: "myFunction",
		},
		{
			description:
				"export default anonymous FunctionDeclaration (no identifier)",
			code: "export default function() {}",
			expected: undefined,
		},
		{
			description: "ExportAssignment (object literal, no identifier)",
			code: "export default { a: 1 };",
			expected: undefined,
		},
		{
			description: "unsupported (ImportDeclaration)",
			code: "import { x } from './other';",
			expected: undefined,
		},
	])("returns $expected for $description", ({ code, expected }) => {
		const identifier = getIdentifierFromDeclaration(getFirstStatement(code));
		expect(identifier?.getText()).toBe(expected);
	});

	it("returns the identifier for ExportAssignment (identifier)", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"test.ts",
			"const foo = 1;\nexport default foo;",
		);
		const exportAssignment = sourceFile.getStatements()[1];
		expect(getIdentifierFromDeclaration(exportAssignment)?.getText()).toBe(
			"foo",
		);
	});

	it("returns undefined when undefined is given as input", () => {
		expect(getIdentifierFromDeclaration(undefined)).toBeUndefined();
	});
});
