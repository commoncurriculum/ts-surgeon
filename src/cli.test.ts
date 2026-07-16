import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callToolOnce, describeToolText, listToolsText, runCli } from "./cli";

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
			expect(text).toContain("rename_symbol_by_tsmorph");
			expect(text).toContain("get_diagnostics_by_tsmorph");
			expect(text).toContain("safe_delete_symbol_by_tsmorph");
			// Summary line, not the full multi-section description
			expect(text).not.toContain("## When to use");
		});
	});

	describe("describeToolText", () => {
		it("returns the full description and input schema", () => {
			const text = describeToolText("rename_symbol_by_tsmorph");
			expect(text).toContain("# rename_symbol_by_tsmorph");
			expect(text).toContain("## Input schema (JSON)");
			expect(text).toContain('"tsconfigPath"');
			expect(text).toContain('"newName"');
		});

		it("rejects an unknown tool and lists the valid names", () => {
			expect(() => describeToolText("no_such_tool")).toThrow(
				/Unknown tool 'no_such_tool'[\s\S]*rename_symbol_by_tsmorph/,
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

			const outcome = await callToolOnce("rename_symbol_by_tsmorph", {
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
			const outcome = await callToolOnce("rename_symbol_by_tsmorph", {
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
					"get_diagnostics_by_tsmorph",
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
					"rename_symbol_by_tsmorph",
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
				["call", "get_diagnostics_by_tsmorph", "--params-file", paramsPath],
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
					"rename_symbol_by_tsmorph",
					"--params",
					JSON.stringify({ tsconfigPath: 42 }),
				],
				createCapture(),
				err,
			);
			expect(code).toBe(2);
			expect(err.text).toContain(
				"Invalid parameters for 'rename_symbol_by_tsmorph'",
			);
			expect(err.text).toContain("tsconfigPath");
		});

		it("exits 2 on malformed --params JSON", async () => {
			const err = createCapture();
			const code = await runCli(
				["call", "get_diagnostics_by_tsmorph", "--params", "{not json"],
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
	});
});
