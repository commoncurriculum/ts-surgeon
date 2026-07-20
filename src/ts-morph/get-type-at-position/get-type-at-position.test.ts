import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { getTypeAtPosition } from "./get-type-at-position.js";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	return project;
}

describe("getTypeAtPosition", () => {
	describe("basics", () => {
		it("retrieves the type of a variable identifier", () => {
			const project = setup({
				"/a.ts": [
					'const user = { id: "u1", name: "alice" };',
					"console.log(user);",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 13,
			});
			expect(result.nodeKind).toBe("Identifier");
			expect(result.nodeText).toBe("user");
			expect(result.type).toBe("{ id: string; name: string; }");
			expect(result.symbol).toEqual({
				name: "user",
				kind: "VariableDeclaration",
			});
			expect(result.declaration?.filePath).toBe("/a.ts");
			expect(result.declaration?.line).toBe(1);
		});

		it("retrieves the type (signature) of a function identifier", () => {
			const project = setup({
				"/a.ts": [
					"function greet(name: string): string {",
					'  return "hello " + name;',
					"}",
					"greet('world');",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 4,
				column: 1,
			});
			expect(result.nodeKind).toBe("Identifier");
			expect(result.type).toBe("(name: string) => string");
			expect(result.symbol).toEqual({
				name: "greet",
				kind: "FunctionDeclaration",
			});
		});

		it("retrieves the type of the property portion of a property access", () => {
			const project = setup({
				"/a.ts": [
					'const user = { id: 42, name: "alice" };',
					"const x = user.name;",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 16, // "name" in user.name
			});
			expect(result.nodeKind).toBe("Identifier");
			expect(result.nodeText).toBe("name");
			expect(result.type).toBe("string");
		});

		it("returns the function's type at the called function identifier position for a call expression result", () => {
			const project = setup({
				"/a.ts": [
					"function getNumber(): number { return 1; }",
					"const x = getNumber();",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 11,
			});
			expect(result.type).toBe("() => number");
		});
	});

	describe("function signature modifier preservation", () => {
		it("preserves the rest parameter `...`", () => {
			const project = setup({
				"/a.ts": [
					"function f(a: number, ...rest: number[]): void {}",
					"f(1, 2, 3);",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 1,
			});
			expect(result.type).toBe("(a: number, ...rest: number[]) => void");
		});

		it("preserves the optional `?` modifier", () => {
			const project = setup({
				"/a.ts": ["function f(a: number, b?: string): void {}", "f(1);"].join(
					"\n",
				),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 1,
			});
			expect(result.type).toBe("(a: number, b?: string) => void");
		});

		it("preserves destructuring parameters as original source text rather than `__0`", () => {
			const project = setup({
				"/a.ts": [
					"function f({ a, b }: { a: number; b: string }): void {}",
					"f({ a: 1, b: 'x' });",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 1,
			});
			// Synthesized names like __0 must not be exposed
			expect(result.type).not.toContain("__0");
			expect(result.type).toContain("{ a, b }");
			expect(result.type).toContain("a: number");
		});
	});

	describe("overloaded functions", () => {
		it("returns overload signatures joined with `&` and hides the implementation signature", () => {
			const project = setup({
				"/a.ts": [
					"function f(a: string): string;",
					"function f(a: number): number;",
					"function f(a: string | number) { return a; }",
					"f('hi');",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 4,
				column: 1,
			});
			expect(result.type).toBe(
				"((a: string) => string) & ((a: number) => number)",
			);
		});
	});

	describe("function + namespace merge", () => {
		it("does not expand to signature form in order to preserve the namespace-side properties", () => {
			const project = setup({
				"/a.ts": [
					"function fn(x: number): string { return ''; }",
					"namespace fn { export const version = '1.0'; }",
					"const ref = fn;",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 3,
				column: 13,
			});
			// If the signature were expanded it would become "(x: number) => string", silently dropping the namespace side (version).
			// Keep the raw `typeof fn` that TS returns so an agent can still navigate to the declaration.
			expect(result.type).not.toMatch(/^\(x: number\) => string$/);
			expect(result.type).toBe("typeof fn");
		});
	});

	describe("literals", () => {
		it("returns a string literal type at a string literal position", () => {
			const project = setup({
				"/a.ts": 'const x = "hello";',
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 1,
				column: 12, // inside "hello"
			});
			expect(result.nodeKind).toBe("StringLiteral");
			expect(result.type).toBe('"hello"');
		});

		it("returns a numeric literal type at a numeric literal position", () => {
			const project = setup({
				"/a.ts": "const x = 42;",
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 1,
				column: 11,
			});
			expect(result.nodeKind).toBe("NumericLiteral");
			expect(result.type).toBe("42");
		});
	});

	describe("import alias resolution", () => {
		it("returns the declaration location of a directly imported symbol in the original file", () => {
			const project = setup({
				"/lib.ts":
					"export function helper(n: number): string { return String(n); }",
				"/a.ts": ['import { helper } from "./lib";', "helper(1);"].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 1,
			});
			expect(result.symbol?.name).toBe("helper");
			expect(result.declaration?.filePath).toBe("/lib.ts");
			expect(result.declaration?.line).toBe(1);
			expect(result.type).toBe("(n: number) => string");
		});

		it("recursively resolves to the original declaration even through a barrel re-export (export * from)", () => {
			const project = setup({
				"/a.ts":
					"export function helper(n: number): string { return String(n); }",
				"/index.ts": 'export * from "./a";',
				"/main.ts": ['import { helper } from "./index";', "helper(1);"].join(
					"\n",
				),
			});
			const result = getTypeAtPosition(project, "/main.ts", {
				line: 2,
				column: 1,
			});
			expect(result.symbol?.name).toBe("helper");
			expect(result.declaration?.filePath).toBe("/a.ts");
			expect(result.declaration?.line).toBe(1);
		});

		it("recursively resolves to the original declaration even through a named re-export (export { x } from)", () => {
			const project = setup({
				"/a.ts":
					"export function helper(n: number): string { return String(n); }",
				"/index.ts": 'export { helper } from "./a";',
				"/main.ts": ['import { helper } from "./index";', "helper(1);"].join(
					"\n",
				),
			});
			const result = getTypeAtPosition(project, "/main.ts", {
				line: 2,
				column: 1,
			});
			expect(result.declaration?.filePath).toBe("/a.ts");
		});
	});

	describe("generics", () => {
		it("can recover user-defined generic types", () => {
			const project = setup({
				"/a.ts": [
					"type Box<T> = { value: T };",
					'const b: Box<string> = { value: "hi" };',
					"const v = b;",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 3,
				column: 11,
			});
			expect(result.type).toBe("Box<string>");
		});

		it("preserves union types", () => {
			const project = setup({
				"/a.ts": [
					"function f(): string | number { return 1; }",
					"const v = f();",
					"const w = v;",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 3,
				column: 11,
			});
			expect(result.type).toBe("string | number");
		});

		it("preserves the original type parameters in a generic function signature", () => {
			const project = setup({
				"/a.ts": [
					"function identity<T>(x: T): T { return x; }",
					"identity(1);",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 1,
			});
			// Built from the original declaration, so T is preserved rather than the inferred number
			expect(result.type).toBe("(x: T) => T");
		});
	});

	describe("error handling", () => {
		it("throws an error for a non-existent file", () => {
			const project = setup({});
			expect(() =>
				getTypeAtPosition(project, "/nonexistent.ts", {
					line: 1,
					column: 1,
				}),
			).toThrow(/File not found/);
		});

		it("throws an error for a position outside the file's range", () => {
			const project = setup({ "/a.ts": "const x = 1;" });
			expect(() =>
				getTypeAtPosition(project, "/a.ts", { line: 99, column: 1 }),
			).toThrow(/out of range/);
		});

		it("throws an error for invalid positions such as line=0 / column=0", () => {
			const project = setup({ "/a.ts": "const x = 1;" });
			expect(() =>
				getTypeAtPosition(project, "/a.ts", { line: 0, column: 1 }),
			).toThrow(/1-based/);
			expect(() =>
				getTypeAtPosition(project, "/a.ts", { line: 1, column: 0 }),
			).toThrow(/1-based/);
			expect(() =>
				getTypeAtPosition(project, "/a.ts", { line: -1, column: 1 }),
			).toThrow(/1-based/);
		});

		it("returns type information even for a trailing blank line (SourceFile-level type)", () => {
			// getDescendantAtPos returns SourceFile even over whitespace, so no error is thrown.
			// Checking both nodeKind and type makes it possible to detect ts-morph version differences.
			const project = setup({ "/a.ts": "const x = 1;\n\n" });
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 1,
			});
			expect(["SourceFile", "EndOfFileToken"]).toContain(result.nodeKind);
			// Even at a whitespace position, some type string must be returned (not empty or undefined)
			expect(typeof result.type).toBe("string");
			expect(result.type.length).toBeGreaterThan(0);
		});
	});

	describe("type annotation positions", () => {
		it("retrieves the type at a type alias usage position (argument type annotation)", () => {
			const project = setup({
				"/a.ts": [
					"type UserId = string;",
					"function f(id: UserId) { return id; }",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 2,
				column: 16, // "UserId" in type annotation
			});
			expect(result.symbol?.name).toBe("UserId");
			expect(result.symbol?.kind).toBe("TypeAliasDeclaration");
		});
	});

	describe("methods / accessors", () => {
		it("retrieves the signature of an instance method call", () => {
			const project = setup({
				"/a.ts": [
					"class C {",
					"  greet(name: string): string { return name; }",
					"}",
					"const c = new C();",
					"c.greet('hi');",
				].join("\n"),
			});
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 5,
				column: 3, // "greet" in c.greet(...)
			});
			expect(result.type).toBe("(name: string) => string");
		});
	});

	describe("safe truncation of nodeText", () => {
		it("does not split UTF-16 surrogate pairs mid-pair", () => {
			// 79 chars + 1 emoji (= 81 code points). Cutting at code point 80 stops before the emoji.
			const longString = `"${"a".repeat(78)}\u{1F389}xyz"`;
			const project = setup({
				"/a.ts": `const x = ${longString};`,
			});
			// Points to the position of the string literal body
			const result = getTypeAtPosition(project, "/a.ts", {
				line: 1,
				column: 11,
			});
			expect(result.nodeKind).toBe("StringLiteral");
			// If truncation occurred the text ends with '…', but no lone surrogates must remain
			if (result.nodeText.endsWith("…")) {
				// The portion after removing the trailing '…' must be well-formed UTF-16
				const body = result.nodeText.slice(0, -1);
				// Detect a lone high surrogate
				expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
			}
		});
	});
});
