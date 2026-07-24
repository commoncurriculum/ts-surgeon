import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import {
	findDeclarationIdentifiersByName,
	resolveProjectWideDeclaration,
	resolveTargetIdentifier,
} from "./resolve-identifier.js";

/**
 * A CSS-module import is typed as an index signature, so `styles.lessonTitle`
 * has no resolvable symbol to dedupe on — the shape that let property reads
 * masquerade as declarations in the wild.
 */
const setupCssModuleProject = () => {
	const project = new Project({ useInMemoryFileSystem: true });
	project.createSourceFile(
		"/src/styles.d.ts",
		`declare const styles: Record<string, string>;
export default styles;`,
	);
	project.createSourceFile(
		"/src/extension.ts",
		`import styles from './styles';
export const attrs = { class: styles.lessonTitle };`,
	);
	project.createSourceFile(
		"/src/component.ts",
		`import styles from './styles';
export const className = styles.lessonTitle;`,
	);
	return project;
};

describe("resolveProjectWideDeclaration", () => {
	it("does not treat property reads as declarations", () => {
		const project = setupCssModuleProject();

		expect(() =>
			resolveProjectWideDeclaration(project, "lessonTitle"),
		).toThrowError(/No declaration named 'lessonTitle'/);
	});

	it("resolves to the declared property, not the object literal that fills it in", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		project.createSourceFile(
			"/src/config.ts",
			`export interface Config { lessonTitle: string }
export const config: Config = { lessonTitle: 'x' };`,
		);
		project.createSourceFile(
			"/src/read.ts",
			`import { config } from './config';
export const title = config.lessonTitle;`,
		);

		const declaration = resolveProjectWideDeclaration(project, "lessonTitle");

		expect(declaration.getSourceFile().getFilePath()).toBe("/src/config.ts");
		expect(declaration.getParent()?.getKindName()).toBe("PropertySignature");
	});

	it("resolves an overloaded function to its implementation", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		project.createSourceFile(
			"/src/overload.ts",
			`export function parse(a: string): number;
export function parse(a: number): number;
export function parse(a: unknown): number { return Number(a) }`,
		);

		const declaration = resolveProjectWideDeclaration(project, "parse");

		expect(declaration.getStartLineNumber()).toBe(3);
	});

	it("keeps a free-standing object literal key as its own declaration", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		project.createSourceFile("/src/a.ts", "export const a = { shared: 1 };");
		project.createSourceFile("/src/b.ts", "export const b = { shared: 2 };");

		expect(() => resolveProjectWideDeclaration(project, "shared")).toThrowError(
			/'shared' has 2 declarations/,
		);
	});

	it("still reports genuinely rival declarations as ambiguous", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		project.createSourceFile("/src/one.ts", "export const helper = 1;");
		project.createSourceFile("/src/two.ts", "export function helper() {}");

		expect(() => resolveProjectWideDeclaration(project, "helper")).toThrowError(
			/'helper' has 2 declarations/,
		);
	});
});

describe("resolveTargetIdentifier", () => {
	/**
	 * The recovery path from an ambiguity error is "pass targetFilePath", so a
	 * file-scoped lookup must not demand a position for a rivalry the
	 * project-wide lookup just collapsed.
	 */
	it("agrees with the project-wide lookup about what counts as one declaration", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		project.createSourceFile(
			"/src/config.ts",
			`export interface Config { lessonTitle: string }
export const config: Config = { lessonTitle: 'x' };`,
		);

		const declaration = resolveTargetIdentifier(project, "/src/config.ts", {
			symbolName: "lessonTitle",
		});

		expect(declaration.getParent()?.getKindName()).toBe("PropertySignature");
	});
});

describe("findDeclarationIdentifiersByName", () => {
	it("ignores property reads in the target file", () => {
		const project = setupCssModuleProject();

		expect(
			findDeclarationIdentifiersByName(
				project,
				"/src/extension.ts",
				"lessonTitle",
			),
		).toEqual([]);
	});

	it("ignores the right-hand side of a qualified type name", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		project.createSourceFile(
			"/src/ns.ts",
			"export namespace Outer { export type Inner = string }",
		);
		project.createSourceFile(
			"/src/use.ts",
			`import { Outer } from './ns';
export type Alias = Outer.Inner;`,
		);

		expect(
			findDeclarationIdentifiersByName(project, "/src/use.ts", "Inner"),
		).toEqual([]);
	});

	it("still finds a real declaration in the target file", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		project.createSourceFile(
			"/src/config.ts",
			"export interface Config { lessonTitle: string }",
		);

		const declarations = findDeclarationIdentifiersByName(
			project,
			"/src/config.ts",
			"lessonTitle",
		);

		expect(declarations).toHaveLength(1);
		expect(declarations[0]?.getParent()?.getKindName()).toBe(
			"PropertySignature",
		);
	});
});
