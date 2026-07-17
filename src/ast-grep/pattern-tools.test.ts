import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project";
import { rewritePattern, searchPattern } from "./pattern-tools";

describe("pattern tools (ast-grep)", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let srcDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsurgeon-astgrep-"));
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: { strict: true, jsx: "preserve" },
				include: ["src/**/*"],
			}),
		);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("searchPattern", () => {
		it("finds structural matches with positions, ignoring formatting", async () => {
			fs.writeFileSync(
				path.join(srcDir, "a.ts"),
				'console.log("x");\nconsole.log(\n  1,\n  2,\n);\nconsole.error("not this");\n',
			);
			fs.writeFileSync(
				path.join(srcDir, "b.tsx"),
				"export const C = () => <div>{console.log('jsx')}</div>;\n",
			);

			const project = initializeProject(tsconfigPath);
			const result = await searchPattern(project, {
				pattern: "console.log($$$ARGS)",
			});

			expect(result.totalCount).toBe(3);
			expect(result.truncated).toBe(false);
			const byFile = result.matches.map((m) => path.basename(m.filePath));
			expect(byFile).toContain("a.ts");
			expect(byFile).toContain("b.tsx");
			// the multi-line call matched despite formatting
			expect(result.matches.some((m) => m.text.includes("1"))).toBe(true);
			// 1-based positions
			expect(result.matches[0].line).toBeGreaterThanOrEqual(1);
			expect(result.matches[0].column).toBeGreaterThanOrEqual(1);
		});

		it("respects filePaths and maxResults", async () => {
			const aPath = path.join(srcDir, "a.ts");
			fs.writeFileSync(aPath, "foo(1);\nfoo(2);\nfoo(3);\n");
			fs.writeFileSync(path.join(srcDir, "b.ts"), "foo(4);\n");

			const project = initializeProject(tsconfigPath);
			const result = await searchPattern(project, {
				pattern: "foo($A)",
				filePaths: [aPath],
				maxResults: 2,
			});

			expect(result.totalCount).toBe(3);
			expect(result.matches).toHaveLength(2);
			expect(result.truncated).toBe(true);
		});
	});

	describe("rewritePattern", () => {
		it("rewrites matches with single and multi metavariables", async () => {
			const filePath = path.join(srcDir, "log.ts");
			fs.writeFileSync(
				filePath,
				'console.log("a", 1);\nconsole.log(b);\nconsole.error("keep");\n',
			);

			const project = initializeProject(tsconfigPath);
			const result = await rewritePattern(project, {
				pattern: "console.log($$$ARGS)",
				rewrite: "logger.debug($$$ARGS)",
			});

			expect(result.matchCount).toBe(2);
			expect(result.changedFiles).toEqual([filePath]);
			const updated = fs.readFileSync(filePath, "utf-8");
			expect(updated).toContain('logger.debug("a", 1);');
			expect(updated).toContain("logger.debug(b);");
			expect(updated).toContain('console.error("keep");');
		});

		it("substitutes single captures", async () => {
			const filePath = path.join(srcDir, "assert.ts");
			fs.writeFileSync(
				filePath,
				"assert.equal(actual, expected);\nassert.equal(x, y);\n",
			);

			const project = initializeProject(tsconfigPath);
			await rewritePattern(project, {
				pattern: "assert.equal($A, $B)",
				rewrite: "expect($A).toBe($B)",
			});

			const updated = fs.readFileSync(filePath, "utf-8");
			expect(updated).toContain("expect(actual).toBe(expected);");
			expect(updated).toContain("expect(x).toBe(y);");
		});

		it("dryRun reports matches without writing", async () => {
			const filePath = path.join(srcDir, "dry.ts");
			const original = "console.log(1);\n";
			fs.writeFileSync(filePath, original);

			const project = initializeProject(tsconfigPath);
			const result = await rewritePattern(project, {
				pattern: "console.log($$$A)",
				rewrite: "noop($$$A)",
				dryRun: true,
			});

			expect(result.matchCount).toBe(1);
			expect(result.changedFiles).toEqual([filePath]);
			expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
		});
	});
});
