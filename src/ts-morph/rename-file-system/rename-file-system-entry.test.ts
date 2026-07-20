import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renameFileSystemEntry } from "./rename-file-system-entry.js";
import { initializeProject } from "../_utils/ts-morph-project.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Creates a temporary directory for testing
 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "rename-file-system-test-"));
}

/**
 * Recursively deletes a directory
 */
function removeTempDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("renameFileSystemEntry Integration Tests", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let srcDir: string;

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
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("single file rename with import update", async () => {
		// Create test files
		const oldUtilsPath = path.join(srcDir, "utils.ts");
		const newUtilsPath = path.join(srcDir, "helpers.ts");
		const mainPath = path.join(srcDir, "main.ts");

		fs.writeFileSync(
			oldUtilsPath,
			`export function formatDate(date: Date): string {
  return date.toISOString();
}

export const VERSION = "1.0.0";
`,
		);

		fs.writeFileSync(
			mainPath,
			`import { formatDate, VERSION } from "./utils";

const now = new Date();
console.log(formatDate(now));
console.log("Version:", VERSION);
`,
		);

		// Create project and run rename
		const project = initializeProject(tsconfigPath);

		const result = await renameFileSystemEntry({
			project,
			renames: [
				{
					oldPath: oldUtilsPath,
					newPath: newUtilsPath,
				},
			],
			dryRun: false,
		});

		// Verify renamed file exists
		expect(fs.existsSync(newUtilsPath)).toBe(true);
		expect(fs.existsSync(oldUtilsPath)).toBe(false);

		// Verify import statement was updated
		const updatedMainContent = fs.readFileSync(mainPath, "utf-8");
		expect(updatedMainContent).toContain('from "./helpers"');
		expect(updatedMainContent).not.toContain('from "./utils"');

		// Verify list of changed files
		expect(result.changedFiles).toContain(mainPath);
		expect(result.changedFiles).toContain(newUtilsPath);
	});

	it("folder rename with multi-file reference update", async () => {
		// Create folder structure
		const oldFolderPath = path.join(srcDir, "components");
		const newFolderPath = path.join(srcDir, "widgets");
		fs.mkdirSync(oldFolderPath, { recursive: true });

		const buttonPath = path.join(oldFolderPath, "Button.ts");
		const modalPath = path.join(oldFolderPath, "Modal.ts");
		const appPath = path.join(srcDir, "app.ts");

		fs.writeFileSync(
			buttonPath,
			`export class Button {
  constructor(public label: string) {}
  render() {
    return \`<button>\${this.label}</button>\`;
  }
}
`,
		);

		fs.writeFileSync(
			modalPath,
			`import { Button } from "./Button";

export class Modal {
  private closeButton = new Button("Close");
  
  render() {
    return \`<div class="modal">\${this.closeButton.render()}</div>\`;
  }
}
`,
		);

		fs.writeFileSync(
			appPath,
			`import { Button } from "./components/Button";
import { Modal } from "./components/Modal";

const button = new Button("Click me");
const modal = new Modal();

console.log(button.render());
console.log(modal.render());
`,
		);

		// Create project and run rename
		const project = initializeProject(tsconfigPath);

		await renameFileSystemEntry({
			project,
			renames: [
				{
					oldPath: oldFolderPath,
					newPath: newFolderPath,
				},
			],
			dryRun: false,
		});

		// Verify folder was renamed
		expect(fs.existsSync(newFolderPath)).toBe(true);
		// ts-morph moves files, but empty folders may remain
		// What matters is that files were correctly moved

		// Verify files moved to new folder
		expect(fs.existsSync(path.join(newFolderPath, "Button.ts"))).toBe(true);
		expect(fs.existsSync(path.join(newFolderPath, "Modal.ts"))).toBe(true);

		// Verify no files remain in old folder
		expect(fs.existsSync(path.join(oldFolderPath, "Button.ts"))).toBe(false);
		expect(fs.existsSync(path.join(oldFolderPath, "Modal.ts"))).toBe(false);

		// Verify import statements were updated
		const updatedAppContent = fs.readFileSync(appPath, "utf-8");
		expect(updatedAppContent).toContain('from "./widgets/Button"');
		expect(updatedAppContent).toContain('from "./widgets/Modal"');
		expect(updatedAppContent).not.toContain('from "./components/');

		// Verify relative imports inside Modal.ts were also updated
		const updatedModalContent = fs.readFileSync(
			path.join(newFolderPath, "Modal.ts"),
			"utf-8",
		);
		expect(updatedModalContent).toContain('from "./Button"'); // relative path unchanged
	});

	it("dryRun mode does not modify the file system", async () => {
		const oldPath = path.join(srcDir, "old-file.ts");
		const newPath = path.join(srcDir, "new-file.ts");
		const importerPath = path.join(srcDir, "importer.ts");

		fs.writeFileSync(oldPath, "export const value = 42;");

		fs.writeFileSync(
			importerPath,
			`import { value } from "./old-file";
console.log(value);
`,
		);

		const project = initializeProject(tsconfigPath);

		const result = await renameFileSystemEntry({
			project,
			renames: [
				{
					oldPath,
					newPath,
				},
			],
			dryRun: true, // enable dryRun mode
		});

		// Verify file system was not changed
		expect(fs.existsSync(oldPath)).toBe(true);
		expect(fs.existsSync(newPath)).toBe(false);

		// Verify original import statement was not changed
		const importerContent = fs.readFileSync(importerPath, "utf-8");
		expect(importerContent).toContain('from "./old-file"');

		// List of files to be changed is still returned
		expect(result.changedFiles.length).toBeGreaterThan(0);
	});

	it("update imports using path aliases", async () => {
		const utilsDir = path.join(srcDir, "utils");
		const helpersDir = path.join(srcDir, "helpers");
		fs.mkdirSync(utilsDir, { recursive: true });

		const mathPath = path.join(utilsDir, "math.ts");
		const appPath = path.join(srcDir, "app.ts");

		fs.writeFileSync(
			mathPath,
			`export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`,
		);

		fs.writeFileSync(
			appPath,
			`import { add, multiply } from "@/utils/math";

console.log(add(2, 3));
console.log(multiply(4, 5));
`,
		);

		const project = initializeProject(tsconfigPath);

		await renameFileSystemEntry({
			project,
			renames: [
				{
					oldPath: utilsDir,
					newPath: helpersDir,
				},
			],
			dryRun: false,
		});

		// Verify folder was renamed
		expect(fs.existsSync(helpersDir)).toBe(true);
		// ts-morph moves files, but empty folders may remain
		// What matters is that files were correctly moved

		// Verify file moved to new folder
		expect(fs.existsSync(path.join(helpersDir, "math.ts"))).toBe(true);
		expect(fs.existsSync(path.join(utilsDir, "math.ts"))).toBe(false);

		// Verify path-alias imports were updated
		// ts-morph rename may convert path aliases to relative paths
		const updatedAppContent = fs.readFileSync(appPath, "utf-8");
		expect(updatedAppContent).toContain('from "./helpers/math"');
		expect(updatedAppContent).not.toContain('from "@/utils/math"');
	});

	it("simultaneous rename of multiple files", async () => {
		const file1OldPath = path.join(srcDir, "file1.ts");
		const file1NewPath = path.join(srcDir, "renamed1.ts");
		const file2OldPath = path.join(srcDir, "file2.ts");
		const file2NewPath = path.join(srcDir, "renamed2.ts");
		const mainPath = path.join(srcDir, "main.ts");

		fs.writeFileSync(file1OldPath, `export const value1 = "first";`);

		fs.writeFileSync(file2OldPath, `export const value2 = "second";`);

		fs.writeFileSync(
			mainPath,
			`import { value1 } from "./file1";
import { value2 } from "./file2";

console.log(value1, value2);
`,
		);

		const project = initializeProject(tsconfigPath);

		await renameFileSystemEntry({
			project,
			renames: [
				{ oldPath: file1OldPath, newPath: file1NewPath },
				{ oldPath: file2OldPath, newPath: file2NewPath },
			],
			dryRun: false,
		});

		// Verify both files were renamed
		expect(fs.existsSync(file1NewPath)).toBe(true);
		expect(fs.existsSync(file2NewPath)).toBe(true);
		expect(fs.existsSync(file1OldPath)).toBe(false);
		expect(fs.existsSync(file2OldPath)).toBe(false);

		// Verify both import statements were updated
		const updatedMainContent = fs.readFileSync(mainPath, "utf-8");
		expect(updatedMainContent).toContain('from "./renamed1"');
		expect(updatedMainContent).toContain('from "./renamed2"');
		expect(updatedMainContent).not.toContain('from "./file1"');
		expect(updatedMainContent).not.toContain('from "./file2"');
	});

	it("cancellation via AbortSignal", async () => {
		const oldPath = path.join(srcDir, "cancelable.ts");
		const newPath = path.join(srcDir, "renamed.ts");

		fs.writeFileSync(oldPath, `export const data = "test";`);

		const project = initializeProject(tsconfigPath);
		const abortController = new AbortController();

		// Cancel immediately
		abortController.abort();

		await expect(
			renameFileSystemEntry({
				project,
				renames: [{ oldPath, newPath }],
				dryRun: false,
				signal: abortController.signal,
			}),
		).rejects.toThrow();

		// Verify file was not changed
		expect(fs.existsSync(oldPath)).toBe(true);
		expect(fs.existsSync(newPath)).toBe(false);
	});
});
