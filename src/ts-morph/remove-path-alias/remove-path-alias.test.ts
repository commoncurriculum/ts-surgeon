import { Project } from "ts-morph";
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { removePathAlias } from "./remove-path-alias";

const TEST_TSCONFIG_PATH = "/tsconfig.json";
const TEST_BASE_URL = "/src";
const TEST_PATHS = {
	"@/*": ["*"],
	"@components/*": ["components/*"],
	"@utils/helpers": ["utils/helpers.ts"],
};

const setupProject = () => {
	const project = new Project({
		useInMemoryFileSystem: true,
		compilerOptions: {
			baseUrl: path.relative(path.dirname(TEST_TSCONFIG_PATH), TEST_BASE_URL),
			paths: TEST_PATHS,
			allowJs: true,
		},
	});
	project.createSourceFile(
		TEST_TSCONFIG_PATH,
		JSON.stringify({
			compilerOptions: { baseUrl: "./src", paths: TEST_PATHS },
		}),
	);
	return project;
};

describe("removePathAlias", () => {
	it("can convert a simple wildcard alias (@/*) to a relative path", async () => {
		const project = setupProject();
		const importerPath = "/src/features/featureA/index.ts";
		const componentPath = "/src/components/Button.ts";
		project.createSourceFile(componentPath, "export const Button = {};");
		const importerContent = `import { Button } from '@/components/Button';`;
		project.createSourceFile(importerPath, importerContent);

		const result = await removePathAlias({
			project,
			targetPath: importerPath,
			paths: TEST_PATHS,
			dryRun: false,
		});

		const sourceFile = project.getSourceFileOrThrow(importerPath);
		const importDeclaration = sourceFile.getImportDeclarations()[0];
		expect(importDeclaration?.getModuleSpecifierValue()).toBe(
			"../../components/Button",
		);
		expect(result.changedFiles).toEqual([importerPath]);
	});

	it("can convert a specific path alias (@components/*) to a relative path", async () => {
		const project = setupProject();
		const importerPath = "/src/index.ts";
		const componentPath = "/src/components/Input/index.ts";
		project.createSourceFile(componentPath, "export const Input = {};");
		const importerContent = `import { Input } from '@components/Input';`;
		project.createSourceFile(importerPath, importerContent);

		const result = await removePathAlias({
			project,
			targetPath: importerPath,
			paths: TEST_PATHS,
			dryRun: false,
		});

		const sourceFile = project.getSourceFileOrThrow(importerPath);
		expect(
			sourceFile.getImportDeclarations()[0]?.getModuleSpecifierValue(),
		).toBe("./components/Input/index");
		expect(result.changedFiles).toEqual([importerPath]);
	});

	it("can convert a direct file alias (@utils/helpers) to a relative path", async () => {
		const project = setupProject();
		const importerPath = "/src/features/featureB/utils.ts";
		const helperPath = "/src/utils/helpers.ts";
		project.createSourceFile(helperPath, "export const helperFunc = () => {};");
		const importerContent = `import { helperFunc } from '@utils/helpers';`;
		project.createSourceFile(importerPath, importerContent);

		const result = await removePathAlias({
			project,
			targetPath: importerPath,
			paths: TEST_PATHS,
			dryRun: false,
		});

		const sourceFile = project.getSourceFileOrThrow(importerPath);
		expect(
			sourceFile.getImportDeclarations()[0]?.getModuleSpecifierValue(),
		).toBe("../../utils/helpers");
		expect(result.changedFiles).toEqual([importerPath]);
	});

	it("does not change a normal relative path that is not an alias", async () => {
		const project = setupProject();
		const importerPath = "/src/features/featureA/index.ts";
		const servicePath = "/src/features/featureA/service.ts";
		project.createSourceFile(servicePath, "export class Service {}");
		const importerContent = `import { Service } from './service';`;
		const sourceFile = project.createSourceFile(importerPath, importerContent);
		const originalContent = sourceFile.getFullText();

		const result = await removePathAlias({
			project,
			targetPath: importerPath,
			paths: TEST_PATHS,
			dryRun: false,
		});

		expect(sourceFile.getFullText()).toBe(originalContent);
		expect(result.changedFiles).toEqual([]);
	});

	it("does not change a node_modules path that is not an alias", async () => {
		const project = setupProject();
		const importerPath = "/src/index.ts";
		const importerContent = `import * as fs from 'fs';`;
		const sourceFile = project.createSourceFile(importerPath, importerContent);
		const originalContent = sourceFile.getFullText();

		const result = await removePathAlias({
			project,
			targetPath: importerPath,
			paths: TEST_PATHS,
			dryRun: false,
		});

		expect(sourceFile.getFullText()).toBe(originalContent);
		expect(result.changedFiles).toEqual([]);
	});

	it("does not modify files in dryRun mode and returns the list of files that would change", async () => {
		const project = setupProject();
		const importerPath = "/src/features/featureA/index.ts";
		const componentPath = "/src/components/Button.ts";
		project.createSourceFile(componentPath, "export const Button = {};");
		const importerContent = `import { Button } from '@/components/Button';`;
		const sourceFile = project.createSourceFile(importerPath, importerContent);
		const originalContent = sourceFile.getFullText();

		const result = await removePathAlias({
			project,
			targetPath: importerPath,
			paths: TEST_PATHS,
			dryRun: true,
		});

		expect(sourceFile.getFullText()).toBe(originalContent);
		expect(result.changedFiles).toEqual([importerPath]);
	});

	it("can convert aliases in multiple files within a directory when targeting a directory", async () => {
		const project = setupProject();
		const dirPath = "/src/features/multi";
		const file1Path = path.join(dirPath, "file1.ts");
		const file2Path = path.join(dirPath, "sub/file2.ts");
		const buttonPath = "/src/components/Button.ts";
		const inputPath = "/src/components/Input.ts";

		project.createSourceFile(buttonPath, "export const Button = {};");
		project.createSourceFile(inputPath, "export const Input = {};");
		project.createSourceFile(
			file1Path,
			"import { Button } from '@/components/Button';",
		);
		project.createSourceFile(
			file2Path,
			"import { Input } from '@components/Input';",
		);

		const result = await removePathAlias({
			project,
			targetPath: dirPath,
			paths: TEST_PATHS,
			dryRun: false,
		});

		const file1 = project.getSourceFileOrThrow(file1Path);
		const file2 = project.getSourceFileOrThrow(file2Path);

		expect(file1.getImportDeclarations()[0]?.getModuleSpecifierValue()).toBe(
			"../../components/Button",
		);
		expect(file2.getImportDeclarations()[0]?.getModuleSpecifierValue()).toBe(
			"../../../components/Input",
		);
		expect(result.changedFiles.sort()).toEqual([file1Path, file2Path].sort());
	});

	it("does not change an alias path that cannot be resolved", async () => {
		const project = setupProject();
		const importerPath = "/src/index.ts";
		const importerContent = `import { Something } from '@unknown/package';`;
		const sourceFile = project.createSourceFile(importerPath, importerContent);
		const originalContent = sourceFile.getFullText();

		const result = await removePathAlias({
			project,
			targetPath: importerPath,
			paths: TEST_PATHS,
			dryRun: false,
		});

		expect(sourceFile.getFullText()).toBe(originalContent);
		expect(result.changedFiles).toEqual([]);
	});

	it("result ends with /index (not omitted) when the alias points to index.ts", async () => {
		const project = setupProject();
		const importerPath = "/src/features/featureA/component.ts";
		const indexPath = "/src/components/index.ts";

		project.createSourceFile(indexPath, "export const CompIndex = 1;");
		project.createSourceFile(
			importerPath,
			"import { CompIndex } from '@/components';",
		);

		const result = await removePathAlias({
			project,
			targetPath: importerPath,
			paths: { "@/*": ["src/*"] },
			dryRun: false,
		});

		const sourceFile = project.getSourceFileOrThrow(importerPath);
		expect(
			sourceFile.getImportDeclarations()[0]?.getModuleSpecifierValue(),
		).toBe("../../components/index");
		expect(result.changedFiles).toEqual([importerPath]);
	});

	it("removes the extension from the result when the alias points to a .js file", async () => {
		const project = setupProject();
		const importerPath = "/src/app.ts";
		const jsPath = "/src/utils/legacy.js";

		project.createSourceFile(jsPath, "export const legacyFunc = () => {};");
		project.createSourceFile(
			importerPath,
			"import { legacyFunc } from '@/utils/legacy.js';",
		);

		const result = await removePathAlias({
			project,
			targetPath: importerPath,
			paths: { "@/*": ["src/*"] },
			dryRun: false,
		});

		const sourceFile = project.getSourceFileOrThrow(importerPath);
		expect(
			sourceFile.getImportDeclarations()[0]?.getModuleSpecifierValue(),
		).toBe("./utils/legacy");
		expect(result.changedFiles).toEqual([importerPath]);
	});
});
