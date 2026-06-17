import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerTsMorphTools } from "./ts-morph-tools";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Creates a temporary directory for tests
 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-integration-test-"));
}

/**
 * Recursively removes a directory
 */
function removeTempDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Type of tool result
 */
interface ToolResult {
	content: Array<{
		type: string;
		text: string;
	}>;
	isError?: boolean;
}

/**
 * Type of tool handler
 */
type ToolHandler<T = unknown> = (args: T) => Promise<ToolResult>;

/**
 * Mock MCP server
 */
interface MockServer {
	tool: <T>(
		name: string,
		description: string,
		schema: unknown,
		handler: (args: T) => Promise<unknown>,
	) => void;
	callTool: <T>(name: string, args: T) => Promise<ToolResult>;
}

/**
 * Creates a mock MCP server
 */
function createMockServer(): MockServer {
	const tools = new Map<string, { handler: ToolHandler<unknown> }>();

	return {
		tool: <T>(
			name: string,
			_description: string,
			_schema: unknown, // z.ZodSchema<T>
			handler: (args: T) => Promise<unknown>,
		) => {
			tools.set(name, { handler: handler as ToolHandler<unknown> });
		},
		callTool: async <T>(name: string, args: T) => {
			const tool = tools.get(name);
			if (!tool) {
				throw new Error(`Tool ${name} not found`);
			}
			return await tool.handler(args);
		},
	};
}

describe("MCP Tools integration tests", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let srcDir: string;
	let mockServer: MockServer;

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

		// Create mock server and register tools
		mockServer = createMockServer();
		// Cast the test mock as McpServer
		// Handle on the test side without changing the implementation
		registerTsMorphTools(mockServer as unknown as McpServer);
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	describe("rename_symbol_by_tsmorph", () => {
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

			// Call rename_symbol_by_tsmorph tool
			await mockServer.callTool("rename_symbol_by_tsmorph", {
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
			await mockServer.callTool("rename_symbol_by_tsmorph", {
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

	describe("find_references_by_tsmorph", () => {
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

			// Call find_references_by_tsmorph tool
			const result = await mockServer.callTool("find_references_by_tsmorph", {
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

	describe("remove_path_alias_by_tsmorph", () => {
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

			// Call remove_path_alias_by_tsmorph tool
			await mockServer.callTool("remove_path_alias_by_tsmorph", {
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

	describe("rename_filesystem_entry_by_tsmorph", () => {
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

			// Call rename_filesystem_entry_by_tsmorph tool
			await mockServer.callTool("rename_filesystem_entry_by_tsmorph", {
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

	describe("move_symbol_to_file_by_tsmorph", () => {
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

			// Call move_symbol_to_file_by_tsmorph tool
			await mockServer.callTool("move_symbol_to_file_by_tsmorph", {
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

	describe("change_signature_by_tsmorph", () => {
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

			const result = await mockServer.callTool("change_signature_by_tsmorph", {
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

			const result = await mockServer.callTool("change_signature_by_tsmorph", {
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

	describe("get_type_at_position_by_tsmorph", () => {
		it("can retrieve type information for a variable", async () => {
			const filePath = path.join(srcDir, "types.ts");
			fs.writeFileSync(
				filePath,
				`const user = { id: "u1", name: "alice" };
console.log(user);
`,
			);

			const result = await mockServer.callTool(
				"get_type_at_position_by_tsmorph",
				{
					tsconfigPath,
					targetFilePath: filePath,
					position: { line: 2, column: 13 }, // "user" inside console.log
				},
			);

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

			const result = await mockServer.callTool(
				"get_type_at_position_by_tsmorph",
				{
					tsconfigPath,
					targetFilePath: filePath,
					position: { line: 4, column: 1 },
				},
			);

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

			const result = await mockServer.callTool(
				"get_type_at_position_by_tsmorph",
				{
					tsconfigPath,
					targetFilePath: appPath,
					position: { line: 2, column: 1 },
				},
			);

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("Symbol: helper");
			expect(text).toContain(`Declared at: ${libPath}:1:`);
		});

		it("returns an error for an out-of-range position", async () => {
			const filePath = path.join(srcDir, "small.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			const result = await mockServer.callTool(
				"get_type_at_position_by_tsmorph",
				{
					tsconfigPath,
					targetFilePath: filePath,
					position: { line: 99, column: 1 },
				},
			);

			expect(result).toHaveProperty("isError", true);
			expect(result.content[0]?.text).toContain("Error");
		});
	});

	describe("find_unused_exports_by_tsmorph", () => {
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

			const result = await mockServer.callTool(
				"find_unused_exports_by_tsmorph",
				{ tsconfigPath },
			);

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

			const result = await mockServer.callTool(
				"find_unused_exports_by_tsmorph",
				{ tsconfigPath },
			);

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

			const result = await mockServer.callTool(
				"find_unused_exports_by_tsmorph",
				{ tsconfigPath, responseFormat: "summary" },
			);

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

			const result = await mockServer.callTool(
				"find_unused_exports_by_tsmorph",
				{ tsconfigPath, entryPoints: [publicPath] },
			);

			expect(result).toHaveProperty("isError", false);
			const text = result.content[0]?.text || "";
			expect(text).toContain("internalFn");
			expect(text).not.toContain("publicFn");
		});
	});

	describe("error handling", () => {
		it("returns an error for a file that does not exist", async () => {
			const nonExistentPath = path.join(srcDir, "non-existent.ts");

			const result = await mockServer.callTool("rename_symbol_by_tsmorph", {
				tsconfigPath,
				targetFilePath: nonExistentPath,
				position: { line: 1, column: 1 },
				symbolName: "test",
				newName: "renamed",
				dryRun: false,
			});

			// The MCP tool returns an error but does not throw
			expect(result).toHaveProperty("isError", true);
			expect(result.content[0]?.text).toContain("Error");
		});

		it("returns an error for an invalid symbol name", async () => {
			const testPath = path.join(srcDir, "test.ts");

			fs.writeFileSync(testPath, `const validName = "test";`);

			const result = await mockServer.callTool("rename_symbol_by_tsmorph", {
				tsconfigPath,
				targetFilePath: testPath,
				position: { line: 1, column: 7 },
				symbolName: "wrongName", // differs from the actual symbol name
				newName: "renamed",
				dryRun: false,
			});

			// The MCP tool returns an error but does not throw
			expect(result).toHaveProperty("isError", true);
			expect(result.content[0]?.text).toContain("Error");
		});
	});
});
