import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findSymbolReferences } from "./find-references.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Creates a temporary directory for test use.
 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "find-references-test-"));
}

/**
 * Recursively removes a directory.
 */
function removeTempDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("findSymbolReferences", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("can find references to a basic variable", async () => {
		// Create a test project on the filesystem
		const tsconfigPath = path.join(tempDir, "tsconfig.json");
		const srcDir = path.join(tempDir, "src");
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
					},
					include: ["src/**/*"],
				},
				null,
				2,
			),
		);

		// Create test files
		const utilsPath = path.join(srcDir, "utils.ts");
		const mainPath = path.join(srcDir, "main.ts");

		fs.writeFileSync(
			utilsPath,
			`export const myVariable = "test value";

export function helperFunction() {
  return myVariable;
}
`,
		);

		fs.writeFileSync(
			mainPath,
			`import { myVariable, helperFunction } from "./utils";

console.log(myVariable);
const result = helperFunction();
`,
		);

		// Search for references to myVariable (at its definition position)
		const result = await findSymbolReferences({
			tsconfigPath,
			targetFilePath: utilsPath,
			position: { line: 1, column: 14 }, // position of "myVariable"
		});

		// Verify the definition location
		expect(result.definition).toBeTruthy();
		expect(result.definition?.filePath).toBe(utilsPath);
		expect(result.definition?.line).toBe(1);
		expect(result.definition?.text).toContain("myVariable");

		// Verify reference locations (definition site excluded)
		// Import statements are also included as references
		expect(result.references.length).toBeGreaterThanOrEqual(2);

		// Reference inside utils.ts
		const utilsRef = result.references.find(
			(ref) => ref.filePath === utilsPath && ref.line === 4,
		);
		expect(utilsRef).toBeTruthy();

		// References inside main.ts (import statement and console.log)
		const mainRefs = result.references.filter(
			(ref) => ref.filePath === mainPath,
		);
		expect(mainRefs.length).toBeGreaterThanOrEqual(1);

		// Verify the console.log reference is included
		const consoleLogRef = mainRefs.find((ref) => ref.line === 3);
		expect(consoleLogRef).toBeTruthy();
	});

	it("can find references to a function", async () => {
		const tsconfigPath = path.join(tempDir, "tsconfig.json");
		const srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });

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
					},
					include: ["src/**/*"],
				},
				null,
				2,
			),
		);

		const functionsPath = path.join(srcDir, "functions.ts");
		const usagePath = path.join(srcDir, "usage.ts");

		fs.writeFileSync(
			functionsPath,
			`export function calculate(a: number, b: number): number {
  return a + b;
}

export function processData() {
  const result = calculate(10, 20);
  return result;
}
`,
		);

		fs.writeFileSync(
			usagePath,
			`import { calculate, processData } from "./functions";

const sum = calculate(5, 3);
console.log(sum);
processData();
`,
		);

		// Search for references to the calculate function
		const result = await findSymbolReferences({
			tsconfigPath,
			targetFilePath: functionsPath,
			position: { line: 1, column: 17 }, // position of "calculate"
		});

		expect(result.definition).toBeTruthy();
		expect(result.definition?.filePath).toBe(functionsPath);

		// References (excluding definition)
		// Import statements are also included
		expect(result.references.length).toBeGreaterThanOrEqual(2);

		// Internal reference inside functions.ts
		const internalRef = result.references.find(
			(ref) => ref.filePath === functionsPath && ref.line === 6,
		);
		expect(internalRef).toBeTruthy();

		// References inside usage.ts
		const externalRefs = result.references.filter(
			(ref) => ref.filePath === usagePath,
		);
		expect(externalRefs.length).toBeGreaterThanOrEqual(1);

		// Verify the calculate(5, 3) call is included
		const callRef = externalRefs.find((ref) => ref.line === 3);
		expect(callRef).toBeTruthy();
	});

	it("can find references to a class", async () => {
		const tsconfigPath = path.join(tempDir, "tsconfig.json");
		const srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });

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
					},
					include: ["src/**/*"],
				},
				null,
				2,
			),
		);

		const modelsPath = path.join(srcDir, "models.ts");
		const appPath = path.join(srcDir, "app.ts");

		fs.writeFileSync(
			modelsPath,
			`export class User {
  constructor(public name: string, public age: number) {}

  greet(): string {
    return \`Hello, I'm \${this.name}\`;
  }
}

export class Admin extends User {
  constructor(name: string, age: number, public role: string) {
    super(name, age);
  }
}
`,
		);

		fs.writeFileSync(
			appPath,
			`import { User, Admin } from "./models";

const user = new User("John", 30);
const admin = new Admin("Jane", 25, "super-admin");

console.log(user.greet());
`,
		);

		// Search for references to the User class
		const result = await findSymbolReferences({
			tsconfigPath,
			targetFilePath: modelsPath,
			position: { line: 1, column: 14 }, // position of "User"
		});

		expect(result.definition).toBeTruthy();
		expect(result.definition?.filePath).toBe(modelsPath);

		// Verify references
		expect(result.references.length).toBeGreaterThanOrEqual(2);

		// Inheritance reference in Admin class
		const extendsRef = result.references.find(
			(ref) => ref.filePath === modelsPath && ref.text.includes("extends"),
		);
		expect(extendsRef).toBeTruthy();

		// Instantiation in app.ts
		const instantiationRef = result.references.find(
			(ref) => ref.filePath === appPath && ref.text.includes("new User"),
		);
		expect(instantiationRef).toBeTruthy();
	});

	it("throws an error for a non-existent symbol position", async () => {
		const tsconfigPath = path.join(tempDir, "tsconfig.json");
		const srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });

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
					},
					include: ["src/**/*"],
				},
				null,
				2,
			),
		);

		const testPath = path.join(srcDir, "test.ts");
		fs.writeFileSync(
			testPath,
			`const someVariable = "test";
`,
		);

		// Specify a position that does not exist
		await expect(
			findSymbolReferences({
				tsconfigPath,
				targetFilePath: testPath,
				position: { line: 10, column: 1 }, // non-existent line
			}),
		).rejects.toThrow();
	});

	it("can find references to a re-exported symbol", async () => {
		const tsconfigPath = path.join(tempDir, "tsconfig.json");
		const srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });

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
					},
					include: ["src/**/*"],
				},
				null,
				2,
			),
		);

		const utilsPath = path.join(srcDir, "utils.ts");
		const indexPath = path.join(srcDir, "index.ts");
		const appPath = path.join(srcDir, "app.ts");

		// utils.ts - original definition
		fs.writeFileSync(
			utilsPath,
			`export function helper() {
  return "helper function";
}

export const CONSTANT = 42;
`,
		);

		// index.ts - re-export
		fs.writeFileSync(
			indexPath,
			`export { helper, CONSTANT } from "./utils";
export { helper as utilHelper } from "./utils"; // re-export under an alias
`,
		);

		// app.ts - consumption via re-export
		fs.writeFileSync(
			appPath,
			`import { helper, CONSTANT, utilHelper } from "./index";

console.log(helper());
console.log(CONSTANT);
console.log(utilHelper());
`,
		);

		// Search for references to the helper function
		const result = await findSymbolReferences({
			tsconfigPath,
			targetFilePath: utilsPath,
			position: { line: 1, column: 17 }, // position of "helper"
		});

		expect(result.definition).toBeTruthy();
		expect(result.definition?.filePath).toBe(utilsPath);

		// Includes re-export statements, import statements, and usage sites
		expect(result.references.length).toBeGreaterThanOrEqual(3);

		// Re-export references in index.ts
		const reExportRefs = result.references.filter(
			(ref) => ref.filePath === indexPath,
		);
		expect(reExportRefs.length).toBeGreaterThanOrEqual(2); // normal re-export and aliased re-export

		// Usage references in app.ts
		const appRefs = result.references.filter((ref) => ref.filePath === appPath);
		expect(appRefs.length).toBeGreaterThanOrEqual(1);
	});

	it("can find references across files with circular dependencies", async () => {
		const tsconfigPath = path.join(tempDir, "tsconfig.json");
		const srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });

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
					},
					include: ["src/**/*"],
				},
				null,
				2,
			),
		);

		const moduleAPath = path.join(srcDir, "moduleA.ts");
		const moduleBPath = path.join(srcDir, "moduleB.ts");

		// moduleA.ts - references moduleB
		fs.writeFileSync(
			moduleAPath,
			`import { functionB } from "./moduleB";

export function functionA() {
  return "A";
}

export function useB() {
  return functionB();
}
`,
		);

		// moduleB.ts - references moduleA (circular dependency)
		fs.writeFileSync(
			moduleBPath,
			`import { functionA } from "./moduleA";

export function functionB() {
  return "B";
}

export function useA() {
  return functionA();
}
`,
		);

		// Search for references to functionA
		const result = await findSymbolReferences({
			tsconfigPath,
			targetFilePath: moduleAPath,
			position: { line: 3, column: 17 }, // position of "functionA"
		});

		expect(result.definition).toBeTruthy();
		expect(result.definition?.filePath).toBe(moduleAPath);

		// Verify references from moduleB
		const moduleBRefs = result.references.filter(
			(ref) => ref.filePath === moduleBPath,
		);
		expect(moduleBRefs.length).toBeGreaterThanOrEqual(1);

		// Verify the call inside useA is included
		const useARef = moduleBRefs.find((ref) => ref.text.includes("functionA()"));
		expect(useARef).toBeTruthy();
	});

	it("can find references to an interface", async () => {
		const tsconfigPath = path.join(tempDir, "tsconfig.json");
		const srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });

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
					},
					include: ["src/**/*"],
				},
				null,
				2,
			),
		);

		const typesPath = path.join(srcDir, "types.ts");
		const implementationPath = path.join(srcDir, "implementation.ts");

		fs.writeFileSync(
			typesPath,
			`export interface UserData {
  id: number;
  name: string;
  email: string;
}

export interface AdminData extends UserData {
  role: string;
}
`,
		);

		fs.writeFileSync(
			implementationPath,
			`import { UserData, AdminData } from "./types";

function processUser(user: UserData): void {
  console.log(user.name);
}

const userData: UserData = {
  id: 1,
  name: "John",
  email: "john@example.com"
};

const adminData: AdminData = {
  id: 2,
  name: "Jane",
  email: "jane@example.com",
  role: "admin"
};

processUser(userData);
processUser(adminData);
`,
		);

		// Search for references to the UserData interface
		const result = await findSymbolReferences({
			tsconfigPath,
			targetFilePath: typesPath,
			position: { line: 1, column: 18 }, // position of "UserData"
		});

		expect(result.definition).toBeTruthy();
		expect(result.definition?.filePath).toBe(typesPath);

		// Verify references
		expect(result.references.length).toBeGreaterThanOrEqual(3);

		// Inheritance reference inside types.ts
		const extendsRef = result.references.find(
			(ref) => ref.filePath === typesPath && ref.text.includes("extends"),
		);
		expect(extendsRef).toBeTruthy();

		// Type annotation references inside implementation.ts
		const typeAnnotationRefs = result.references.filter(
			(ref) => ref.filePath === implementationPath,
		);
		expect(typeAnnotationRefs.length).toBeGreaterThanOrEqual(2); // function parameter and variable declaration
	});
});

