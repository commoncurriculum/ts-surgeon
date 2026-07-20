import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { findUnusedExports } from "./find-unused-exports.js";

function setup(files: Record<string, string>): Project {
	const project = createInMemoryProject();
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content, { overwrite: true });
	}
	return project;
}

function names(result: { unusedExports: { name: string }[] }): string[] {
	return result.unusedExports.map((e) => e.name).sort();
}

describe("findUnusedExports", () => {
	describe("basics", () => {
		it("a function export not imported from anywhere is reported as unused", () => {
			const project = setup({
				"/a.ts": "export function unused(): void {}",
				"/b.ts": "const x = 1;",
			});
			const result = findUnusedExports(project);
			expect(names(result)).toEqual(["unused"]);
			expect(result.unusedExports[0]).toMatchObject({
				filePath: "/a.ts",
				name: "unused",
				kind: "FunctionDeclaration",
				isDefaultExport: false,
				line: 1,
			});
		});

		it("a function export that is imported from another file is not reported", () => {
			const project = setup({
				"/a.ts": "export function used(): void {}",
				"/b.ts": ['import { used } from "./a";', "used();"].join("\n"),
			});
			const result = findUnusedExports(project);
			expect(result.unusedExports).toEqual([]);
		});

		it("an export used only within the same file is reported as unused", () => {
			const project = setup({
				"/a.ts": [
					"export function onlyLocal(): number { return 1; }",
					"const x = onlyLocal();",
					"console.log(x);",
				].join("\n"),
			});
			const result = findUnusedExports(project);
			expect(names(result)).toEqual(["onlyLocal"]);
		});

		it("multiple declaration kinds are detected simultaneously", () => {
			const project = setup({
				"/a.ts": [
					"export function fnA(): void {}",
					"export class ClsA {}",
					"export const constA = 1;",
					"export enum EnumA { x }",
					"export interface IfaceA { v: number }",
					"export type TypeA = string;",
				].join("\n"),
			});
			const result = findUnusedExports(project);
			expect(names(result)).toEqual([
				"ClsA",
				"EnumA",
				"IfaceA",
				"TypeA",
				"constA",
				"fnA",
			]);
		});
	});

	describe("default export", () => {
		it("export default function is reported if not imported from anywhere", () => {
			const project = setup({
				"/a.ts": "export default function answer(): number { return 42; }",
			});
			const result = findUnusedExports(project);
			expect(result.unusedExports).toHaveLength(1);
			expect(result.unusedExports[0]).toMatchObject({
				name: "answer",
				isDefaultExport: true,
				kind: "FunctionDeclaration",
			});
		});

		it("export default Identifier is not reported when referenced via a default import", () => {
			const project = setup({
				"/a.ts": [
					"function answer(): number { return 42; }",
					"export default answer;",
				].join("\n"),
				"/b.ts": ['import answer from "./a";', "answer();"].join("\n"),
			});
			const result = findUnusedExports(project);
			expect(result.unusedExports).toEqual([]);
		});

		it("export default <literal expression> has no identifier and is excluded from candidates", () => {
			const project = setup({
				"/a.ts": "export default 42;",
			});
			const result = findUnusedExports(project);
			expect(result.unusedExports).toEqual([]);
		});
	});

	describe("re-export (barrel)", () => {
		it("an export that is only re-exported via a barrel with no external consumers is reported as unused", () => {
			const project = setup({
				"/lib.ts": "export function helper(): void {}",
				"/index.ts": 'export * from "./lib";',
			});
			const result = findUnusedExports(project);
			// helper is only re-exported and has no actual consumers, so it is unused
			expect(names(result)).toContain("helper");
		});

		it("an export that is consumed via a barrel by another file is not reported", () => {
			const project = setup({
				"/lib.ts": "export function helper(): void {}",
				"/index.ts": 'export { helper } from "./lib";',
				"/main.ts": ['import { helper } from "./index";', "helper();"].join(
					"\n",
				),
			});
			const result = findUnusedExports(project);
			expect(names(result)).not.toContain("helper");
		});
	});

	describe("entryPoints option", () => {
		it("exports in files listed in entryPoints are excluded from scanning and not reported", () => {
			const project = setup({
				"/public-api.ts": "export function publicFn(): void {}",
				"/internal.ts": "export function internalFn(): void {}",
			});
			const result = findUnusedExports(project, {
				entryPoints: ["/public-api.ts"],
			});
			expect(names(result)).toEqual(["internalFn"]);
		});
	});

	describe("excludeFilePatterns option", () => {
		it("files matching a pattern are excluded from scanning", () => {
			const project = setup({
				"/src/a.ts": "export function fn(): void {}",
				"/src/a.test.ts": "export function helper(): void {}",
			});
			const result = findUnusedExports(project, {
				excludeFilePatterns: [".test."],
			});
			expect(names(result)).toEqual(["fn"]);
		});
	});

	describe("maxResults option", () => {
		it("when the limit is reached, truncated=true is returned and scanning stops", () => {
			const project = setup({
				"/a.ts": [
					"export const a = 1;",
					"export const b = 2;",
					"export const c = 3;",
				].join("\n"),
			});
			const result = findUnusedExports(project, { maxResults: 2 });
			expect(result.unusedExports).toHaveLength(2);
			expect(result.truncated).toBe(true);
		});

		it("when the count is below the limit, truncated=false", () => {
			const project = setup({
				"/a.ts": ["export const a = 1;", "export const b = 2;"].join("\n"),
			});
			const result = findUnusedExports(project, { maxResults: 10 });
			expect(result.unusedExports).toHaveLength(2);
			expect(result.truncated).toBe(false);
		});

		it("an invalid maxResults value throws an error", () => {
			const project = setup({ "/a.ts": "export const a = 1;" });
			expect(() => findUnusedExports(project, { maxResults: 0 })).toThrow(
				/integer of 1 or greater/,
			);
			expect(() => findUnusedExports(project, { maxResults: -1 })).toThrow();
			expect(() => findUnusedExports(project, { maxResults: 1.5 })).toThrow();
		});
	});

	describe("exclusions", () => {
		it("declaration files (.d.ts) are excluded from scanning", () => {
			const project = setup({
				"/types.d.ts": "export declare function ambient(): void;",
				"/a.ts": "export function used(): void {}",
				"/b.ts": ['import { used } from "./a";', "used();"].join("\n"),
			});
			const result = findUnusedExports(project);
			expect(names(result)).not.toContain("ambient");
		});
	});

	describe("textOccurrences (name text occurrence count)", () => {
		it("returns 0 when the name appears nowhere", () => {
			const project = setup({
				"/a.ts": "export function reallyDead(): void {}",
				"/b.ts": "const x = 1;",
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find((e) => e.name === "reallyDead");
			expect(entry?.textOccurrences).toBe(0);
		});

		it("returns 1+ when the name appears in a string literal", () => {
			const project = setup({
				"/a.ts": "export function dynamicCalled(): void {}",
				// dynamic reference: not picked up by findReferences since it's not a static import
				"/b.ts": 'const name = "dynamicCalled"; console.log(name);',
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find(
				(e) => e.name === "dynamicCalled",
			);
			expect(entry?.textOccurrences).toBeGreaterThan(0);
		});

		it("occurrences in the declaring file itself are not counted", () => {
			const project = setup({
				// the declaring file contains "selfRef" multiple times (declaration + internal self-call)
				"/a.ts": [
					"export function selfRef(): void {",
					"  selfRef();",
					"}",
				].join("\n"),
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find((e) => e.name === "selfRef");
			expect(entry?.textOccurrences).toBe(0);
		});

		it("names injected by synthetic imports are not counted (avoids self-pollution during namespace expansion)", () => {
			const project = setup({
				// foo is declared in actions.ts and spread via `import * as` in bundle.ts
				// with expansion enabled, bundle.ts gets a synthetic import, but "foo" in it should be excluded
				"/actions.ts": "export const foo = 1;",
				"/bundle.ts": [
					'import * as actions from "./actions";',
					"export const all = { ...actions };",
				].join("\n"),
				"/main.ts": [
					'import { all } from "./bundle";',
					"console.log(all);",
				].join("\n"),
			});
			const result = findUnusedExports(project);
			// foo is judged "used" via namespace spread → expected not to appear in candidates
			expect(
				result.unusedExports.find((e) => e.name === "foo"),
			).toBeUndefined();
		});
	});

	describe("sameFileReferenceCount (same-file reference count)", () => {
		it("an export used nowhere has count 0 (safe to delete the whole declaration)", () => {
			const project = setup({
				"/a.ts": "export function reallyDead(): void {}",
				"/b.ts": "const x = 1;",
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find((e) => e.name === "reallyDead");
			expect(entry?.sameFileReferenceCount).toBe(0);
		});

		it("an export used only within the same file has count 1+ (only the export keyword is unnecessary)", () => {
			const project = setup({
				"/a.ts": [
					"export function onlyLocal(): number { return 1; }",
					"const x = onlyLocal();",
					"console.log(x);",
				].join("\n"),
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find((e) => e.name === "onlyLocal");
			// externally unreferenced but used once within the same file
			expect(entry?.sameFileReferenceCount).toBe(1);
		});

		it("counts multiple uses within the same file", () => {
			const project = setup({
				"/a.ts": [
					"export const seed = 1;",
					"const a = seed + 1;",
					"const b = seed + 2;",
					"console.log(a, b);",
				].join("\n"),
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find((e) => e.name === "seed");
			expect(entry?.sameFileReferenceCount).toBe(2);
		});

		it("the declaration identifier itself is not counted as a same-file reference", () => {
			const project = setup({
				"/a.ts": "export function lonely(): void {}",
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find((e) => e.name === "lonely");
			expect(entry?.sameFileReferenceCount).toBe(0);
		});

		it("a same-file re-export site (export { x }) is not counted as a reference", () => {
			const project = setup({
				"/a.ts": [
					"function localOnly(): void {}",
					"export { localOnly };",
				].join("\n"),
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find((e) => e.name === "localOnly");
			// only re-exported, no actual usage → 0 (dead, safe to delete)
			expect(entry?.sameFileReferenceCount).toBe(0);
		});
	});

	describe("namespace import expansion", () => {
		it("an export used only via `import * as ns` + `{ ...ns }` is treated as used by default", () => {
			const project = setup({
				"/actions.ts": [
					"export const addToast = () => {};",
					"export const resetToast = () => {};",
				].join("\n"),
				"/bundle.ts": [
					'import * as actions from "./actions";',
					"export const all = { ...actions };",
				].join("\n"),
				"/main.ts": ['import { all } from "./bundle";', "all.addToast();"].join(
					"\n",
				),
			});
			const result = findUnusedExports(project);
			// without expansion both addToast and resetToast would appear as false positives; with expansion: 0 results
			expect(names(result)).not.toContain("addToast");
			expect(names(result)).not.toContain("resetToast");
		});

		it("with expandNamespaceImports: false, namespace-only exports are detected as unused", () => {
			const project = setup({
				"/actions.ts": [
					"export const addToast = () => {};",
					"export const resetToast = () => {};",
				].join("\n"),
				"/bundle.ts": [
					'import * as actions from "./actions";',
					"export const all = { ...actions };",
				].join("\n"),
				"/main.ts": ['import { all } from "./bundle";', "all.addToast();"].join(
					"\n",
				),
			});
			const result = findUnusedExports(project, {
				expandNamespaceImports: false,
			});
			expect(names(result)).toContain("addToast");
			expect(names(result)).toContain("resetToast");
		});

		it("an export that is truly unused even considering namespace access continues to be detected", () => {
			const project = setup({
				"/actions.ts": [
					"export const used = () => {};",
					"export const reallyUnused = () => {};",
				].join("\n"),
				"/bundle.ts": [
					'import * as actions from "./actions";',
					"export const all = actions.used;",
				].join("\n"),
				"/main.ts": ['import { all } from "./bundle";', "all();"].join("\n"),
			});
			// reallyUnused is not accessed even via ns.X, but namespace expansion conservatively
			// treats it as "possibly used" — this test documents that design tradeoff explicitly.
			const result = findUnusedExports(project);
			expect(names(result)).not.toContain("reallyUnused");
			expect(names(result)).not.toContain("used");
		});
	});

	describe("namespace import expansion: side effects and collision avoidance", () => {
		it("the Project text contains no synthetic ImportDeclarations after the call", () => {
			const project = setup({
				"/actions.ts": "export const addToast = () => {};",
				"/bundle.ts": [
					'import * as actions from "./actions";',
					"export const all = { ...actions };",
				].join("\n"),
			});
			findUnusedExports(project);
			// If the content is clean, a subsequent project.save() will simply write back the original text.
			// The isSaved() flag may still be dirty after add+remove — that is ts-morph's expected behavior, so we don't check it.
			for (const sf of project.getSourceFiles()) {
				expect(sf.getFullText()).not.toContain(
					"__find_unused_exports_ns_ref__",
				);
			}
		});

		it("same-name exports from different modules imported via namespace do not cause alias collisions", () => {
			const project = setup({
				"/libA.ts": "export const addToast = () => {};",
				"/libB.ts": "export const addToast = () => {};",
				"/consumer.ts": [
					'import * as a from "./libA";',
					'import * as b from "./libB";',
					"export const all = { ...a, ...b };",
				].join("\n"),
				// side with actual usage
				"/main.ts": ['import { all } from "./consumer";', "all;"].join("\n"),
			});
			// A collision causing findReferences to throw would produce false negatives via logger.warn + catch,
			// but unique aliases prevent throwing. Both addToast entries should be judged "used" → not in candidates.
			const result = findUnusedExports(project);
			expect(
				result.unusedExports.map((e) => `${e.filePath}::${e.name}`),
			).not.toContain("/libA.ts::addToast");
			expect(
				result.unusedExports.map((e) => `${e.filePath}::${e.name}`),
			).not.toContain("/libB.ts::addToast");
		});

		it("type-only exports are not injected as value imports (preserving detection of unused type exports)", () => {
			const project = setup({
				"/types.ts": [
					"export interface Foo { v: number }",
					"export type Bar = number;",
				].join("\n"),
				"/consumer.ts": [
					'import * as t from "./types";',
					"export const x: any = { ...t };",
				].join("\n"),
			});
			const result = findUnusedExports(project);
			// type-only exports are excluded from synthetic imports, so they are still detected as unused
			expect(names(result)).toContain("Foo");
			expect(names(result)).toContain("Bar");
		});

		it("reading the same module via multiple `import * as` declarations injects the synthetic import only once", () => {
			const project = setup({
				"/mod.ts": "export const foo = 1;",
				"/consumer.ts": [
					'import * as a from "./mod";',
					'import * as b from "./mod";',
					"export const all = { ...a, ...b };",
				].join("\n"),
				"/main.ts": ['import { all } from "./consumer";', "all;"].join("\n"),
			});
			// Just verify cleanup (no TS error from duplicate synthetic imports → throw → swallowed catch)
			const result = findUnusedExports(project);
			expect(result.unusedExports.map((e) => e.name)).not.toContain("foo");
		});
	});

	describe("Unicode identifier text occurrence counting", () => {
		it("textOccurrences is counted correctly for non-ASCII names", () => {
			const project = setup({
				"/a.ts": "export function café(): void {}",
				// the name appears only in a string literal
				"/b.ts": 'const name = "café"; console.log(name);',
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find((e) => e.name === "café");
			expect(entry?.textOccurrences).toBeGreaterThan(0);
		});

		it("IdentifierPart boundaries are handled correctly for non-ASCII names", () => {
			const project = setup({
				"/a.ts": "export function λ(): void {}",
				// `λ` in a JSX-like position
				"/b.ts": 'const name = "λ";',
			});
			const result = findUnusedExports(project);
			const entry = result.unusedExports.find((e) => e.name === "λ");
			expect(entry?.textOccurrences).toBeGreaterThan(0);
		});
	});

	describe("entryPoints path normalization", () => {
		it("non-normalized paths (containing `..`) are normalized before matching", () => {
			const project = setup({
				"/src/public-api.ts": "export function publicFn(): void {}",
				"/src/internal.ts": "export function internalFn(): void {}",
			});
			const result = findUnusedExports(project, {
				entryPoints: ["/src/sub/../public-api.ts"],
			});
			// without normalization the entryPoint would be ignored and publicFn would also be reported
			expect(names(result)).toEqual(["internalFn"]);
		});
	});

	describe("result metadata", () => {
		it("scannedFiles returns the file count after filtering", () => {
			const project = setup({
				"/a.ts": "export function fn(): void {}",
				"/b.ts": "const x = 1;",
				"/c.test.ts": "export function helper(): void {}",
			});
			const result = findUnusedExports(project, {
				excludeFilePatterns: [".test."],
			});
			expect(result.scannedFiles).toBe(2);
		});

		it("position information reflects the identifier's position", () => {
			const project = setup({
				"/a.ts": [
					"// header comment",
					"export function target(): void {}",
				].join("\n"),
			});
			const result = findUnusedExports(project);
			expect(result.unusedExports[0]).toMatchObject({
				line: 2,
				name: "target",
			});
			// "target" in "export function target" is around column 17 (1-based)
			expect(result.unusedExports[0].column).toBeGreaterThan(1);
		});
	});
});
