import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	callToolOnce,
	describeToolText,
	findNearestTsconfig,
	listToolsText,
	prepareParams,
	resolvePathParams,
	runCli,
} from "./cli";

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tsmorph-cli-test-"));
}

function createCapture() {
	let buffer = "";
	return {
		write(chunk: string) {
			buffer += chunk;
			return true;
		},
		get text() {
			return buffer;
		},
	};
}

describe("CLI", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let srcDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: {
					rootDir: "./src",
					module: "commonjs",
					target: "es2020",
					strict: true,
				},
				include: ["src/**/*"],
			}),
		);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("listToolsText", () => {
		it("lists every registered tool with a one-line summary", () => {
			const text = listToolsText();
			expect(text).toContain("rename_symbol");
			expect(text).toContain("get_diagnostics");
			expect(text).toContain("safe_delete_symbol");
			// Summary line, not the full multi-section description
			expect(text).not.toContain("## When to use");
		});
	});

	describe("describeToolText", () => {
		it("returns the full description and input schema", () => {
			const text = describeToolText("rename_symbol");
			expect(text).toContain("# rename_symbol");
			expect(text).toContain("## Input schema (JSON)");
			expect(text).toContain('"tsconfigPath"');
			expect(text).toContain('"newName"');
		});

		it("rejects an unknown tool and lists the valid names", () => {
			expect(() => describeToolText("no_such_tool")).toThrow(
				/Unknown tool 'no_such_tool'[\s\S]*rename_symbol/,
			);
		});
	});

	describe("callToolOnce", () => {
		it("runs a real rename end to end", async () => {
			const utilsPath = path.join(srcDir, "utils.ts");
			const mainPath = path.join(srcDir, "main.ts");
			fs.writeFileSync(
				utilsPath,
				"export function calculateSum(a: number, b: number): number {\n  return a + b;\n}\n",
			);
			fs.writeFileSync(
				mainPath,
				'import { calculateSum } from "./utils";\nconsole.log(calculateSum(1, 2));\n',
			);

			const outcome = await callToolOnce("rename_symbol", {
				tsconfigPath,
				targetFilePath: utilsPath,
				position: { line: 1, column: 17 },
				symbolName: "calculateSum",
				newName: "addNumbers",
			});

			expect(outcome.isError).toBe(false);
			expect(outcome.text).toContain("Status: Success");
			expect(fs.readFileSync(utilsPath, "utf-8")).toContain(
				"function addNumbers",
			);
			expect(fs.readFileSync(mainPath, "utf-8")).toContain("addNumbers(1, 2)");
		});

		it("reports a tool failure as isError without throwing", async () => {
			const outcome = await callToolOnce("rename_symbol", {
				tsconfigPath,
				targetFilePath: path.join(srcDir, "missing.ts"),
				position: { line: 1, column: 1 },
				symbolName: "x",
				newName: "y",
			});
			expect(outcome.isError).toBe(true);
			expect(outcome.text).toContain("Error");
		});
	});

	describe("runCli", () => {
		it("call succeeds with --params and exits 0", async () => {
			const goodPath = path.join(srcDir, "good.ts");
			fs.writeFileSync(goodPath, "export const y: number = 1;\n");
			const out = createCapture();
			const err = createCapture();

			const code = await runCli(
				[
					"call",
					"get_diagnostics",
					"--params",
					JSON.stringify({ tsconfigPath, filePaths: [goodPath] }),
				],
				out,
				err,
			);

			expect(code).toBe(0);
			expect(out.text).toContain("No diagnostics");
		});

		it("call exits 1 when the tool reports an error", async () => {
			const out = createCapture();
			const err = createCapture();
			const code = await runCli(
				[
					"call",
					"rename_symbol",
					"--params",
					JSON.stringify({
						tsconfigPath,
						targetFilePath: path.join(srcDir, "missing.ts"),
						position: { line: 1, column: 1 },
						symbolName: "x",
						newName: "y",
					}),
				],
				out,
				err,
			);
			expect(code).toBe(1);
			expect(out.text).toContain("Status: Failure");
		});

		it("call reads params from a file", async () => {
			const goodPath = path.join(srcDir, "good.ts");
			fs.writeFileSync(goodPath, "export const y: number = 1;\n");
			const paramsPath = path.join(tempDir, "params.json");
			fs.writeFileSync(
				paramsPath,
				JSON.stringify({ tsconfigPath, filePaths: [goodPath] }),
			);
			const out = createCapture();

			const code = await runCli(
				["call", "get_diagnostics", "--params-file", paramsPath],
				out,
				createCapture(),
			);

			expect(code).toBe(0);
			expect(out.text).toContain("No diagnostics");
		});

		it("exits 2 on an unknown command", async () => {
			const err = createCapture();
			const code = await runCli(["frobnicate"], createCapture(), err);
			expect(code).toBe(2);
			expect(err.text).toContain("Unknown command");
		});

		it("exits 2 when params fail the tool's schema validation", async () => {
			const err = createCapture();
			const code = await runCli(
				[
					"call",
					"rename_symbol",
					"--params",
					JSON.stringify({ tsconfigPath: 42 }),
				],
				createCapture(),
				err,
			);
			expect(code).toBe(2);
			expect(err.text).toContain("Invalid parameters for 'rename_symbol'");
			expect(err.text).toContain("tsconfigPath");
		});

		it("exits 2 on malformed --params JSON", async () => {
			const err = createCapture();
			const code = await runCli(
				["call", "get_diagnostics", "--params", "{not json"],
				createCapture(),
				err,
			);
			expect(code).toBe(2);
			expect(err.text).toContain("Failed to parse --params");
		});

		it("prints usage for --help", async () => {
			const out = createCapture();
			const code = await runCli(["--help"], out, createCapture());
			expect(code).toBe(0);
			expect(out.text).toContain("Usage:");
			expect(out.text).toContain("call <tool>");
		});

		it("prints the agent guide", async () => {
			const out = createCapture();
			const code = await runCli(["guide"], out, createCapture());
			expect(code).toBe(0);
			expect(out.text).toContain("agent guide");
			expect(out.text).toContain("rename_symbol");
		});

		it("accepts dashed tool names and legacy *_by_tsmorph aliases", async () => {
			const goodPath = path.join(srcDir, "good.ts");
			fs.writeFileSync(goodPath, "export const y: number = 1;\n");
			for (const name of [
				"get-diagnostics",
				"get_diagnostics_by_tsmorph",
				"get-diagnostics-by-tsmorph",
			]) {
				const out = createCapture();
				const code = await runCli(
					[
						"call",
						name,
						"--params",
						JSON.stringify({ tsconfigPath, filePaths: [goodPath] }),
					],
					out,
					createCapture(),
				);
				expect(code).toBe(0);
				expect(out.text).toContain("No diagnostics");
			}
		});

		it("accepts individual --field flags with dot paths and dry-run", async () => {
			const filePath = path.join(srcDir, "flagged.ts");
			fs.writeFileSync(
				filePath,
				'const oldName = "x";\nconsole.log(oldName);\n',
			);
			const out = createCapture();
			const err = createCapture();

			const code = await runCli(
				[
					"call",
					"rename_symbol",
					"--tsconfig-path",
					tsconfigPath,
					"--target-file-path",
					filePath,
					"--position.line",
					"1",
					"--position.column",
					"7",
					"--symbol-name",
					"oldName",
					"--new-name",
					"newName",
					"--dry-run",
				],
				out,
				err,
			);

			expect(err.text).toBe("");
			expect(code).toBe(0);
			expect(out.text).toContain("Dry run complete");
			// dry run: file untouched
			expect(fs.readFileSync(filePath, "utf-8")).toContain("oldName");
		});

		it("emits structured output with --json", async () => {
			const filePath = path.join(srcDir, "jsonout.ts");
			fs.writeFileSync(filePath, 'const a = "x";\nconsole.log(a);\n');
			const out = createCapture();

			const code = await runCli(
				[
					"call",
					"rename_symbol",
					"--json",
					"--tsconfig-path",
					tsconfigPath,
					"--target-file-path",
					filePath,
					"--position.line",
					"1",
					"--position.column",
					"7",
					"--symbol-name",
					"a",
					"--new-name",
					"b",
				],
				out,
				createCapture(),
			);

			expect(code).toBe(0);
			const parsed = JSON.parse(out.text);
			expect(parsed.tool).toBe("rename_symbol");
			expect(parsed.status).toBe("success");
			expect(parsed.data.changedFiles).toContain(filePath);
		});

		it("list --json returns machine-readable tool summaries", async () => {
			const out = createCapture();
			const code = await runCli(["list", "--json"], out, createCapture());
			expect(code).toBe(0);
			const tools = JSON.parse(out.text);
			expect(tools.map((t: { name: string }) => t.name)).toContain(
				"rename_symbol",
			);
		});

		it("batch runs multiple tools and reports JSON results", async () => {
			const goodPath = path.join(srcDir, "batch.ts");
			fs.writeFileSync(goodPath, "export const y: number = 1;\n");
			const out = createCapture();

			const code = await runCli(
				[
					"batch",
					"--params",
					JSON.stringify([
						{
							tool: "get_diagnostics",
							params: { tsconfigPath, filePaths: [goodPath] },
						},
						{
							tool: "organize_imports",
							params: { tsconfigPath, filePaths: [goodPath], dryRun: true },
						},
					]),
				],
				out,
				createCapture(),
			);

			expect(code).toBe(0);
			const results = JSON.parse(out.text);
			expect(results).toHaveLength(2);
			expect(results[0].tool).toBe("get_diagnostics");
			expect(
				results.every((r: { status: string }) => r.status === "success"),
			).toBe(true);
		});

		it("batch stops at the first error by default and exits 1", async () => {
			const out = createCapture();
			const code = await runCli(
				[
					"batch",
					"--params",
					JSON.stringify([
						{
							tool: "rename_symbol",
							params: {
								tsconfigPath,
								targetFilePath: path.join(srcDir, "missing.ts"),
								position: { line: 1, column: 1 },
								symbolName: "x",
								newName: "y",
							},
						},
						{ tool: "get_diagnostics", params: { tsconfigPath } },
					]),
				],
				out,
				createCapture(),
			);

			expect(code).toBe(1);
			const results = JSON.parse(out.text);
			expect(results).toHaveLength(1);
			expect(results[0].status).toBe("error");
		});
	});

	describe("path preparation", () => {
		it("resolves relative paths against cwd, including nested renames", () => {
			const resolved = resolvePathParams(
				{
					tsconfigPath: "tsconfig.json",
					filePaths: ["src/a.ts", "/abs/b.ts"],
					renames: [{ oldPath: "src/old.ts", newPath: "src/new.ts" }],
					excludeFilePatterns: ["**/*.test.ts"],
					symbolName: "keep-me",
				},
				"/proj",
			) as Record<string, unknown>;

			expect(resolved.tsconfigPath).toBe("/proj/tsconfig.json");
			expect(resolved.filePaths).toEqual(["/proj/src/a.ts", "/abs/b.ts"]);
			expect(resolved.renames).toEqual([
				{ oldPath: "/proj/src/old.ts", newPath: "/proj/src/new.ts" },
			]);
			// glob patterns and non-path fields are untouched
			expect(resolved.excludeFilePatterns).toEqual(["**/*.test.ts"]);
			expect(resolved.symbolName).toBe("keep-me");
		});

		it("discovers the nearest tsconfig.json above the target file", () => {
			const nested = path.join(srcDir, "deep", "deeper");
			fs.mkdirSync(nested, { recursive: true });
			expect(findNearestTsconfig(nested)).toBe(tsconfigPath);

			const prepared = prepareParams(
				{ targetFilePath: path.join(nested, "x.ts") },
				tempDir,
			);
			expect(prepared.tsconfigPath).toBe(tsconfigPath);
		});

		it("call works end to end with relative paths and no tsconfigPath", async () => {
			const goodPath = path.join(srcDir, "auto.ts");
			fs.writeFileSync(goodPath, "export const y: number = 1;\n");
			// runCli resolves against process.cwd(), so pass paths relative to it
			const rel = path.relative(process.cwd(), goodPath);
			const out = createCapture();
			const err = createCapture();

			const code = await runCli(
				["call", "get_diagnostics", "--file-paths", JSON.stringify([rel])],
				out,
				err,
			);

			expect(err.text).toBe("");
			expect(code).toBe(0);
			expect(out.text).toContain("No diagnostics");
		});
	});
});
