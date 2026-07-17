import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createToolRegistry, type ToolRegistry } from "./registry";

/**
 * Creates a temporary directory for tests
 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tsmorph-integration-test-"));
}

/**
 * Recursively removes a directory
 */
function removeTempDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("Tool registry integration tests", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let srcDir: string;
	let registry: ToolRegistry;

	beforeEach(() => {
		tempDir = createTempDir();
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });

		// Create tsconfig.json
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify(
				{
					compilerOptions: {
						rootDir: "./src",
						outDir: "./dist",
						module: "commonjs",
						target: "es2020",
						strict: true,
						baseUrl: ".",
						paths: {
							"@/*": ["src/*"],
						},
					},
					include: ["src/**/*"],
				},
				null,
				2,
			),
		);

		// The real registry, exactly as the CLI drives it (schema validation included)
		registry = createToolRegistry();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	describe("rename_symbol", () => {
		it("symbol renaming works correctly", async () => {
			const utilsPath = path.join(srcDir, "utils.ts");
			const mainPath = path.join(srcDir, "main.ts");

			fs.writeFileSync(
				utilsPath,
				`export function calculateSum(a: number, b: number): number {
  return a + b;
}

export const VERSION = "1.0.0";
`,
			);

			fs.writeFileSync(
				mainPath,
				`import { calculateSum, VERSION } from "./utils";

const result = calculateSum(10, 20);
console.log(result);
console.log(VERSION);
`,
			);

			// Call rename_symbol tool
			await registry.call("rename_symbol", {
				tsconfigPath,
				targetFilePath: utilsPath,
				position: { line: 1, column: 17 }, // position of "calculateSum"
				symbolName: "calculateSum",
				newName: "addNumbers",
				dryRun: false,
			});

			// Verify that the files have been updated
			const updatedUtilsContent = fs.readFileSync(utilsPath, "utf-8");
			const updatedMainContent = fs.readFileSync(mainPath, "utf-8");

			expect(updatedUtilsContent).toContain("function addNumbers");
			expect(updatedMainContent).toContain("import { addNumbers");
			expect(updatedMainContent).toContain("addNumbers(10, 20)");
		});

		it("can preview changes in dryRun mode", async () => {
			const filePath = path.join(srcDir, "test.ts");

			fs.writeFileSync(
				filePath,
				`const oldName = "test";
console.log(oldName);
`,
			);

			// Run in dryRun mode
			await registry.call("rename_symbol", {
				tsconfigPath,
				targetFilePath: filePath,
				position: { line: 1, column: 7 }, // position of "oldName"
				symbolName: "oldName",
				newName: "newName",
				dryRun: true,
			});

			// Verify that the file has not been changed
			const content = fs.readFileSync(filePath, "utf-8");
			expect(content).toContain("oldName");
			expect(content).not.toContain("newName");
		});
	});

	describe("find_references", () => {
		it("can find references to a symbol", async () => {
			const libPath = path.join(srcDir, "lib.ts");
			const app1Path = path.join(srcDir, "app1.ts");
			const app2Path = path.join(srcDir, "app2.ts");

			fs.writeFileSync(
				libPath,
				`export class Logger {
  log(message: string) {
    console.log(message);
  }
}

export const logger = new Logger();
`,
			);

			fs.writeFileSync(
				app1Path,
				`import { Logger } from "./lib";

const myLogger = new Logger();
myLogger.log("Hello from app1");
`,
			);

			fs.writeFileSync(
				app2Path,
				`import { logger } from "./lib";

logger.log("Hello from app2");
`,
			);

			// Call find_references tool
			const result = await registry.call("find_references", {
				tsconfigPath,
				targetFilePath: libPath,
				position: { line: 1, column: 14 }, // position of "Logger" class
			});

			expect(result).toBeDefined();
			// Verify the result structure (adjust according to the actual implementation)
			expect(result).toHaveProperty("content");
			const content = result.content[0]?.text || "";
			expect(content.toLowerCase()).toContain("reference");
		});
	});

	describe("remove_path_alias", () => {
		it("can convert path aliases to relative paths", async () => {
			const utilsPath = path.join(srcDir, "utils", "math.ts");
			const appPath = path.join(srcDir, "app.ts");

			fs.mkdirSync(path.dirname(utilsPath), { recursive: true });

			fs.writeFileSync(
				utilsPath,
				`export function multiply(a: number, b: number): number {
  return a * b;
}
`,
			);

			fs.writeFileSync(
				appPath,
				`import { multiply } from "@/utils/math";

console.log(multiply(3, 4));
`,
			);

			// Call remove_path_alias tool
			await registry.call("remove_path_alias", {
				tsconfigPath,
				targetPath: appPath,
				dryRun: false,
			});

			// Verify that the path alias has been converted to a relative path
			const updatedContent = fs.readFileSync(appPath, "utf-8");
			expect(updatedContent).toContain('from "./utils/math"');
			expect(updatedContent).not.toContain('from "@/utils/math"');
		});
	});

	describe("rename_filesystem_entry", () => {
		it("can rename a file and update imports", async () => {
			const oldPath = path.join(srcDir, "old-name.ts");
			const newPath = path.join(srcDir, "new-name.ts");
			const importerPath = path.join(srcDir, "importer.ts");

			fs.writeFileSync(oldPath, "export const data = { value: 42 };");

			fs.writeFileSync(
				importerPath,
				`import { data } from "./old-name";

console.log(data.value);
`,
			);

			// Call rename_filesystem_entry tool
			await registry.call("rename_filesystem_entry", {
				tsconfigPath,
				renames: [{ oldPath, newPath }],
				dryRun: false,
			});

			// Verify that the file has been renamed
			expect(fs.existsSync(newPath)).toBe(true);
			expect(fs.existsSync(oldPath)).toBe(false);

			// Verify that the import has been updated
			const updatedImporterContent = fs.readFileSync(importerPath, "utf-8");
			expect(updatedImporterContent).toContain('from "./new-name"');
		});
	});

	describe("move_symbol_to_file", () => {
		it("can move a symbol to another file", async () => {
			const sourcePath = path.join(srcDir, "source.ts");
			const targetPath = path.join(srcDir, "target.ts");
			const consumerPath = path.join(srcDir, "consumer.ts");

			fs.writeFileSync(
				sourcePath,
				`export function funcToMove() {
  return "moved";
}

export function funcToStay() {
  return "stayed";
}
`,
			);

			fs.writeFileSync(
				consumerPath,
				`import { funcToMove, funcToStay } from "./source";

console.log(funcToMove());
console.log(funcToStay());
`,
			);

			// Call move_symbol_to_file tool
			await registry.call("move_symbol_to_file", {
				tsconfigPath,
				originalFilePath: sourcePath, // originalFilePath, not sourceFilePath
				targetFilePath: targetPath,
				symbolToMove: "funcToMove", // symbolToMove, not symbolName
				declarationKindString: "FunctionDeclaration",
				dryRun: false,
			});

			// Verify that the target file has been created and the symbol has been moved
			expect(fs.existsSync(targetPath)).toBe(true);
			const targetContent = fs.readFileSync(targetPath, "utf-8");
			expect(targetContent).toContain("function funcToMove");

			// Verify that the symbol has been removed from the source file
			const sourceContent = fs.readFileSync(sourcePath, "utf-8");
			expect(sourceContent).not.toContain("function funcToMove");
			expect(sourceContent).toContain("function funcToStay");

			// Verify that the consumer's import has been updated
			const consumerContent = fs.readFileSync(consumerPath, "utf-8");
			expect(consumerContent).toContain('from "./target"');
			expect(consumerContent).toContain('from "./source"');
		});
	});

	describe("change_signature", () => {
		it("adds a required parameter at the beginning and updates callers", async () => {
			const utilsPath = path.join(srcDir, "utils.ts");
			const consumerPath = path.join(srcDir, "consumer.ts");

			fs.writeFileSync(
				utilsPath,
				`export function greet(name: string): string {
  return "hello " + name;
}
`,
			);
			fs.writeFileSync(
				consumerPath,
				`import { greet } from "./utils";

console.log(greet("world"));
console.log(greet("there"));
`,
			);

			const result = await registry.call("change_signature", {
				tsconfigPath,
				targetFilePath: utilsPath,
				position: { line: 1, column: 17 }, // position of "greet"
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
				dryRun: false,
			});

			expect(result).toHaveProperty("isError", false);
			const updatedUtils = fs.readFileSync(utilsPath, "utf-8");
			const updatedConsumer = fs.readFileSync(consumerPath, "utf-8");

			expect(updatedUtils).toContain(
				"function greet(lang: string, name: string)",
			);
			expect(updatedConsumer).toContain('greet("en", "world")');
			expect(updatedConsumer).toContain('greet("en", "there")');
		});

		it("does not modify files in dryRun mode", async () => {
			const filePath = path.join(srcDir, "fn.ts");
			fs.writeFileSync(
				filePath,
				`export function foo(a: number) { return a; }
foo(1);
`,
			);

			const result = await registry.call("change_signature", {
				tsconfigPath,
				targetFilePath: filePath,
				position: { line: 1, column: 17 },
				functionName: "foo",
				changes: [{ kind: "remove", index: 0 }],
				dryRun: true,
			});

			expect(result).toHaveProperty("isError", false);
			const content = fs.readFileSync(filePath, "utf-8");
			expect(content).toContain("function foo(a: number)");
			expect(content).toContain("foo(1);");
		});
	});

	describe("get_type_at_position", () => {
		it("can retrieve type information for a variable", async () => {
			const filePath = path.join(srcDir, "types.ts");
			fs.writeFileSync(
				filePath,
				`const user = { id: "u1", name: "alice" };
console.log(user);
`,
			);

			const result = await registry.call("get_type_at_position", {
				tsconfigPath,
				targetFilePath: filePath,
				position: { line: 2, column: 13 }, // "user" inside console.log
			});

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("Type:");
			expect(text).toContain("id: string");
			expect(text).toContain("name: string");
			expect(text).toContain("Symbol: user (VariableDeclaration)");
			expect(text).toContain(`Declared at: ${filePath}:1:`);
		});

		it("expands a function signature in call style", async () => {
			const filePath = path.join(srcDir, "fn.ts");
			fs.writeFileSync(
				filePath,
				`function greet(name: string): string {
  return "hello " + name;
}
greet("world");
`,
			);

			const result = await registry.call("get_type_at_position", {
				tsconfigPath,
				targetFilePath: filePath,
				position: { line: 4, column: 1 },
			});

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("(name: string) => string");
		});

		it("declaration location of an imported symbol points to the original file", async () => {
			const libPath = path.join(srcDir, "lib.ts");
			const appPath = path.join(srcDir, "app.ts");
			fs.writeFileSync(
				libPath,
				`export function helper(n: number): string { return String(n); }
`,
			);
			fs.writeFileSync(
				appPath,
				`import { helper } from "./lib";
helper(1);
`,
			);

			const result = await registry.call("get_type_at_position", {
				tsconfigPath,
				targetFilePath: appPath,
				position: { line: 2, column: 1 },
			});

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("Symbol: helper");
			expect(text).toContain(`Declared at: ${libPath}:1:`);
		});

		it("returns an error for an out-of-range position", async () => {
			const filePath = path.join(srcDir, "small.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			const result = await registry.call("get_type_at_position", {
				tsconfigPath,
				targetFilePath: filePath,
				position: { line: 99, column: 1 },
			});

			expect(result).toHaveProperty("isError", true);
			expect(result.content[0]?.text).toContain("Error");
		});
	});

	describe("find_unused_exports", () => {
		it("lists exports not imported from anywhere as candidates", async () => {
			const aPath = path.join(srcDir, "a.ts");
			const bPath = path.join(srcDir, "b.ts");
			fs.writeFileSync(
				aPath,
				`export function used(): void {}
export function unused(): void {}
`,
			);
			fs.writeFileSync(
				bPath,
				`import { used } from "./a";
used();
`,
			);

			const result = await registry.call("find_unused_exports", {
				tsconfigPath,
			});

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("Unused export candidates");
			expect(text).toContain("unused (FunctionDeclaration)");
			expect(text).not.toContain(" used (");
			// Output lines include textHits / sameFileRefs (for deciding delete vs unexport)
			expect(text).toMatch(/unused \(FunctionDeclaration\).*sameFileRefs=0/);
			expect(text).toContain("textHits=");
		});

		it("explicitly reports when there are zero candidates", async () => {
			const aPath = path.join(srcDir, "a.ts");
			const bPath = path.join(srcDir, "b.ts");
			fs.writeFileSync(aPath, "export function used(): void {}\n");
			fs.writeFileSync(bPath, 'import { used } from "./a";\nused();\n');

			const result = await registry.call("find_unused_exports", {
				tsconfigPath,
			});

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("No unused exports found");
		});

		it("responseFormat=summary returns aggregated results without listing each line", async () => {
			const aPath = path.join(srcDir, "a.ts");
			const bPath = path.join(srcDir, "b.ts");
			fs.writeFileSync(
				aPath,
				`export type DeadType = string;
export function onlyLocal(): number { return 1; }
const u = onlyLocal();
console.log(u);
`,
			);
			fs.writeFileSync(bPath, "const x = 1;\n");

			const result = await registry.call("find_unused_exports", {
				tsconfigPath,
				responseFormat: "summary",
			});

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("Unused export summary");
			// Deletion-safety breakdown: DeadType=deletable(0), onlyLocal=unexport-only(1)
			expect(text).toContain("deletable (sameFileRefs=0) = 1");
			expect(text).toContain("unexport-only (sameFileRefs>=1) = 1");
			expect(text).toContain("By kind:");
			// Per-line candidate listing (file:line:column format) is not included
			expect(text).not.toMatch(/:\d+:\d+ {2}DeadType/);
		});

		it("exports from entryPoints are excluded from candidates", async () => {
			const publicPath = path.join(srcDir, "public.ts");
			const internalPath = path.join(srcDir, "internal.ts");
			fs.writeFileSync(publicPath, "export function publicFn(): void {}\n");
			fs.writeFileSync(internalPath, "export function internalFn(): void {}\n");

			const result = await registry.call("find_unused_exports", {
				tsconfigPath,
				entryPoints: [publicPath],
			});

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("internalFn");
			expect(text).not.toContain("publicFn");
		});
	});

	describe("convert_default_export_to_named", () => {
		it("converts a named default export and updates importers", async () => {
			const buttonPath = path.join(srcDir, "button.ts");
			const appPath = path.join(srcDir, "app.ts");

			fs.writeFileSync(
				buttonPath,
				`export default function Button() {
  return "button";
}
`,
			);
			fs.writeFileSync(
				appPath,
				`import Btn from "./button";

console.log(Btn());
`,
			);

			const result = await registry.call("convert_default_export_to_named", {
				tsconfigPath,
				targetFilePath: buttonPath,
				dryRun: false,
			});

			expect(result).toHaveProperty("isError", false);
			const updatedButton = fs.readFileSync(buttonPath, "utf-8");
			const updatedApp = fs.readFileSync(appPath, "utf-8");

			expect(updatedButton).toContain("export function Button()");
			expect(updatedButton).not.toContain("export default");
			expect(updatedApp).toContain('import { Button as Btn } from "./button"');
		});

		it("converts an anonymous default export using newName", async () => {
			const fnPath = path.join(srcDir, "fn.ts");
			fs.writeFileSync(fnPath, "export default () => 1;\n");

			const result = await registry.call("convert_default_export_to_named", {
				tsconfigPath,
				targetFilePath: fnPath,
				newName: "run",
				dryRun: false,
			});

			expect(result).toHaveProperty("isError", false);
			expect(fs.readFileSync(fnPath, "utf-8")).toContain(
				"export const run = () => 1;",
			);
		});

		it("does not modify files in dryRun mode", async () => {
			const widgetPath = path.join(srcDir, "widget.ts");
			fs.writeFileSync(widgetPath, "export default class Widget {}\n");

			const result = await registry.call("convert_default_export_to_named", {
				tsconfigPath,
				targetFilePath: widgetPath,
				dryRun: true,
			});

			expect(result).toHaveProperty("isError", false);
			expect(fs.readFileSync(widgetPath, "utf-8")).toContain(
				"export default class Widget {}",
			);
		});

		it("returns an error for an anonymous default export without newName", async () => {
			const fnPath = path.join(srcDir, "anon.ts");
			fs.writeFileSync(fnPath, "export default () => 1;\n");

			const result = await registry.call("convert_default_export_to_named", {
				tsconfigPath,
				targetFilePath: fnPath,
				dryRun: false,
			});

			expect(result).toHaveProperty("isError", true);
			expect(result.content[0]?.text || "").toContain("anonymous");
		});
	});

	describe("organize_imports", () => {
		it("removes unused imports from a specified file", async () => {
			const mPath = path.join(srcDir, "m.ts");
			const appPath = path.join(srcDir, "app.ts");
			fs.writeFileSync(
				mPath,
				"export const used = 1;\nexport const dead = 2;\n",
			);
			fs.writeFileSync(
				appPath,
				'import { used, dead } from "./m";\n\nconsole.log(used);\n',
			);

			const result = await registry.call("organize_imports", {
				tsconfigPath,
				filePaths: [appPath],
				dryRun: false,
			});

			expect(result).toHaveProperty("isError", false);
			const updated = fs.readFileSync(appPath, "utf-8");
			expect(updated).toContain('import { used } from "./m"');
			expect(updated).not.toContain("dead");
		});

		it("does not modify files in dryRun mode", async () => {
			const mPath = path.join(srcDir, "m2.ts");
			const appPath = path.join(srcDir, "app2.ts");
			fs.writeFileSync(
				mPath,
				"export const used = 1;\nexport const dead = 2;\n",
			);
			fs.writeFileSync(
				appPath,
				'import { used, dead } from "./m2";\nconsole.log(used);\n',
			);

			const result = await registry.call("organize_imports", {
				tsconfigPath,
				filePaths: [appPath],
				dryRun: true,
			});

			expect(result).toHaveProperty("isError", false);
			expect(fs.readFileSync(appPath, "utf-8")).toContain("dead");
		});
	});

	describe("get_diagnostics", () => {
		it("reports a type error for the project", async () => {
			const badPath = path.join(srcDir, "bad.ts");
			fs.writeFileSync(badPath, "const x: number = 'oops';\n");

			const result = await registry.call("get_diagnostics", {
				tsconfigPath,
			});

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("TS2322");
			expect(text).toContain("bad.ts");
		});

		it("reports no diagnostics for a clean file", async () => {
			const goodPath = path.join(srcDir, "good.ts");
			fs.writeFileSync(goodPath, "export const y: number = 1;\n");

			const result = await registry.call("get_diagnostics", {
				tsconfigPath,
				filePaths: [goodPath],
			});

			expect(result).toHaveProperty("isError", false);
			expect(result.content[0]?.text || "").toContain("No diagnostics");
		});
	});

	describe("convert_named_export_to_default", () => {
		it("converts a named export and updates importers", async () => {
			const buttonPath = path.join(srcDir, "button.ts");
			const appPath = path.join(srcDir, "app.ts");
			fs.writeFileSync(
				buttonPath,
				"export function Button() {\n  return 1;\n}\n",
			);
			fs.writeFileSync(
				appPath,
				'import { Button } from "./button";\n\nconsole.log(Button());\n',
			);

			const result = await registry.call("convert_named_export_to_default", {
				tsconfigPath,
				targetFilePath: buttonPath,
				exportName: "Button",
				dryRun: false,
			});

			expect(result).toHaveProperty("isError", false);
			expect(fs.readFileSync(buttonPath, "utf-8")).toContain(
				"export default function Button()",
			);
			expect(fs.readFileSync(appPath, "utf-8")).toContain(
				'import Button from "./button"',
			);
		});

		it("returns an error when the file already has a default export", async () => {
			const filePath = path.join(srcDir, "dup.ts");
			fs.writeFileSync(
				filePath,
				"export default function A() {}\nexport function B() {}\n",
			);

			const result = await registry.call("convert_named_export_to_default", {
				tsconfigPath,
				targetFilePath: filePath,
				exportName: "B",
			});

			expect(result).toHaveProperty("isError", true);
			expect(result.content[0]?.text || "").toContain(
				"already has a default export",
			);
		});
	});

	describe("add_missing_imports", () => {
		it("adds an import for an unresolved identifier", async () => {
			const buttonPath = path.join(srcDir, "button.ts");
			const appPath = path.join(srcDir, "app.ts");
			fs.writeFileSync(buttonPath, "export function Button() {}\n");
			fs.writeFileSync(appPath, "Button();\n");

			const result = await registry.call("add_missing_imports", {
				tsconfigPath,
				filePaths: [appPath],
				dryRun: false,
			});

			expect(result).toHaveProperty("isError", false);
			expect(fs.readFileSync(appPath, "utf-8")).toContain(
				'import { Button } from "./button"',
			);
		});

		it("does not modify files in dryRun mode", async () => {
			const buttonPath = path.join(srcDir, "button2.ts");
			const appPath = path.join(srcDir, "app2.ts");
			fs.writeFileSync(buttonPath, "export function Widget() {}\n");
			fs.writeFileSync(appPath, "Widget();\n");

			const result = await registry.call("add_missing_imports", {
				tsconfigPath,
				filePaths: [appPath],
				dryRun: true,
			});

			expect(result).toHaveProperty("isError", false);
			expect(fs.readFileSync(appPath, "utf-8")).not.toContain("import");
		});
	});

	describe("apply_code_fix", () => {
		it("removes unused declarations and imports", async () => {
			const mPath = path.join(srcDir, "m.ts");
			const appPath = path.join(srcDir, "app.ts");
			fs.writeFileSync(
				mPath,
				"export const used = 1;\nexport const dead = 2;\n",
			);
			fs.writeFileSync(
				appPath,
				'import { used, dead } from "./m";\nconsole.log(used);\n',
			);

			const result = await registry.call("apply_code_fix", {
				tsconfigPath,
				fix: "remove_unused",
				filePaths: [appPath],
				dryRun: false,
			});

			expect(result).toHaveProperty("isError", false);
			const text = fs.readFileSync(appPath, "utf-8");
			expect(text).toContain("used");
			expect(text).not.toContain("dead");
		});

		it("stubs out missing interface members", async () => {
			const cPath = path.join(srcDir, "c.ts");
			fs.writeFileSync(
				cPath,
				"interface I {\n  foo(): number;\n}\nclass C implements I {}\n",
			);

			const result = await registry.call("apply_code_fix", {
				tsconfigPath,
				fix: "implement_interface",
				filePaths: [cPath],
				dryRun: false,
			});

			expect(result).toHaveProperty("isError", false);
			expect(fs.readFileSync(cPath, "utf-8")).toContain("foo(): number");
		});
	});

	describe("safe_delete_symbol", () => {
		it("deletes an unreferenced symbol", async () => {
			const filePath = path.join(srcDir, "util.ts");
			fs.writeFileSync(
				filePath,
				"export function used() {}\nfunction dead() {}\n",
			);

			const result = await registry.call("safe_delete_symbol", {
				tsconfigPath,
				targetFilePath: filePath,
				symbolName: "dead",
			});

			expect(result).toHaveProperty("isError", false);
			expect(result.content[0]?.text || "").toContain("Deleted 'dead'");
			expect(fs.readFileSync(filePath, "utf-8")).not.toContain("dead");
		});

		it("reports blockers and changes nothing when the symbol is referenced", async () => {
			const utilPath = path.join(srcDir, "util2.ts");
			const appPath = path.join(srcDir, "app.ts");
			fs.writeFileSync(utilPath, "export function helper() {}\n");
			fs.writeFileSync(
				appPath,
				'import { helper } from "./util2";\nhelper();\n',
			);

			const result = await registry.call("safe_delete_symbol", {
				tsconfigPath,
				targetFilePath: utilPath,
				symbolName: "helper",
			});

			expect(result).toHaveProperty("isError", false);
			expect(result.content[0]?.text || "").toContain("Not deleted");
			expect(fs.readFileSync(utilPath, "utf-8")).toContain("function helper");
		});
	});

	describe("error handling", () => {
		it("returns an error for a file that does not exist", async () => {
			const nonExistentPath = path.join(srcDir, "non-existent.ts");

			const result = await registry.call("rename_symbol", {
				tsconfigPath,
				targetFilePath: nonExistentPath,
				position: { line: 1, column: 1 },
				symbolName: "test",
				newName: "renamed",
				dryRun: false,
			});

			// The tool returns an error result but does not throw
			expect(result).toHaveProperty("isError", true);
			expect(result.content[0]?.text).toContain("Error");
		});

		it("returns an error for an invalid symbol name", async () => {
			const testPath = path.join(srcDir, "test.ts");

			fs.writeFileSync(testPath, `const validName = "test";`);

			const result = await registry.call("rename_symbol", {
				tsconfigPath,
				targetFilePath: testPath,
				position: { line: 1, column: 7 },
				symbolName: "wrongName", // differs from the actual symbol name
				newName: "renamed",
				dryRun: false,
			});

			// The tool returns an error result but does not throw
			expect(result).toHaveProperty("isError", true);
			expect(result.content[0]?.text).toContain("Error");
		});
	});
});
