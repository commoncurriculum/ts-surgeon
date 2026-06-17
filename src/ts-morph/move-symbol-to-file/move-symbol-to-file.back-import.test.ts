import { describe, it, expect } from "vitest";
import { SyntaxKind } from "ts-morph";
import { createInMemoryProjectWithDoubleQuotes } from "../_test-utils/create-in-memory-project";
import { getFileText } from "../_test-utils/get-file-text";
import { moveSymbolToFile } from "./move-symbol-to-file";

describe("moveSymbolToFile back-import (regression)", () => {
	// When symbols remaining in the source file reference the moved symbol, a back-import
	// from the destination file must be added. The old implementation relied on fixMissingImports(),
	// but the combination of "leading JSDoc + type declaration + fixMissingImports after removal"
	// caused ts-morph to throw "children of the old and new trees were expected to have the
	// same count". Reproduced with hono's src/utils/url.ts.
	it("adds a back-import when remaining code in the source file references the moved symbol", async () => {
		const project = createInMemoryProjectWithDoubleQuotes();
		const oldFilePath = "/src/url.ts";
		const newFilePath = "/src/split-path.ts";

		project.createSourceFile(
			oldFilePath,
			`/**
 * @module
 */

export type Pattern = readonly [string, string, RegExp | true] | '*'
export const splitPath = (path: string): string[] => {
  return path.split("/");
};
export const splitRoutingPath = (routePath: string): string[] => {
  return splitPath(routePath);
};
`,
		);

		await moveSymbolToFile(
			project,
			oldFilePath,
			newFilePath,
			"splitPath",
			SyntaxKind.VariableStatement,
		);

		const oldText = getFileText(project, oldFilePath);
		const newText = getFileText(project, newFilePath);

		// the destination has the splitPath body
		expect(newText).toContain(
			"export const splitPath = (path: string): string[]",
		);
		// the source no longer holds the declaration but has the back-import
		expect(oldText).not.toContain("export const splitPath");
		expect(oldText).toContain('import { splitPath } from "./split-path"');
		// the remaining referencing code is untouched
		expect(oldText).toContain("export const splitRoutingPath");
		expect(oldText).toContain("return splitPath(routePath)");
	});

	it("consolidates back-imports into one when multiple symbols in the source file reference the moved symbol", async () => {
		const project = createInMemoryProjectWithDoubleQuotes();
		const oldFilePath = "/src/source.ts";
		const newFilePath = "/src/shared.ts";

		project.createSourceFile(
			oldFilePath,
			`export const shared = (x: number): number => x * 2;
export const a = (x: number): number => shared(x) + 1;
export const b = (x: number): number => shared(x) - 1;
`,
		);

		await moveSymbolToFile(
			project,
			oldFilePath,
			newFilePath,
			"shared",
			SyntaxKind.VariableStatement,
		);

		const oldText = getFileText(project, oldFilePath);
		const importCount = (
			oldText.match(/import \{ shared \} from "\.\/shared"/g) ?? []
		).length;
		expect(importCount).toBe(1);
		expect(oldText).toContain("export const a");
		expect(oldText).toContain("export const b");
		expect(getFileText(project, newFilePath)).toContain("export const shared");
	});
});