describe("findSymbolReferences with symbolName only (project-wide)", () => {
	let tempDir: string;
	let tsconfigPath: string;

	function write(rel: string, content: string): string {
		const abs = path.join(tempDir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
		return abs;
	}

	beforeEach(() => {
		tempDir = createTempDir();
		tsconfigPath = write(
			"tsconfig.json",
			JSON.stringify({
				compilerOptions: { module: "commonjs", target: "es2020", strict: true },
				include: ["src/**/*"],
			}),
		);
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("locates the declaration without a targetFilePath", async () => {
		const mathPath = write(
			"src/math.ts",
			"export function calculateSum(a: number, b: number) {\n  return a + b;\n}\n",
		);
		const cartPath = write(
			"src/cart.ts",
			'import { calculateSum } from "./math";\nexport const total = calculateSum(1, 2);\n',
		);

		const result = await findSymbolReferences({
			tsconfigPath,
			symbolName: "calculateSum",
		});
		expect(result.definition?.filePath).toBe(mathPath);
		expect(result.references.some((ref) => ref.filePath === cartPath)).toBe(
			true,
		);
	});

	it("treats function overloads as one declaration, not an ambiguity", async () => {
		write(
			"src/fmt.ts",
			[
				"export function fmt(x: string): string;",
				"export function fmt(x: number): string;",
				"export function fmt(x: unknown): string {",
				"  return String(x);",
				"}",
			].join("\n"),
		);
		write("src/use.ts", 'import { fmt } from "./fmt";\nfmt(1);\n');

		const result = await findSymbolReferences({
			tsconfigPath,
			symbolName: "fmt",
		});
		expect(result.references.length).toBeGreaterThanOrEqual(1);
	});

	it("lists every candidate when the name is declared in several files", async () => {
		write("src/a.ts", "export const render = () => 1;\n");
		write("src/b.ts", "export function render() {\n  return 2;\n}\n");

		await expect(
			findSymbolReferences({ tsconfigPath, symbolName: "render" }),
		).rejects.toThrow(/2 declarations[\s\S]*a\.ts[\s\S]*b\.ts/);
	});

	it("throws a clear error when no project declaration exists", async () => {
		write("src/a.ts", "export const x = 1;\n");
		await expect(
			findSymbolReferences({ tsconfigPath, symbolName: "notDeclaredHere" }),
		).rejects.toThrow(/No declaration named 'notDeclaredHere'/);
	});

	it("does not count parameter names as project declarations", async () => {
		// A symbol that only ever appears as a function parameter is local noise;
		// symbol-only lookup must miss it so the hook fails open to plain grep.
		write(
			"src/a.ts",
			"export function f(onlyAParam: number) {\n  return onlyAParam;\n}\n",
		);
		await expect(
			findSymbolReferences({ tsconfigPath, symbolName: "onlyAParam" }),
		).rejects.toThrow(/No declaration named 'onlyAParam'/);
	});

	it("still requires symbolName or targetFilePath", async () => {
		await expect(findSymbolReferences({ tsconfigPath })).rejects.toThrow(
			/symbolName/,
		);
	});
});
