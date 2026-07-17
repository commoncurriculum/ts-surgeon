import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project";
import { searchText } from "./search-text";

describe("searchText", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let srcDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsurgeon-text-"));
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*"],
			}),
		);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("finds literal matches with 1-based line/column and the line text", () => {
		fs.writeFileSync(
			path.join(srcDir, "a.ts"),
			'const x = 1;\n// TODO: fix this\nconst todoish = "TODO in a string";\n',
		);

		const project = initializeProject(tsconfigPath);
		const result = searchText(project, { query: "TODO" });

		expect(result.totalCount).toBe(2);
		expect(result.truncated).toBe(false);
		expect(result.matches[0]).toMatchObject({
			line: 2,
			column: 4,
			text: "// TODO: fix this",
		});
		expect(result.matches[1]).toMatchObject({ line: 3, column: 18 });
	});

	it("treats the query as literal text by default (no regex surprises)", () => {
		fs.writeFileSync(
			path.join(srcDir, "a.ts"),
			'const a = "value.b";\nconst valueXb = 1;\n',
		);

		const project = initializeProject(tsconfigPath);
		const result = searchText(project, { query: "value.b" });

		// literal '.', not "any character"
		expect(result.totalCount).toBe(1);
		expect(result.matches[0].line).toBe(1);
	});

	it("supports regex mode and case-insensitive search", () => {
		fs.writeFileSync(
			path.join(srcDir, "a.ts"),
			"// TODO one\n// FIXME two\n// todo three\n",
		);

		const project = initializeProject(tsconfigPath);
		const regexResult = searchText(project, {
			query: "TODO|FIXME",
			regex: true,
		});
		expect(regexResult.totalCount).toBe(2);

		const insensitive = searchText(project, {
			query: "todo",
			caseSensitive: false,
		});
		expect(insensitive.totalCount).toBe(2);
	});

	it("rejects an invalid regex with a clear error", () => {
		fs.writeFileSync(path.join(srcDir, "a.ts"), "const x = 1;\n");
		const project = initializeProject(tsconfigPath);
		expect(() => searchText(project, { query: "(", regex: true })).toThrow(
			/Invalid regular expression/,
		);
	});

	it("does not loop forever on a zero-length regex match", () => {
		fs.writeFileSync(path.join(srcDir, "a.ts"), "ab\n");
		const project = initializeProject(tsconfigPath);
		const result = searchText(project, {
			query: "x*",
			regex: true,
			maxResults: 5,
		});
		// every position matches zero-length; the point is that it terminates
		expect(result.totalCount).toBe(4);
		expect(result.matches).toHaveLength(4);
	});

	it("never scans files outside the project graph", () => {
		fs.writeFileSync(path.join(srcDir, "in.ts"), "const NEEDLE = 1;\n");
		// same directory tree, but excluded from the tsconfig include
		const outsideDir = path.join(tempDir, "node_modules", "dep");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "out.ts"), "const NEEDLE = 2;\n");
		fs.writeFileSync(path.join(tempDir, "notes.md"), "NEEDLE everywhere\n");

		const project = initializeProject(tsconfigPath);
		const result = searchText(project, { query: "NEEDLE" });

		expect(result.totalCount).toBe(1);
		expect(result.matches[0].filePath.endsWith("in.ts")).toBe(true);
	});

	it("respects filePaths and maxResults", () => {
		const aPath = path.join(srcDir, "a.ts");
		fs.writeFileSync(aPath, "hit();\nhit();\nhit();\n");
		fs.writeFileSync(path.join(srcDir, "b.ts"), "hit();\n");

		const project = initializeProject(tsconfigPath);
		const result = searchText(project, {
			query: "hit",
			filePaths: [aPath],
			maxResults: 2,
		});

		expect(result.totalCount).toBe(3);
		expect(result.matches).toHaveLength(2);
		expect(result.truncated).toBe(true);
	});

	it("maps offsets correctly across CRLF line endings", () => {
		fs.writeFileSync(
			path.join(srcDir, "a.ts"),
			"const a = 1;\r\nconst b = 2;\r\n",
		);
		const project = initializeProject(tsconfigPath);
		const result = searchText(project, { query: "const b" });
		expect(result.matches[0]).toMatchObject({
			line: 2,
			column: 1,
			text: "const b = 2;",
		});
	});
});
