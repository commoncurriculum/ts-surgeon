import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import { findIdentifierNode } from "../_utils/resolve-identifier";
import {
	computeNewArgumentTexts,
	computeNewParameterStructures,
	validateRestParameterIsLast,
} from "./apply-changes";
import { changeSignatureOnProject } from "./change-signature";
import { filterCallSites } from "./find-call-sites";
import {
	findFunctionLikeDeclaration,
	getAllRelatedFunctionDeclarations,
} from "./find-function-declaration";
import type { ChangeSignatureOperation } from "./types";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	return project;
}

describe("computeNewArgumentTexts", () => {
	it("add: inserts at the specified index when argumentForCallers is provided", () => {
		const result = computeNewArgumentTexts(
			["a", "b"],
			[{ kind: "add", index: 1, name: "x", argumentForCallers: "ctx" }],
		);
		expect(result).toEqual(["a", "ctx", "b"]);
	});

	it("add: does not change call arguments when argumentForCallers is absent", () => {
		const result = computeNewArgumentTexts(
			["a"],
			[{ kind: "add", name: "x", defaultValue: "0" }],
		);
		expect(result).toEqual(["a"]);
	});

	it("add: throws an error when index exceeds the call's argument count", () => {
		expect(() =>
			computeNewArgumentTexts(
				[],
				[
					{
						kind: "add",
						index: 2,
						name: "c",
						argumentForCallers: "9",
					},
				],
			),
		).toThrow(/index=2/);
	});

	it("remove: removes the argument at the specified index", () => {
		const result = computeNewArgumentTexts(
			["a", "b", "c"],
			[{ kind: "remove", index: 1 }],
		);
		expect(result).toEqual(["a", "c"]);
	});

	it("remove: no change when argument count is insufficient (omitted optional)", () => {
		const result = computeNewArgumentTexts(
			["a"],
			[{ kind: "remove", index: 2 }],
		);
		expect(result).toEqual(["a"]);
	});

	it("reorder: reorders according to newOrder", () => {
		const result = computeNewArgumentTexts(
			["a", "b", "c"],
			[{ kind: "reorder", newOrder: [2, 0, 1] }],
		);
		expect(result).toEqual(["c", "a", "b"]);
	});

	it("reorder: throws an error when argument count does not match", () => {
		expect(() =>
			computeNewArgumentTexts(
				["a", "b"],
				[{ kind: "reorder", newOrder: [2, 0, 1] }],
			),
		).toThrow(/Reorder requires call sites/);
	});

	it("applies multiple operations sequentially", () => {
		const result = computeNewArgumentTexts(
			["a", "b"],
			[
				{ kind: "add", index: 0, name: "x", argumentForCallers: "ctx" },
				{ kind: "remove", index: 2 },
			],
		);
		// after add: [ctx, a, b], after remove index 2: [ctx, a]
		expect(result).toEqual(["ctx", "a"]);
	});
});

describe("computeNewParameterStructures", () => {
	it("add: appends to the end (index omitted)", () => {
		const result = computeNewParameterStructures(
			[{ name: "a", type: "string" }],
			[{ kind: "add", name: "b", typeText: "number", defaultValue: "0" }],
		);
		expect(result).toEqual([
			{ name: "a", type: "string" },
			{
				name: "b",
				type: "number",
				hasQuestionToken: undefined,
				initializer: "0",
			},
		]);
	});

	it("add: throws an error when mid-list insertion is missing argumentForCallers", () => {
		expect(() =>
			computeNewParameterStructures(
				[{ name: "a" }, { name: "b" }],
				[{ kind: "add", index: 1, name: "x", typeText: "string" }],
			),
		).toThrow(/argumentForCallers is required/);
	});

	it("add: throws an error when trailing add has no optional/default and no argumentForCallers", () => {
		expect(() =>
			computeNewParameterStructures(
				[{ name: "a" }],
				[{ kind: "add", name: "b", typeText: "string" }],
			),
		).toThrow(/optional or have a defaultValue/);
	});

	it("remove: throws an error when index is out of range", () => {
		expect(() =>
			computeNewParameterStructures(
				[{ name: "a" }],
				[{ kind: "remove", index: 1 }],
			),
		).toThrow(/out of parameter range/);
	});

	it("reorder: throws an error when lengths do not match", () => {
		expect(() =>
			computeNewParameterStructures(
				[{ name: "a" }, { name: "b" }],
				[{ kind: "reorder", newOrder: [0] }],
			),
		).toThrow(/newOrder/);
	});

	it("reorder: throws an error when duplicate index is present", () => {
		expect(() =>
			computeNewParameterStructures(
				[{ name: "a" }, { name: "b" }],
				[{ kind: "reorder", newOrder: [0, 0] }],
			),
		).toThrow(/duplicate or out-of-range/i);
	});

	it("reorder: throws an error when rest parameter is moved to a non-last position", () => {
		expect(() =>
			computeNewParameterStructures(
				[{ name: "a" }, { name: "rest", isRestParameter: true }],
				[{ kind: "reorder", newOrder: [1, 0] }],
			),
		).toThrow(/rest parameter/);
	});

	it("add: throws an error when adding after a rest parameter", () => {
		expect(() =>
			computeNewParameterStructures(
				[{ name: "rest", isRestParameter: true }],
				[
					{
						kind: "add",
						name: "b",
						typeText: "string",
						argumentForCallers: '"x"',
					},
				],
			),
		).toThrow(/rest parameter/);
	});
});

