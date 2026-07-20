import { Project, Node } from "ts-morph";
import { describe, it, expect } from "vitest";
import { getIdentifierNodeFromDeclaration } from "./get-identifier-node-from-declaration.js";

describe("getIdentifierNodeFromDeclaration", () => {
	const project = new Project({ useInMemoryFileSystem: true });

	const testCases = [
		// 1. Basic declarations
		{
			code: "const foo = 1;",
			expected: "foo",
			description: "variable declaration (const)",
		},
		{
			code: "let bar = 2;",
			expected: "bar",
			description: "variable declaration (let)",
		},
		{
			code: "var baz = 3;",
			expected: "baz",
			description: "variable declaration (var)",
		},
		{
			code: "function func() {}",
			expected: "func",
			description: "function declaration (named)",
		},
		{
			code: "class MyClass {}",
			expected: "MyClass",
			description: "class declaration (named)",
		},
		{
			code: "interface MyInterface {}",
			expected: "MyInterface",
			description: "interface declaration",
		},
		{
			code: "type MyType = string;",
			expected: "MyType",
			description: "type alias declaration",
		},
		{
			code: "enum MyEnum { A, B }",
			expected: "MyEnum",
			description: "enum declaration",
		},

		// 2. Default exports (named identifier)
		{
			code: "const myVar = 1; export default myVar;",
			expected: "myVar",
			description: "default export (variable)",
		},
		{
			code: "function namedFunc() {}; export default namedFunc;",
			expected: "namedFunc",
			description: "default export (named function)",
		},
		{
			code: "class NamedClass {}; export default NamedClass;",
			expected: "NamedClass",
			description: "default export (named class)",
		},

		// 3. Default exports (anonymous or unhandled) - expected behavior is to return undefined
		{
			code: "export default () => {};",
			expected: undefined,
			description: "default export (arrow function)",
		},
		{
			code: "export default 123;",
			expected: undefined,
			description: "default export (literal)",
		},

		// 4. Destructuring (should not return an identifier from a pattern)
		{
			code: "const { a } = { a: 1 };",
			expected: undefined,
			description: "variable declaration (object destructuring)",
		},
		{
			code: "const [ b ] = [ 1 ];",
			expected: undefined,
			description: "variable declaration (array destructuring)",
		},

		// 5. ExportSpecifier (may be handled by fallback; primary target is main declarations)
		// { code: 'const x = 1; export { x as y };', expected: 'y', description: 'export specifier (alias)' } // Getting the ExportSpecifier node directly requires more complex setup
	];

	it.each(testCases)(
		"returns $expected for $description",
		({ code, expected }) => {
			const sourceFile = project.createSourceFile("temp.ts", code, {
				overwrite: true,
			});
			let declarationNode: Node | undefined;

			if (code.includes("export default")) {
				// Find the ExportAssignment node more reliably
				declarationNode = sourceFile
					.getStatements()
					.find(Node.isExportAssignment);
			} else if (
				code.startsWith("const") ||
				code.startsWith("let") ||
				code.startsWith("var")
			) {
				declarationNode = sourceFile
					.getVariableStatements()[0]
					?.getDeclarations()[0];
			} else if (code.startsWith("function")) {
				declarationNode = sourceFile.getFunctions()[0];
			} else if (code.startsWith("class")) {
				declarationNode = sourceFile.getClasses()[0];
			} else if (code.startsWith("interface")) {
				declarationNode = sourceFile.getInterfaces()[0];
			} else if (code.startsWith("type")) {
				declarationNode = sourceFile.getTypeAliases()[0];
			} else if (code.startsWith("enum")) {
				declarationNode = sourceFile.getEnums()[0];
			}

			expect(
				declarationNode,
				`Declaration node not found for test code: ${code}`,
			).toBeDefined();

			if (!declarationNode) return;

			const identifierNode = getIdentifierNodeFromDeclaration(declarationNode);

			if (expected === undefined) {
				expect(identifierNode).toBeUndefined();
			} else {
				expect(identifierNode).toBeDefined();
				expect(identifierNode?.getText()).toBe(expected);
			}
		},
	);

	it("returns the Identifier node as-is when passed directly (fallback 1)", () => {
		const sf = project.createSourceFile(
			"/fallback-identifier.ts",
			"const foo = 1;",
		);
		const identifier = sf
			.getVariableStatements()[0]
			.getDeclarations()[0]
			.getNameNode();

		expect(getIdentifierNodeFromDeclaration(identifier)?.getText()).toBe("foo");
	});

	it("can retrieve an identifier from an ExportSpecifier that has getNameNode (fallback 2)", () => {
		const sf = project.createSourceFile(
			"/fallback-export-specifier.ts",
			"const foo = 1;\nexport { foo as bar };",
		);
		const exportDecl = sf.getExportDeclarations()[0];
		const exportSpecifier = exportDecl.getNamedExports()[0];

		expect(getIdentifierNodeFromDeclaration(exportSpecifier)?.getText()).toBe(
			"foo",
		);
	});
});
