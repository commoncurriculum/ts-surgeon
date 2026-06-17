import { describe, it, expect, vi } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import { cleanupEmptyOldDirectories } from "./cleanup-empty-old-directories";

vi.mock("../../utils/logger");

describe("cleanupEmptyOldDirectories", () => {
	it("removes an empty directory that remains after files have been moved", () => {
		const project = createInMemoryProject();
		const fs = project.getFileSystem();
		const sf = project.createSourceFile("/src/old/a.ts", "export const a = 1;");
		project.saveSync();
		sf.deleteImmediatelySync();

		cleanupEmptyOldDirectories(project, [
			{ oldPath: "/src/old", newPath: "/src/new" },
		]);

		expect(fs.directoryExistsSync("/src/old")).toBe(false);
	});

	it("does not delete a directory that still contains untracked files", () => {
		const project = createInMemoryProject();
		const fs = project.getFileSystem();
		const sf = project.createSourceFile("/src/old/a.ts", "export const a = 1;");
		project.saveSync();
		sf.deleteImmediatelySync();
		fs.writeFileSync("/src/old/README.md", "stay");

		cleanupEmptyOldDirectories(project, [
			{ oldPath: "/src/old", newPath: "/src/new" },
		]);

		expect(fs.directoryExistsSync("/src/old")).toBe(true);
		expect(fs.readFileSync("/src/old/README.md")).toBe("stay");
	});

	it("does nothing when directoryRenames is empty", () => {
		const project = createInMemoryProject();
		expect(() => cleanupEmptyOldDirectories(project, [])).not.toThrow();
	});

	it("does nothing when the old directory no longer exists (only forgets it)", () => {
		const project = createInMemoryProject();
		// directory that does not exist in the project tree
		cleanupEmptyOldDirectories(project, [
			{ oldPath: "/src/nonexistent", newPath: "/src/new" },
		]);
		// passes as long as it does not throw
	});

	it("can be aborted via AbortSignal", () => {
		const project = createInMemoryProject();
		project.createSourceFile("/src/old/a.ts", "export const a = 1;");
		const controller = new AbortController();
		const abortReason = new Error("test-abort");
		controller.abort(abortReason);

		expect(() =>
			cleanupEmptyOldDirectories(
				project,
				[{ oldPath: "/src/old", newPath: "/src/new" }],
				controller.signal,
			),
		).toThrow(abortReason);
	});
});
