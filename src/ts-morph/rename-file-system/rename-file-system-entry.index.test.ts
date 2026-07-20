import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project.js";
import { expectFileMoved } from "../_test-utils/expect-file-moved.js";
import { renameFileSystemEntry } from "./rename-file-system-entry.js";
import { getFileText } from "../_test-utils/get-file-text.js";

describe("renameFileSystemEntry Index File Cases", () => {
	it("renames the index.ts file itself", async () => {
		const project = createInMemoryProject();
		const oldIndexPath = "/src/utils/index.ts";
		const newIndexPath = "/src/utils/main.ts";
		const componentPath = "/src/components/MyComponent.ts";

		project.createSourceFile(oldIndexPath, "export const utilFromIndex = 1;");
		project.createSourceFile(
			componentPath,
			"import { utilFromIndex } from '../utils';",
		);

		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: oldIndexPath, newPath: newIndexPath }],
			dryRun: false,
		});

		expectFileMoved(project, oldIndexPath, newIndexPath);
		const updatedComponent = project.getSourceFileOrThrow(componentPath);
		// When index.ts is renamed, a directory-style reference should point to the renamed filename
		expect(updatedComponent.getFullText()).toContain(
			"import { utilFromIndex } from '../utils/main';",
		);
	});

	it("correctly updates index.ts references using '.' from inside and '..' from outside during a directory rename", async () => {
		const project = createInMemoryProject();
		const oldDirPath = "/src/featureA";
		const newDirPath = "/src/featureRenamed";
		const indexTsPath = path.join(oldDirPath, "index.ts");
		const componentTsPath = path.join(oldDirPath, "component.ts");
		const serviceTsPath = "/src/core/service.ts";

		project.createSourceFile(indexTsPath, "export const featureValue = 'A';");
		project.createSourceFile(
			componentTsPath,
			"import { featureValue } from '.';",
		);
		project.createSourceFile(
			serviceTsPath,
			"import { featureValue } from '../featureA';",
		);

		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: oldDirPath, newPath: newDirPath }],
			dryRun: false,
		});

		const newComponentTsPath = path.join(newDirPath, "component.ts");
		const updatedComponent = project.getSourceFileOrThrow(newComponentTsPath);
		const updatedService = project.getSourceFileOrThrow(serviceTsPath);

		expect(updatedComponent.getFullText()).toContain(
			"import { featureValue } from '.';",
		);

		// The '../featureA' reference in service.ts should be updated to '../featureRenamed/index'
		expect(updatedService.getFullText()).toContain(
			"import { featureValue } from '../featureRenamed/index';",
		);
	});

	it("correctly updates the path when a default-exported variable from index.ts is imported via a path-alias directory name and index.ts is renamed", async () => {
		const project = createInMemoryProject();
		const featureDir = "/src/myFeature";
		const oldIndexPath = path.join(featureDir, "index.ts");
		const newIndexPath = path.join(featureDir, "mainComponent.ts");
		const importerPath = "/src/app.ts";

		project.createSourceFile(
			oldIndexPath,
			"const MyFeatureComponent = () => {};\nexport default MyFeatureComponent;",
		);
		project.createSourceFile(
			importerPath,
			"import MyFeature from '@/myFeature';\nMyFeature();",
		);

		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: oldIndexPath, newPath: newIndexPath }],
			dryRun: false,
		});

		const updatedImporterContent = getFileText(project, importerPath);
		expectFileMoved(project, oldIndexPath, newIndexPath);
		// Expect the path-alias reference to be updated to the renamed file path.
		expect(updatedImporterContent).toContain(
			"import MyFeature from './myFeature/mainComponent';",
		);
	});

	it("correctly updates the path when a default-exported function from index.ts is imported via a path-alias directory name and index.ts is renamed", async () => {
		const project = createInMemoryProject();
		const featureDir = "/src/anotherFeature";
		const oldIndexPath = path.join(featureDir, "index.ts");
		const newIndexPath = path.join(featureDir, "coreFunction.ts");
		const importerPath = "/src/main.ts";

		project.createSourceFile(
			oldIndexPath,
			"export default function myCoreFunction() {}\n",
		);
		project.createSourceFile(
			importerPath,
			"import CoreFunc from '@/anotherFeature';\nCoreFunc();",
		);

		await renameFileSystemEntry({
			project,
			renames: [{ oldPath: oldIndexPath, newPath: newIndexPath }],
			dryRun: false,
		});

		const updatedImporterContent = getFileText(project, importerPath);
		expectFileMoved(project, oldIndexPath, newIndexPath);
		// Expect the path-alias reference to be updated to the renamed file path.
		expect(updatedImporterContent).toContain(
			"import CoreFunc from './anotherFeature/coreFunction';",
		);
	});
});