describe("validateRestParameterIsLast", () => {
	it("does not throw when rest is last", () => {
		expect(() =>
			validateRestParameterIsLast([
				{ name: "a" },
				{ name: "rest", isRestParameter: true },
			]),
		).not.toThrow();
	});

	it("throws an error when rest is not last", () => {
		expect(() =>
			validateRestParameterIsLast([
				{ name: "rest", isRestParameter: true },
				{ name: "b" },
			]),
		).toThrow(/rest parameter/);
	});
});

describe("findFunctionLikeDeclaration", () => {
	it("retrieves a function declaration", () => {
		const project = setup({
			"/a.ts": "export function foo(a: number) { return a; }",
		});
		const id = findIdentifierNode(project, "/a.ts", { line: 1, column: 17 });
		const fn = findFunctionLikeDeclaration(id);
		expect(fn.getParameters()).toHaveLength(1);
	});

	it("retrieves an arrow function assignment", () => {
		const project = setup({
			"/a.ts": "export const foo = (a: number) => a;",
		});
		const id = findIdentifierNode(project, "/a.ts", { line: 1, column: 14 });
		const fn = findFunctionLikeDeclaration(id);
		expect(fn.getParameters()).toHaveLength(1);
	});

	it("retrieves a method declaration", () => {
		const project = setup({
			"/a.ts": "export class C { foo(a: number) { return a; } }",
		});
		const id = findIdentifierNode(project, "/a.ts", { line: 1, column: 18 });
		const fn = findFunctionLikeDeclaration(id);
		expect(fn.getParameters()).toHaveLength(1);
	});

	it("retrieves GetAccessor / SetAccessor", () => {
		const project = setup({
			"/a.ts": [
				"export class C {",
				"  get foo() { return 1; }",
				"  set foo(v: number) { /* */ }",
				"}",
			].join("\n"),
		});
		const getterId = findIdentifierNode(project, "/a.ts", {
			line: 2,
			column: 7,
		});
		const setterId = findIdentifierNode(project, "/a.ts", {
			line: 3,
			column: 7,
		});
		expect(findFunctionLikeDeclaration(getterId).getKindName()).toBe(
			"GetAccessor",
		);
		expect(findFunctionLikeDeclaration(setterId).getKindName()).toBe(
			"SetAccessor",
		);
	});

	it("throws an error including the node kind when pointing to a non-function position (parameter)", () => {
		const project = setup({
			"/a.ts": "export function bar(foo: string) { return foo; }",
		});
		const id = findIdentifierNode(project, "/a.ts", { line: 1, column: 21 });
		expect(() => findFunctionLikeDeclaration(id)).toThrow(
			/is not a function declaration\/method\/function expression.*Parameter/,
		);
	});
});

describe("getAllRelatedFunctionDeclarations", () => {
	it("returns a single declaration when there are no overloads", () => {
		const project = setup({
			"/a.ts": "export function foo(a: number) { return a; }",
		});
		const id = findIdentifierNode(project, "/a.ts", { line: 1, column: 17 });
		const fn = findFunctionLikeDeclaration(id);
		expect(getAllRelatedFunctionDeclarations(fn)).toHaveLength(1);
	});

	it("returns all signatures when pointing to overload implementation", () => {
		const project = setup({
			"/a.ts": [
				"export function foo(a: string): string;",
				"export function foo(a: number): number;",
				"export function foo(a: string | number) { return a; }",
			].join("\n"),
		});
		const id = findIdentifierNode(project, "/a.ts", { line: 3, column: 17 });
		const fn = findFunctionLikeDeclaration(id);
		const all = getAllRelatedFunctionDeclarations(fn);
		expect(all).toHaveLength(3);
	});

	it("returns all signatures even when pointing to an overload signature side", () => {
		const project = setup({
			"/a.ts": [
				"export function foo(a: string): string;",
				"export function foo(a: number): number;",
				"export function foo(a: string | number) { return a; }",
			].join("\n"),
		});
		const id = findIdentifierNode(project, "/a.ts", { line: 1, column: 17 });
		const fn = findFunctionLikeDeclaration(id);
		const all = getAllRelatedFunctionDeclarations(fn);
		expect(all).toHaveLength(3);
	});
});

