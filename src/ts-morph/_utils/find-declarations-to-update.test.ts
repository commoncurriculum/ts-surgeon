import { describe, it, expect } from "vitest";
import { Project, IndentationText, QuoteKind } from "ts-morph";
import { findDeclarationsReferencingFile } from "./find-declarations-to-update";

// --- Setup Helper Function ---
const setupTestProject = () => {
	const project = new Project({
		manipulationSettings: {
			indentationText: IndentationText.TwoSpaces,
			quoteKind: QuoteKind.Single,
		},
		useInMemoryFileSystem: true,
		compilerOptions: {
			baseUrl: ".",
			paths: {
				"@/*": ["src/*"],
				"@utils/*": ["src/utils/*"],
			},
			// typeRoots: [], // Avoids errors on potentially missing node types if not installed
		},
	});

	// Target file
	const targetFilePath = "/src/target.ts";
	const targetFile = project.createSourceFile(
		targetFilePath,
		`export const targetSymbol = 'target';
export type TargetType = number;`,
	);

	// File importing with relative path
	const importerRelPath = "/src/importer-relative.ts";
	project.createSourceFile(
		importerRelPath,
		`import { targetSymbol } from './target';
import type { TargetType } from './target';
console.log(targetSymbol);`,
	);

	// File importing with alias path
	const importerAliasPath = "/src/importer-alias.ts";
	project.createSourceFile(
		importerAliasPath,
		`import { targetSymbol } from '@/target';
console.log(targetSymbol);`,
	);

	// Barrel file re-exporting from target
	const barrelFilePath = "/src/index.ts";
	project.createSourceFile(
		barrelFilePath,
		`export { targetSymbol } from './target'; // re-export value
export type { TargetType } from './target'; // re-export type`,
	);

	// File importing from barrel file
	const importerBarrelPath = "/src/importer-barrel.ts";
	project.createSourceFile(
		importerBarrelPath,
		`import { targetSymbol } from './index'; // import from barrel file
console.log(targetSymbol);`,
	);

	// File with no reference
	const noRefFilePath = "/src/no-ref.ts";
	project.createSourceFile(noRefFilePath, "const unrelated = 1;");

	return {
		project,
		targetFile,
		targetFilePath,
		importerRelPath,
		importerAliasPath,
		barrelFilePath,
		importerBarrelPath,
		noRefFilePath,
	};
};

