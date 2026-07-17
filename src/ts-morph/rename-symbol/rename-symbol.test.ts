import { SyntaxKind, type Identifier } from "ts-morph";
import { describe, it, expect } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import {
	findIdentifierNode,
	validateSymbol,
} from "../_utils/resolve-identifier";
import { findAllReferencesAsNodes } from "./rename-symbol";

const TEST_FILE_PATH = "/test.ts";

const setupProject = () => {
	const project = createInMemoryProject();

	const getIdentifier = (
		content: string,
		position: { line: number; column: number },
	): Identifier => {
		project.createSourceFile(TEST_FILE_PATH, content, {
			overwrite: true,
		});
		return findIdentifierNode(project, TEST_FILE_PATH, position);
	};
	return { project, getIdentifier };
};

describe("findIdentifierNode", () => {
	it("finds the function identifier at the specified position", () => {
		const { getIdentifier } = setupProject();
		const fileContent = "function myFunction() {}";
		const identifier = getIdentifier(fileContent, { line: 1, column: 10 });
		expect(identifier.getText()).toBe("myFunction");
		expect(identifier.getParent()?.getKind()).toBe(
			SyntaxKind.FunctionDeclaration,
		);
	});

	it("finds the variable identifier at the specified position", () => {
		const { getIdentifier } = setupProject();
		const fileContent = "const myVariable = 1;";
		const identifier = getIdentifier(fileContent, { line: 1, column: 7 });
		expect(identifier.getText()).toBe("myVariable");
		expect(identifier.getParent()?.getKind()).toBe(
			SyntaxKind.VariableDeclaration,
		);
	});

	it("finds the identifier even when the position is in the middle of the identifier text", () => {
		const { getIdentifier } = setupProject();
		const fileContent = "function myFunction() {}";
		const identifier = getIdentifier(fileContent, { line: 1, column: 12 });
		expect(identifier.getText()).toBe("myFunction");
	});

	it("throws an error when the file does not exist", () => {
		const { project } = setupProject();
		expect(() =>
			findIdentifierNode(project, "/nonexistent.ts", { line: 1, column: 1 }),
		).toThrowError(new Error("File not found: /nonexistent.ts"));
	});

	it("throws an error when no node is found at the position (out of range)", () => {
		const { project } = setupProject();
		const fileContent = "const x = 1;";
		project.createSourceFile(TEST_FILE_PATH, fileContent);
		expect(() =>
			findIdentifierNode(project, TEST_FILE_PATH, { line: 5, column: 1 }),
		).toThrowError(
			new Error("The specified position (5:1) is out of range or invalid"),
		);
	});

	it("throws an error when the node at the position is not an identifier (e.g. a keyword)", () => {
		const { project } = setupProject();
		const fileContent = "function myFunction() {}";
		project.createSourceFile(TEST_FILE_PATH, fileContent);
		expect(() =>
			findIdentifierNode(project, TEST_FILE_PATH, { line: 1, column: 3 }),
		).toThrowError(
			new Error(
				"The node at the specified position (1:3) is not an Identifier",
			),
		);
	});
});

describe("validateSymbol", () => {
	it("does not throw when the symbol name matches", () => {
		const { getIdentifier } = setupProject();
		const identifier = getIdentifier("function myFunc() {}", {
			line: 1,
			column: 10,
		});
		expect(() => validateSymbol(identifier, "myFunc")).not.toThrow();
	});
	it("throws an error when the symbol name does not match", () => {
		const { getIdentifier } = setupProject();
		const identifier = getIdentifier("function myFunc() {}", {
			line: 1,
			column: 10,
		});
		expect(() => validateSymbol(identifier, "wrongName")).toThrowError(
			new Error("Symbol name mismatch (expected: wrongName, actual: myFunc)"),
		);
	});
});

describe("findAllReferencesAsNodes", () => {
	it("returns all definitions and references of the symbol", () => {
		const project = createInMemoryProject();
		project.createSourceFile(
			"/src/lib.ts",
			"export function target() {}\ntarget();",
		);
		project.createSourceFile(
			"/src/user.ts",
			'import { target } from "./lib";\ntarget();',
		);

		const lib = project.getSourceFileOrThrow("/src/lib.ts");
		const targetIdentifier = lib
			.getFunctionOrThrow("target")
			.getNameNodeOrThrow();

		const references = findAllReferencesAsNodes(targetIdentifier);

		const referenceTexts = references.map((node) => node.getText());
		expect(referenceTexts).toContain("target");
		expect(references.length).toBeGreaterThanOrEqual(2);
	});
});