describe("filterCallSites", () => {
	it("extracts only call sites (excludes assignments and type annotations)", () => {
		const project = setup({
			"/a.ts": [
				"export function foo(a: number) { return a; }",
				"foo(1);",
				"const ref = foo;",
				"foo(2);",
			].join("\n"),
		});
		const id = findIdentifierNode(project, "/a.ts", { line: 1, column: 17 });
		const refs = id.findReferencesAsNodes();
		const calls = filterCallSites(refs);
		expect(calls).toHaveLength(2);
		expect(calls[0].getText()).toBe("foo(1)");
		expect(calls[1].getText()).toBe("foo(2)");
	});
});

// ---- Integration tests (going through the real changeSignatureOnProject) ----

async function run(
	project: Project,
	args: {
		targetFilePath: string;
		position: { line: number; column: number };
		functionName: string;
		changes: ChangeSignatureOperation[];
	},
) {
	return changeSignatureOnProject(project, {
		...args,
		dryRun: true, // do not save in tests
	});
}

describe("changeSignatureOnProject", () => {
	it("add: appends a parameter with default value to the end without changing call sites", async () => {
		const project = setup({
			"/a.ts": ["export function foo(a: number) { return a; }", "foo(1);"].join(
				"\n",
			),
			"/b.ts": ['import { foo } from "./a";', "foo(2);"].join("\n"),
		});
		await run(project, {
			targetFilePath: "/a.ts",
			position: { line: 1, column: 17 },
			functionName: "foo",
			changes: [
				{ kind: "add", name: "b", typeText: "number", defaultValue: "0" },
			],
		});
		const a = project.getSourceFileOrThrow("/a.ts").getFullText();
		const b = project.getSourceFileOrThrow("/b.ts").getFullText();
		expect(a).toContain("function foo(a: number, b: number = 0)");
		expect(a).toContain("foo(1);");
		expect(b).toContain("foo(2);");
	});

	it("add: prepends a required parameter and inserts argument at all call sites", async () => {
		const project = setup({
			"/a.ts": ["export function foo(a: number) {}", "foo(1);"].join("\n"),
			"/b.ts": ['import { foo } from "./a";', "foo(2);", "foo(3);"].join("\n"),
		});
		await run(project, {
			targetFilePath: "/a.ts",
			position: { line: 1, column: 17 },
			functionName: "foo",
			changes: [
				{
					kind: "add",
					index: 0,
					name: "ctx",
					typeText: "string",
					argumentForCallers: '"ctx"',
				},
			],
		});
		const a = project.getSourceFileOrThrow("/a.ts").getFullText();
		const b = project.getSourceFileOrThrow("/b.ts").getFullText();
		expect(a).toContain("function foo(ctx: string, a: number)");
		expect(a).toContain('foo("ctx", 1);');
		expect(b).toContain('foo("ctx", 2);');
		expect(b).toContain('foo("ctx", 3);');
	});

	it("remove: removes a parameter and its corresponding argument", async () => {
		const project = setup({
			"/a.ts": [
				"export function foo(a: number, b: string, c: boolean) {}",
				'foo(1, "x", true);',
			].join("\n"),
		});
		await run(project, {
			targetFilePath: "/a.ts",
			position: { line: 1, column: 17 },
			functionName: "foo",
			changes: [{ kind: "remove", index: 1 }],
		});
		const a = project.getSourceFileOrThrow("/a.ts").getFullText();
		expect(a).toContain("function foo(a: number, c: boolean)");
		expect(a).toContain("foo(1, true);");
	});

	it("reorder: reorders parameters and arguments", async () => {
		const project = setup({
			"/a.ts": [
				"export function foo(a: number, b: string, c: boolean) {}",
				'foo(1, "x", true);',
			].join("\n"),
		});
		await run(project, {
			targetFilePath: "/a.ts",
			position: { line: 1, column: 17 },
			functionName: "foo",
			changes: [{ kind: "reorder", newOrder: [2, 0, 1] }],
		});
		const a = project.getSourceFileOrThrow("/a.ts").getFullText();
		expect(a).toContain("function foo(c: boolean, a: number, b: string)");
		expect(a).toContain('foo(true, 1, "x");');
	});

	it("also updates method call sites", async () => {
		const project = setup({
			"/a.ts": [
				"export class C {",
				"  foo(a: number) { return a; }",
				"}",
				"const c = new C();",
				"c.foo(1);",
			].join("\n"),
		});
		await run(project, {
			targetFilePath: "/a.ts",
			position: { line: 2, column: 3 },
			functionName: "foo",
			changes: [
				{
					kind: "add",
					index: 0,
					name: "ctx",
					typeText: "string",
					argumentForCallers: '"x"',
				},
			],
		});
		const text = project.getSourceFileOrThrow("/a.ts").getFullText();
		expect(text).toContain("foo(ctx: string, a: number)");
		expect(text).toContain('c.foo("x", 1);');
	});

	it("overloaded function: updates all signatures and implementation simultaneously", async () => {
		const project = setup({
			"/a.ts": [
				"export function foo(a: string): string;",
				"export function foo(a: number): number;",
				"export function foo(a: string | number) { return a; }",
				'foo("hi");',
				"foo(1);",
			].join("\n"),
		});
		await run(project, {
			targetFilePath: "/a.ts",
			position: { line: 3, column: 17 }, // implementation
			functionName: "foo",
			changes: [
				{
					kind: "add",
					index: 0,
					name: "ctx",
					typeText: "string",
					argumentForCallers: '"c"',
				},
			],
		});
		const a = project.getSourceFileOrThrow("/a.ts").getFullText();
		expect(a).toContain("function foo(ctx: string, a: string): string");
		expect(a).toContain("function foo(ctx: string, a: number): number");
		expect(a).toContain("function foo(ctx: string, a: string | number)");
		expect(a).toContain('foo("c", "hi");');
		expect(a).toContain('foo("c", 1);');
	});

	it("throws an error when spread call exists and arguments need to change (does not partially apply)", async () => {
		const original = [
			"export function foo(a: number, b: number) {}",
			"const args: [number, number] = [1, 2];",
			"foo(...args);",
			"foo(3, 4);",
		].join("\n");
		const project = setup({ "/a.ts": original });

		await expect(
			run(project, {
				targetFilePath: "/a.ts",
				position: { line: 1, column: 17 },
				functionName: "foo",
				changes: [{ kind: "remove", index: 0 }],
			}),
		).rejects.toThrow(/spread arguments/);

		// confirm that no partial application occurred (foo(3, 4) remains unchanged)
		expect(project.getSourceFileOrThrow("/a.ts").getFullText()).toContain(
			"foo(3, 4);",
		);
	});

	it("plan phase validation error: mixed insufficient argument counts — does not partially apply", async () => {
		const project = setup({
			"/a.ts": [
				"export function foo(a: number, b: number) { return a + b; }",
				"foo(1, 2);",
				"foo(3, 4);",
			].join("\n"),
			// intentionally put a call with insufficient arguments in a separate file
			"/b.ts": [
				'import { foo } from "./a";',
				"// @ts-expect-error intentionally missing argument",
				"foo(99);",
			].join("\n"),
		});

		await expect(
			run(project, {
				targetFilePath: "/a.ts",
				position: { line: 1, column: 17 },
				functionName: "foo",
				changes: [{ kind: "reorder", newOrder: [1, 0] }],
			}),
		).rejects.toThrow(/Reorder requires/);

		// confirm that no partial application occurred (calls in a.ts remain unchanged)
		const a = project.getSourceFileOrThrow("/a.ts").getFullText();
		expect(a).toContain("foo(1, 2);");
		expect(a).toContain("foo(3, 4);");
	});

	it("throws an error when mid-list add is missing argumentForCallers", async () => {
		const project = setup({
			"/a.ts": [
				"export function foo(a: string, b: string) {}",
				'foo("x","y");',
			].join("\n"),
		});
		await expect(
			run(project, {
				targetFilePath: "/a.ts",
				position: { line: 1, column: 17 },
				functionName: "foo",
				changes: [{ kind: "add", index: 1, name: "ctx", typeText: "string" }],
			}),
		).rejects.toThrow(/argumentForCallers is required/);
	});

	it("throws an error when adding after a rest parameter", async () => {
		const project = setup({
			"/a.ts": "export function foo(...rest: number[]) {}\nfoo(1, 2);",
		});
		await expect(
			run(project, {
				targetFilePath: "/a.ts",
				position: { line: 1, column: 17 },
				functionName: "foo",
				changes: [
					{
						kind: "add",
						name: "b",
						typeText: "string",
						optional: true,
					},
				],
			}),
		).rejects.toThrow(/rest parameter/);
	});
});
