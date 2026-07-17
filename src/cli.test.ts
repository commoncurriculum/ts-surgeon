import { spawnSync } from "node:child_process";
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

		it("doctor reports a healthy install and exits 0", async () => {
			const out = createCapture();
			const code = await runCli(["doctor"], out, createCapture(), {
				cwd: tempDir,
			});
			expect(code).toBe(0);
			expect(out.text).toContain("ts-surgeon version:");
			expect(out.text).toContain(`Node: ${process.version}`);
			expect(out.text).toMatch(/Registered tools: \d+/);
			expect(out.text).toContain(`Resolved tsconfig: ${tsconfigPath}`);
			expect(out.text).toContain("ast-grep native binary: ok");
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

		it("keeps digit-looking flag values as strings when the schema expects a string", async () => {
			const filePath = path.join(srcDir, "digits.ts");
			fs.writeFileSync(filePath, "export const a = 1;\n");
			const err = createCapture();
			const out = createCapture();

			const code = await runCli(
				[
					"call",
					"find_references",
					"--tsconfig-path",
					tsconfigPath,
					"--target-file-path",
					filePath,
					"--symbol-name",
					"42",
				],
				out,
				err,
			);

			// schema-aware conversion: '42' reaches the tool as a string, so we
			// get the tool's not-found error rather than a zod type error
			expect(code).toBe(1);
			expect(out.text).toContain("No declaration named '42'");
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

		it("batch chains mutating ops through the shared project", async () => {
			const filePath = path.join(srcDir, "chain.ts");
			fs.writeFileSync(filePath, "export function alpha() {}\nalpha();\n");
			const out = createCapture();

			// op2 renames the symbol op1 just created — only works if op2 sees op1's result
			const code = await runCli(
				[
					"batch",
					"--params",
					JSON.stringify([
						{
							tool: "rename_symbol",
							params: {
								tsconfigPath,
								targetFilePath: filePath,
								symbolName: "alpha",
								newName: "beta",
							},
						},
						{
							tool: "rename_symbol",
							params: {
								tsconfigPath,
								targetFilePath: filePath,
								symbolName: "beta",
								newName: "gamma",
							},
						},
					]),
				],
				out,
				createCapture(),
			);

			expect(code).toBe(0);
			const content = fs.readFileSync(filePath, "utf-8");
			expect(content).toContain("gamma");
			expect(content).not.toContain("alpha");
		});

		it("batch does not leak dry-run mutations into later ops", async () => {
			const filePath = path.join(srcDir, "leak.ts");
			fs.writeFileSync(filePath, "export function keepMe() {}\nkeepMe();\n");
			const out = createCapture();

			// If op1's unsaved dry-run rename leaked, op2 could not find 'keepMe'.
			const code = await runCli(
				[
					"batch",
					"--params",
					JSON.stringify([
						{
							tool: "rename_symbol",
							params: {
								tsconfigPath,
								targetFilePath: filePath,
								symbolName: "keepMe",
								newName: "renamed",
								dryRun: true,
							},
						},
						{
							tool: "find_references",
							params: {
								tsconfigPath,
								targetFilePath: filePath,
								symbolName: "keepMe",
							},
						},
					]),
				],
				out,
				createCapture(),
			);

			expect(code).toBe(0);
			expect(fs.readFileSync(filePath, "utf-8")).toContain("keepMe");
			const results = JSON.parse(out.text);
			expect(results[1].status).toBe("success");
		});

		it("call --stdin-files reads a file list, skipping non-source and missing paths", async () => {
			const usedPath = path.join(srcDir, "stdin-used.ts");
			const appPath = path.join(srcDir, "stdin-app.ts");
			fs.writeFileSync(
				usedPath,
				"export const used = 1;\nexport const dead = 2;\n",
			);
			fs.writeFileSync(
				appPath,
				'import { used, dead } from "./stdin-used";\nconsole.log(used);\n',
			);
			const out = createCapture();
			const err = createCapture();

			const code = await runCli(
				[
					"call",
					"organize_imports",
					"--stdin-files",
					"--tsconfig-path",
					tsconfigPath,
				],
				out,
				err,
				{
					readStdin: () =>
						`${appPath}\nREADME.md\n${path.join(srcDir, "missing.ts")}\n\n`,
				},
			);

			expect(err.text).toBe("");
			expect(code).toBe(0);
			expect(fs.readFileSync(appPath, "utf-8")).not.toContain("dead");
			// the unused-import owner still exports both consts — untouched
			expect(fs.readFileSync(usedPath, "utf-8")).toContain("dead");
		});

		it("call --stdin-files exits 2 when no usable files arrive", async () => {
			const err = createCapture();
			const code = await runCli(
				["call", "organize_imports", "--stdin-files"],
				createCapture(),
				err,
				{ readStdin: () => "README.md\ndocs/notes.txt\n" },
			);
			expect(code).toBe(2);
			expect(err.text).toContain("no existing TS/JS source files");
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

	describe("name-based targeting (no position)", () => {
		it("renames a symbol located by declaration name only", async () => {
			const utilsPath = path.join(srcDir, "named.ts");
			const mainPath = path.join(srcDir, "named-main.ts");
			fs.writeFileSync(
				utilsPath,
				"export function calculateSum(a: number, b: number): number {\n  return a + b;\n}\n",
			);
			fs.writeFileSync(
				mainPath,
				'import { calculateSum } from "./named";\nconsole.log(calculateSum(1, 2));\n',
			);

			const outcome = await callToolOnce("rename_symbol", {
				tsconfigPath,
				targetFilePath: utilsPath,
				symbolName: "calculateSum",
				newName: "addNumbers",
			});

			expect(outcome.isError).toBe(false);
			expect(fs.readFileSync(mainPath, "utf-8")).toContain("addNumbers(1, 2)");
		});

		it("finds references by symbolName only", async () => {
			const libPath = path.join(srcDir, "lib.ts");
			const appPath = path.join(srcDir, "app.ts");
			fs.writeFileSync(libPath, "export function helper() {}\n");
			fs.writeFileSync(appPath, 'import { helper } from "./lib";\nhelper();\n');

			const outcome = await callToolOnce("find_references", {
				tsconfigPath,
				targetFilePath: libPath,
				symbolName: "helper",
			});

			expect(outcome.isError).toBe(false);
			expect(outcome.text).toContain("app.ts");
		});

		it("changes a signature by functionName only", async () => {
			const fnPath = path.join(srcDir, "sig.ts");
			fs.writeFileSync(
				fnPath,
				'export function greet(name: string) { return name; }\ngreet("a");\n',
			);

			const outcome = await callToolOnce("change_signature", {
				tsconfigPath,
				targetFilePath: fnPath,
				functionName: "greet",
				changes: [
					{
						kind: "add",
						index: 0,
						name: "lang",
						typeText: "string",
						argumentForCallers: '"en"',
					},
				],
			});

			expect(outcome.isError).toBe(false);
			const updated = fs.readFileSync(fnPath, "utf-8");
			expect(updated).toContain("greet(lang: string, name: string)");
			expect(updated).toContain('greet("en", "a")');
		});

		it("reports candidate positions when the name is ambiguous", async () => {
			const dupPath = path.join(srcDir, "dup.ts");
			fs.writeFileSync(
				dupPath,
				"function x(a: number) { const x = a; return x; }\nx(1);\n",
			);

			const outcome = await callToolOnce("rename_symbol", {
				tsconfigPath,
				targetFilePath: dupPath,
				symbolName: "x",
				newName: "y",
			});

			expect(outcome.isError).toBe(true);
			expect(outcome.text).toContain("2 declarations");
			expect(outcome.text).toMatch(/dup\.ts:\d+:\d+/);
		});

		it("errors clearly when the name matches nothing", async () => {
			const filePath = path.join(srcDir, "none.ts");
			fs.writeFileSync(filePath, "export const a = 1;\n");

			const outcome = await callToolOnce("rename_symbol", {
				tsconfigPath,
				targetFilePath: filePath,
				symbolName: "missing",
				newName: "y",
			});

			expect(outcome.isError).toBe(true);
			expect(outcome.text).toContain("No declaration named 'missing'");
		});
	});

	describe("call --git-changed / --git-staged", () => {
		function git(...args: string[]): void {
			const result = spawnSync("git", args, {
				cwd: tempDir,
				encoding: "utf-8",
			});
			expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
		}

		function setUpRepo(): { mPath: string; appPath: string } {
			const mPath = path.join(srcDir, "m.ts");
			const appPath = path.join(srcDir, "app.ts");
			fs.writeFileSync(
				mPath,
				"export const used = 1;\nexport const dead = 2;\n",
			);
			fs.writeFileSync(
				appPath,
				'import { used } from "./m";\nconsole.log(used);\n',
			);
			fs.writeFileSync(path.join(tempDir, "notes.md"), "initial\n");
			git("init", "-q");
			git("config", "user.email", "test@example.com");
			git("config", "user.name", "test");
			git("add", ".");
			git("commit", "-qm", "init");
			return { mPath, appPath };
		}

		it("--git-changed scopes filePaths to the unstaged TS/JS changes", async () => {
			const { mPath, appPath } = setUpRepo();
			// app.ts gains an unused import; a non-source file changes too
			fs.writeFileSync(
				appPath,
				'import { used, dead } from "./m";\nconsole.log(used);\n',
			);
			fs.writeFileSync(path.join(tempDir, "notes.md"), "changed\n");

			const out = createCapture();
			const err = createCapture();
			const code = await runCli(
				[
					"call",
					"organize_imports",
					"--git-changed",
					"--tsconfig-path",
					tsconfigPath,
				],
				out,
				err,
				{ cwd: tempDir },
			);
			expect(err.text).toBe("");
			expect(code).toBe(0);

			expect(fs.readFileSync(appPath, "utf-8")).not.toContain("dead");
			// the unchanged file was not processed
			expect(fs.readFileSync(mPath, "utf-8")).toContain("dead");
		});

		it("--git-staged uses the staged diff", async () => {
			const { appPath } = setUpRepo();
			fs.writeFileSync(
				appPath,
				'import { used, dead } from "./m";\nconsole.log(used);\n',
			);
			git("add", "src/app.ts");

			const out = createCapture();
			const err = createCapture();
			const code = await runCli(
				[
					"call",
					"organize_imports",
					"--git-staged",
					"--tsconfig-path",
					tsconfigPath,
				],
				out,
				err,
				{ cwd: tempDir },
			);
			expect(err.text).toBe("");
			expect(code).toBe(0);

			expect(fs.readFileSync(appPath, "utf-8")).not.toContain("dead");
		});

		it("exits 2 when the diff lists no TS/JS source files", async () => {
			setUpRepo();
			fs.writeFileSync(path.join(tempDir, "notes.md"), "changed\n");

			const err = createCapture();
			const code = await runCli(
				["call", "organize_imports", "--git-changed"],
				createCapture(),
				err,
				{ cwd: tempDir },
			);
			expect(code).toBe(2);
			expect(err.text).toContain("no existing TS/JS source files");
		});

		it("exits 2 outside a git repository", async () => {
			// tempDir has no git repo unless setUpRepo() ran
			const err = createCapture();
			const code = await runCli(
				["call", "organize_imports", "--git-changed"],
				createCapture(),
				err,
				{ cwd: tempDir },
			);
			expect(code).toBe(2);
			expect(err.text).toContain("not inside a git repository");
		});

		it("exits 2 when combined with another file-list flag", async () => {
			const err = createCapture();
			const code = await runCli(
				["call", "organize_imports", "--git-changed", "--git-staged"],
				createCapture(),
				err,
			);
			expect(code).toBe(2);
			expect(err.text).toContain("at most one of");
		});
	});

	describe("init", () => {
		it("creates the instructions file with the snippet and is idempotent", async () => {
			const agentsPath = path.join(tempDir, "AGENTS.md");
			const out1 = createCapture();
			expect(
				await runCli(["init", "--file", agentsPath], out1, createCapture()),
			).toBe(0);
			const content = fs.readFileSync(agentsPath, "utf-8");
			expect(content).toContain("ts-surgeon guide");
			expect(out1.text).toContain("Added the ts-surgeon section");

			const out2 = createCapture();
			expect(
				await runCli(["init", "--file", agentsPath], out2, createCapture()),
			).toBe(0);
			expect(out2.text).toContain("nothing to do");
			expect(fs.readFileSync(agentsPath, "utf-8")).toBe(content);
		});

		it("appends to an existing file passed via --file", async () => {
			const claudePath = path.join(tempDir, "CLAUDE.md");
			fs.writeFileSync(claudePath, "# My project\n");
			expect(
				await runCli(
					["init", "--file", claudePath],
					createCapture(),
					createCapture(),
				),
			).toBe(0);
			const content = fs.readFileSync(claudePath, "utf-8");
			expect(content).toContain("# My project");
			expect(content).toContain("## Refactoring (ts-surgeon)");
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
