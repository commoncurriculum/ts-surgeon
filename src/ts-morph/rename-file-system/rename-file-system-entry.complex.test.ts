import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { expectFileMoved } from "../_test-utils/expect-file-moved.js";
import { renameFileSystemEntry } from "./rename-file-system-entry.js";
import { getFileText } from "../_test-utils/get-file-text.js";

describe("renameFileSystemEntry Complex Cases", () => {
	it("renames a folder with internal cross-references", async () => {
		const project = createInMemoryProject();
		const oldDirPath = "/src/internal-feature";
		const newDirPath = "/src/cool-feature";
		const file1Path = path.join(oldDirPath, "file1.ts");
		const file2Path = path.join(oldDirPath, "file2.ts");

		project.createSourceFile(
			file1Path,
			`import { value2 } from './file2'; export const value1 = value2 + 1;`,
		);
		project.createSourceFile(file2Path, "export const value2 = 100;");

		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: oldDirPath, newPath: newDirPath }],
			dryRun: false,
		});

		expect(project.getDirectory(newDirPath)).toBeDefined();
		const movedFile1 = project.getSourceFile(path.join(newDirPath, "file1.ts"));
		expect(movedFile1).toBeDefined();
		expect(movedFile1?.getFullText()).toContain(
			"import { value2 } from './file2';",
		);
	});

	it("renames multiple files simultaneously with each reference correctly updated", async () => {
		const project = createInMemoryProject();
		const oldFile1 = "/src/utils/file1.ts";
		const newFile1 = "/src/utils/renamed1.ts";
		const oldFile2 = "/src/components/file2.ts";
		const newFile2 = "/src/components/renamed2.ts";
		const refFile = "/src/ref.ts";

		project.createSourceFile(oldFile1, "export const val1 = 1;");
		project.createSourceFile(oldFile2, "export const val2 = 2;");
		project.createSourceFile(
			refFile,
			`import { val1 } from './utils/file1';\nimport { val2 } from './components/file2';`,
		);

		await renameFileSystemEntry({
			project,
			renames: [
				{ oldPath: oldFile1, newPath: newFile1 },
				{ oldPath: oldFile2, newPath: newFile2 },
			],
			dryRun: false,
		});

		expectFileMoved(project, oldFile1, newFile1);
		expectFileMoved(project, oldFile2, newFile2);
		const updatedRef = getFileText(project, refFile);
		expect(updatedRef).toContain("import { val1 } from './utils/renamed1';");
		expect(updatedRef).toContain(
			"import { val2 } from './components/renamed2';",
		);
	});

	it("renames a file and a directory simultaneously with each reference correctly updated", async () => {
		const project = createInMemoryProject();
		const oldFile = "/src/utils/fileA.ts";
		const newFile = "/src/utils/fileRenamed.ts";
		const oldDir = "/src/components";
		const newDir = "/src/widgets";
		const compInDir = path.join(oldDir, "comp.ts");
		const refFile = "/src/ref.ts";

		project.createSourceFile(oldFile, "export const valA = 'A';");
		project.createSourceFile(compInDir, "export const valComp = 'Comp';");
		project.createSourceFile(
			refFile,
			`import { valA } from './utils/fileA';\nimport { valComp } from './components/comp';`,
		);

		await renameFileSystemEntry({
			project,
			renames: [
				{ oldPath: oldFile, newPath: newFile },
				{ oldPath: oldDir, newPath: newDir },
			],
			dryRun: false,
		});

		expectFileMoved(project, oldFile, newFile);
		expect(project.getDirectory(newDir)).toBeDefined();
		expect(project.getSourceFile(path.join(newDir, "comp.ts"))).toBeDefined();
		const updatedRef = getFileText(project, refFile);
		expect(updatedRef).toContain("import { valA } from './utils/fileRenamed';");
		expect(updatedRef).toContain("import { valComp } from './widgets/comp';");
	});

	it("after directory rename, no empty subdirectories from the old hierarchy remain (issue #27)", async () => {
		const project = createInMemoryProject();
		const oldDirPath = "/src/foo";
		const newDirPath = "/src/bar";

		project.createSourceFile(`${oldDirPath}/index.ts`, "export const a = 1;");
		project.createSourceFile(
			`${oldDirPath}/sub-a/index.ts`,
			"export const b = 2;",
		);
		project.createSourceFile(
			`${oldDirPath}/sub-b/nested/index.ts`,
			"export const c = 3;",
		);

		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: oldDirPath, newPath: newDirPath }],
			dryRun: false,
		});

		// 1. New directory tree exists
		expect(project.getDirectory(newDirPath)).toBeDefined();
		expect(
			project.getSourceFile(`${newDirPath}/sub-b/nested/index.ts`),
		).toBeDefined();

		// 2. Old directory is gone from the project tree (the essence of issue #27)
		expect(project.getDirectory(oldDirPath)).toBeUndefined();
		expect(project.getDirectory(`${oldDirPath}/sub-a`)).toBeUndefined();
		expect(project.getDirectory(`${oldDirPath}/sub-b`)).toBeUndefined();
		expect(project.getDirectory(`${oldDirPath}/sub-b/nested`)).toBeUndefined();
	});

	it("directory rename has shell mv semantics: untracked files are moved together", async () => {
		// The old implementation (per-file sourceFile.move + cleanup) left untracked files in the old dir,
		// but after adopting Directory.move() (FS-level atomic rename) for performance,
		// untracked and unexpected files are all moved to the new dir, just like shell `mv`.
		// Note: if you place handwritten READMEs or generated dist/ under src/, the behavior changes,
		// so callers should design their directory structure with this in mind.
		const project = createInMemoryProject();
		const oldDirPath = "/src/foo";
		const newDirPath = "/src/bar";

		project.createSourceFile(`${oldDirPath}/index.ts`, "export const a = 1;");
		project.createSourceFile(
			`${oldDirPath}/sub-a/index.ts`,
			"export const b = 2;",
		);
		const fs = project.getFileSystem();
		fs.writeFileSync(`${oldDirPath}/sub-a/README.md`, "# moved together");

		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: oldDirPath, newPath: newDirPath }],
			dryRun: false,
		});

		// Old directory completely gone
		expect(fs.directoryExistsSync(oldDirPath)).toBe(false);
		expect(fs.directoryExistsSync(`${oldDirPath}/sub-a`)).toBe(false);
		// Untracked files also moved under the new directory
		expect(fs.directoryExistsSync(`${newDirPath}/sub-a`)).toBe(true);
		expect(fs.readFileSync(`${newDirPath}/sub-a/README.md`)).toContain(
			"moved together",
		);
	});

	it("swaps file names (via a temporary file)", async () => {
		const project = createInMemoryProject();
		const fileA = "/src/fileA.ts";
		const fileB = "/src/fileB.ts";
		const tempFile = "/src/temp.ts";
		const refFile = "/src/ref.ts";

		project.createSourceFile(fileA, "export const valA = 'A';");
		project.createSourceFile(fileB, "export const valB = 'B';");
		project.createSourceFile(
			refFile,
			`import { valA } from './fileA';\nimport { valB } from './fileB';`,
		);

		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: fileA, newPath: tempFile }],
			dryRun: false,
		});
		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: fileB, newPath: fileA }],
			dryRun: false,
		});
		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: tempFile, newPath: fileB }],
			dryRun: false,
		});

		expect(project.getSourceFile(tempFile)).toBeUndefined();
		expect(getFileText(project, fileA)).toContain("export const valB = 'B';");
		expect(getFileText(project, fileB)).toContain("export const valA = 'A';");
		const updatedRef = getFileText(project, refFile);
		expect(updatedRef).toContain("import { valA } from './fileB';");
		expect(updatedRef).toContain("import { valB } from './fileA';");
	});
});