describe("findDeclarationsReferencingFile", () => {
	it("finds all declarations (Import/Export) that directly reference target.ts", async () => {
		const {
			project,
			targetFile,
			targetFilePath,
			importerRelPath,
			importerAliasPath,
			barrelFilePath,
		} = setupTestProject();
		const results = await findDeclarationsReferencingFile(targetFile);

		// expected: 5 declarations (relative path imports x2, alias path import x1, barrel exports x2)
		expect(results).toHaveLength(5);

		// --- Verify relative path imports ---
		const relativeImports = results.filter(
			(r) =>
				r.referencingFilePath === importerRelPath &&
				r.declaration.getKindName() === "ImportDeclaration",
		);
		expect(relativeImports).toHaveLength(2);
		const valueRelImport = relativeImports.find((r) =>
			r.declaration.getText().includes("targetSymbol"),
		);
		expect(valueRelImport?.originalSpecifierText).toBe("./target");
		const typeRelImport = relativeImports.find((r) =>
			r.declaration.getText().includes("TargetType"),
		);
		expect(typeRelImport?.originalSpecifierText).toBe("./target");

		// --- Verify alias path imports ---
		const aliasImports = results.filter(
			(r) =>
				r.referencingFilePath === importerAliasPath &&
				r.declaration.getKindName() === "ImportDeclaration",
		);
		expect(aliasImports).toHaveLength(1);
		expect(aliasImports[0].originalSpecifierText).toBe("@/target");
		expect(aliasImports[0].wasPathAlias).toBe(true);

		// --- Verify barrel exports ---
		const barrelExports = results.filter(
			(r) =>
				r.referencingFilePath === barrelFilePath &&
				r.declaration.getKindName() === "ExportDeclaration",
		);
		expect(barrelExports).toHaveLength(2);
		const valueBarrelExport = barrelExports.find((r) =>
			r.declaration.getText().includes("targetSymbol"),
		);
		expect(valueBarrelExport?.originalSpecifierText).toBe("./target");
		const typeBarrelExport = barrelExports.find((r) =>
			r.declaration.getText().includes("TargetType"),
		);
		expect(typeBarrelExport?.originalSpecifierText).toBe("./target");
	});

	it("finds an ImportDeclaration importing via an alias path and sets wasPathAlias to true", async () => {
		const { project, targetFile, targetFilePath, importerAliasPath } =
			setupTestProject();
		const results = await findDeclarationsReferencingFile(targetFile);

		// Identify the import using an alias path
		const aliasImports = results.filter(
			(r) => r.referencingFilePath === importerAliasPath,
		);
		expect(aliasImports).toHaveLength(1);
		const aliasImport = aliasImports[0];

		expect(aliasImport).toBeDefined();
		expect(aliasImport.referencingFilePath).toBe(importerAliasPath);
		expect(aliasImport.resolvedPath).toBe(targetFilePath);
		expect(aliasImport.originalSpecifierText).toBe("@/target");
		expect(aliasImport.declaration.getKindName()).toBe("ImportDeclaration");
		expect(aliasImport.wasPathAlias).toBe(true); // alias should be detected
	});

	it("finds an ExportDeclaration re-exporting via a barrel file", async () => {
		const { project, targetFile, targetFilePath, barrelFilePath } =
			setupTestProject();
		const results = await findDeclarationsReferencingFile(targetFile);

		// Identify the exports from the barrel file
		const exportDeclarations = results.filter(
			(r) => r.referencingFilePath === barrelFilePath,
		);
		expect(exportDeclarations).toHaveLength(2);

		const valueExport = exportDeclarations.find((r) =>
			r.declaration.getText().includes("targetSymbol"),
		);
		expect(valueExport).toBeDefined();
		expect(valueExport?.referencingFilePath).toBe(barrelFilePath);
		expect(valueExport?.resolvedPath).toBe(targetFilePath);
		expect(valueExport?.originalSpecifierText).toBe("./target");
		expect(valueExport?.declaration.getKindName()).toBe("ExportDeclaration");
		expect(valueExport?.wasPathAlias).toBe(false);

		const typeExport = exportDeclarations.find((r) =>
			r.declaration.getText().includes("TargetType"),
		);
		expect(typeExport).toBeDefined();
		expect(typeExport?.referencingFilePath).toBe(barrelFilePath);
		expect(typeExport?.resolvedPath).toBe(targetFilePath);
		expect(typeExport?.originalSpecifierText).toBe("./target");
		expect(typeExport?.declaration.getKindName()).toBe("ExportDeclaration");
		expect(typeExport?.wasPathAlias).toBe(false);
	});

	// Because findDeclarationsReferencingFile uses getReferencingSourceFiles,
	// references via barrel files cannot be found (this is expected behavior)
	it("cannot find imports that go through a barrel file (by design of getReferencingSourceFiles)", async () => {
		const { project, targetFile, importerBarrelPath } = setupTestProject();
		const results = await findDeclarationsReferencingFile(targetFile);

		// Confirm that the results do not include an import from importerBarrelPath
		const barrelImport = results.find(
			(r) => r.referencingFilePath === importerBarrelPath,
		);
		expect(barrelImport).toBeUndefined();
	});

	it("returns an empty array when there are no references to the target file", async () => {
		const { project } = setupTestProject();
		// Create a file with no references
		const unreferencedFile = project.createSourceFile(
			"/src/unreferenced.ts",
			"export const x = 1;",
		);
		const results = await findDeclarationsReferencingFile(unreferencedFile);
		expect(results).toHaveLength(0);
	});

	it("finds both when Import and Export declarations are mixed", async () => {
		const { project, targetFile, targetFilePath } = setupTestProject();
		// Add another file that both imports and exports from target
		const mixedRefPath = "/src/mixed-ref.ts";
		project.createSourceFile(
			mixedRefPath,
			`
			import { targetSymbol } from './target';
			export { TargetType } from './target';
			console.log(targetSymbol);
		`,
		);
		const results = await findDeclarationsReferencingFile(targetFile);

		// Expect 2 declarations from mixedRefPath plus other declarations from setup
		const mixedRefs = results.filter(
			(r) => r.referencingFilePath === mixedRefPath,
		);
		expect(mixedRefs).toHaveLength(2);

		const importDecl = mixedRefs.find(
			(d) => d.declaration.getKindName() === "ImportDeclaration",
		);
		const exportDecl = mixedRefs.find(
			(d) => d.declaration.getKindName() === "ExportDeclaration",
		);
		expect(importDecl).toBeDefined();
		expect(exportDecl).toBeDefined();
	});
});
