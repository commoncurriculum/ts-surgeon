import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import { renameFileSystemEntry } from "./rename-file-system-entry";
import { getFileText } from "../_test-utils/get-file-text";

function setupProjectWithExistingDir() {
	const project = createInMemoryProject();
	project.createDirectory("/src/existing-dir");
	return project;
}

describe("renameFileSystemEntry Error Cases", () => {
	it("throws an error when trying to rename a non-existent file", async () => {
		const project = createInMemoryProject();
		const oldPath = "/src/nonexistent.ts";
		const newPath = "/src/new.ts";

		await expect(
			renameFileSystemEntry({
				project,
				renames: [{ oldPath, newPath }],
				dryRun: false,
			}),
		).rejects.toThrowError(
			/^Rename process failed: Rename target not found.*See logs for details.$/,
		);
	});

	it("throws an error when trying to rename a non-existent directory", async () => {
		const project = createInMemoryProject();
		const oldPath = "/src/nonexistent-dir";
		const newPath = "/src/new-dir";

		await expect(
			renameFileSystemEntry({
				project,
				renames: [{ oldPath, newPath }],
				dryRun: false,
			}),
		).rejects.toThrowError(
			/^Rename process failed: Rename target not found.*See logs for details.$/,
		);
	});

	it("throws an error when the rename destination path already has a file (no overwrite)", async () => {
		const project = createInMemoryProject();
		const oldPath = "/src/file1.ts";
		const existingPath = "/src/existing.ts";
		project.createSourceFile(oldPath, "export const file1 = 1;");
		project.createSourceFile(existingPath, "export const existing = true;");

		await expect(
			renameFileSystemEntry({
				project,
				renames: [{ oldPath, newPath: existingPath }],
				dryRun: false,
			}),
		).rejects.toThrowError(
			/^Rename process failed: Rename target path already has a file.*See logs for details.$/,
		);
		expect(project.getSourceFile(oldPath)).toBeDefined();
		expect(getFileText(project, existingPath)).toContain("existing = true");
	});

	it("throws an error when the rename destination path already has a directory", async () => {
		const project = setupProjectWithExistingDir();
		const oldPath = "/src/file1.ts";
		const existingDirPath = "/src/existing-dir";
		project.createSourceFile(oldPath, "export const file1 = 1;");

		await expect(
			renameFileSystemEntry({
				project,
				renames: [{ oldPath, newPath: existingDirPath }],
				dryRun: false,
			}),
		).rejects.toThrowError(
			/^Rename process failed: Rename target path already has a directory.*See logs for details.$/,
		);
		expect(project.getSourceFile(oldPath)).toBeDefined();
		expect(project.getDirectory(existingDirPath)).toBeDefined();
	});

	it("throws an error when destination paths are duplicated", async () => {
		const project = createInMemoryProject();
		const file1 = "/src/file1.ts";
		const file2 = "/src/file2.ts";
		const sameNewPath = "/src/renamed.ts";
		project.createSourceFile(file1, "export const v1 = 1;");
		project.createSourceFile(file2, "export const v2 = 2;");

		await expect(
			renameFileSystemEntry({
				project,
				renames: [
					{ oldPath: file1, newPath: sameNewPath },
					{ oldPath: file2, newPath: sameNewPath },
				],
				dryRun: false,
			}),
		).rejects.toThrowError(
			/^Rename process failed: Duplicate destination path.*See logs for details.$/,
		);
	});
});
