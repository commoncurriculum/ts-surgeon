import type { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import { findUnusedExports } from "./find-unused-exports";
import { collectPackageExportWarnings } from "./package-export-warnings";

/**
 * Minimal monorepo fixture:
 *
 * /packages/lib-src   exports → ./src/index.ts (direct source reference; cross-package references resolve correctly)
 * /packages/lib-dist  exports → ./dist/*       (built dist published; cross-package references cannot be resolved)
 * /apps/consumer      imports and consumes both
 *
 * `@scope/lib-src` is made resolvable via a paths alias; `@scope/lib-dist` is intentionally
 * left unresolvable to the scanned sources, mirroring a real monorepo setup.
 */
function setupMonorepoFixture(): Project {
	const project = createInMemoryProject({
		pathAliases: {
			"@scope/lib-src": ["packages/lib-src/src/index.ts"],
		},
	});
	const fs = project.getFileSystem();

	fs.writeFileSync(
		"/packages/lib-src/package.json",
		JSON.stringify({
			name: "@scope/lib-src",
			exports: { ".": "./src/index.ts" },
		}),
	);
	fs.writeFileSync(
		"/packages/lib-dist/package.json",
		JSON.stringify({
			name: "@scope/lib-dist",
			exports: {
				".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
			},
		}),
	);
	fs.writeFileSync(
		"/apps/consumer/package.json",
		JSON.stringify({ name: "@scope/consumer" }),
	);

	project.createSourceFile(
		"/packages/lib-src/src/index.ts",
		[
			"export function fromSrc(): number { return 1; }",
			"export function srcOnlyDead(): number { return 0; }",
		].join("\n"),
	);
	project.createSourceFile(
		"/packages/lib-dist/src/index.ts",
		"export function foo(): number { return 2; }",
	);
	project.createSourceFile(
		"/apps/consumer/src/main.ts",
		[
			'import { fromSrc } from "@scope/lib-src";',
			'import { foo } from "@scope/lib-dist";',
			"console.log(fromSrc(), foo());",
		].join("\n"),
	);
	return project;
}

describe("packageWarnings (structural warnings for packages that publish built dist)", () => {
	it("package that publishes dist via exports: consumed export appears as a candidate (false positive reproduced) and a package warning is attached", () => {
		const project = setupMonorepoFixture();
		const result = findUnusedExports(project);

		// false positive reproduction: foo is consumed by the consumer but still appears as a candidate
		const fooEntry = result.unusedExports.find((e) => e.name === "foo");
		expect(fooEntry).toBeDefined();
		expect(fooEntry?.filePath).toBe("/packages/lib-dist/src/index.ts");
		// the consumer's import appears in the text (= textHits signal)
		expect(fooEntry?.textOccurrences).toBeGreaterThanOrEqual(1);

		// structural warning: only for lib-dist
		expect(result.packageWarnings).toEqual([
			{
				packageJsonPath: "/packages/lib-dist/package.json",
				packageName: "@scope/lib-dist",
				externalEntryTargets: ["./dist/index.d.ts", "./dist/index.js"],
				candidateCount: 1,
			},
		]);
	});

	it("package whose exports point directly at source: cross-package references resolve, and truly unused candidates appear without a warning", () => {
		const project = setupMonorepoFixture();
		const result = findUnusedExports(project);

		// fromSrc is resolved cross-package, so it does not appear as a candidate
		expect(result.unusedExports.map((e) => e.name)).not.toContain("fromSrc");
		// srcOnlyDead is truly unused and appears as a candidate
		expect(result.unusedExports.map((e) => e.name)).toContain("srcOnlyDead");
		// lib-src does not get a warning because its exports resolve to scanned sources
		expect(result.packageWarnings.map((w) => w.packageName)).not.toContain(
			"@scope/lib-src",
		);
	});

	it("a single-package project does not produce a warning even if exports points at dist (no cross-package references exist)", () => {
		const project = createInMemoryProject();
		const fs = project.getFileSystem();
		fs.writeFileSync(
			"/package.json",
			JSON.stringify({ name: "single", exports: { ".": "./dist/index.js" } }),
		);
		project.createSourceFile(
			"/src/index.ts",
			"export function unused(): void {}",
		);
		project.createSourceFile("/src/other.ts", "export const used = 1;");
		project.createSourceFile(
			"/src/main.ts",
			'import { used } from "./other";\nconsole.log(used);',
		);

		const result = findUnusedExports(project);
		expect(result.unusedExports.map((e) => e.name)).toContain("unused");
		expect(result.packageWarnings).toEqual([]);
	});

	it("a project with no package.json anywhere produces no warnings", () => {
		const project = createInMemoryProject();
		project.createSourceFile("/a.ts", "export function unused(): void {}");
		project.createSourceFile("/b.ts", "const x = 1;");

		const result = findUnusedExports(project);
		expect(result.packageWarnings).toEqual([]);
	});

	describe("collectPackageExportWarnings (unit)", () => {
		function setupTwoPackages(libDistManifest: string): Project {
			const project = createInMemoryProject();
			const fs = project.getFileSystem();
			fs.writeFileSync("/packages/lib-dist/package.json", libDistManifest);
			fs.writeFileSync(
				"/apps/consumer/package.json",
				JSON.stringify({ name: "@scope/consumer" }),
			);
			project.createSourceFile(
				"/packages/lib-dist/src/index.ts",
				"export function foo(): number { return 2; }",
			);
			project.createSourceFile("/apps/consumer/src/main.ts", "const x = 1;");
			return project;
		}

		const scanned = [
			"/packages/lib-dist/src/index.ts",
			"/apps/consumer/src/main.ts",
		];
		const candidates = ["/packages/lib-dist/src/index.ts"];

		it("a package with no candidates does not produce a warning", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: { ".": "./dist/index.js" },
				}),
			);
			expect(collectPackageExportWarnings(project, scanned, [])).toEqual([]);
		});

		it("produces a warning when main points at dist even without an exports field", () => {
			const project = setupTwoPackages(
				JSON.stringify({ name: "@scope/lib-dist", main: "dist/index.js" }),
			);
			const warnings = collectPackageExportWarnings(
				project,
				scanned,
				candidates,
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatchObject({
				packageName: "@scope/lib-dist",
				externalEntryTargets: ["dist/index.js"],
				candidateCount: 1,
			});
		});

		it("a subpath pattern (`./*` → `./dist/*.js`) is also warned as a dist publication", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: { "./*": "./dist/*.js" },
				}),
			);
			const warnings = collectPackageExportWarnings(
				project,
				scanned,
				candidates,
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.externalEntryTargets).toEqual(["./dist/*.js"]);
		});

		it("a subpath pattern pointing under scanned sources (`./src/*`) does not produce a warning", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: { "./*": "./src/*" },
				}),
			);
			expect(
				collectPackageExportWarnings(project, scanned, candidates),
			).toEqual([]);
		});

		it("a warning is produced when at least one dist leaf exists even if another leaf resolves to source", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: {
						".": { source: "./src/index.ts", default: "./dist/index.js" },
					},
				}),
			);
			const warnings = collectPackageExportWarnings(
				project,
				scanned,
				candidates,
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.externalEntryTargets).toEqual(["./dist/index.js"]);
		});

		it("non-code entries (`./package.json` etc.) are ignored", () => {
			const project = setupTwoPackages(
				JSON.stringify({
					name: "@scope/lib-dist",
					exports: {
						".": "./src/index.ts",
						"./package.json": "./package.json",
					},
				}),
			);
			expect(
				collectPackageExportWarnings(project, scanned, candidates),
			).toEqual([]);
		});

		it("malformed package.json does not crash and produces no warning", () => {
			const project = setupTwoPackages("{ this is not json");
			expect(
				collectPackageExportWarnings(project, scanned, candidates),
			).toEqual([]);
		});

		it("packageName is undefined when package.json has no name field", () => {
			const project = setupTwoPackages(
				JSON.stringify({ exports: { ".": "./dist/index.js" } }),
			);
			const warnings = collectPackageExportWarnings(
				project,
				scanned,
				candidates,
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.packageName).toBeUndefined();
		});
	});
});
