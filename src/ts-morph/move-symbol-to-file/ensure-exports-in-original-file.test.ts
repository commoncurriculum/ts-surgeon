import { describe, it, expect, vi } from "vitest";
import { createInMemoryProject } from "../_test-utils/create-in-memory-project";
import type { DependencyClassification } from "../types";
import { ensureExportsInOriginalFile } from "./ensure-exports-in-original-file";
import logger from "../../utils/logger";

vi.mock("../../utils/logger");

describe("ensureExportsInOriginalFile", () => {
	it("adds the export keyword for an addExport-type dependency that is not yet exported", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"original.ts",
			"const dep1 = 1;\nfunction dep2() {}",
		);
		const dep1Statement = sourceFile.getVariableStatementOrThrow("dep1");
		const dep2Statement = sourceFile.getFunctionOrThrow("dep2");

		const classifiedDependencies: DependencyClassification[] = [
			{
				type: "addExport",
				name: "dep1",
				statement: dep1Statement,
			},
			{
				type: "addExport",
				name: "dep2",
				statement: dep2Statement,
			},
		];

		ensureExportsInOriginalFile(classifiedDependencies, "original.ts");

		expect(dep1Statement.isExported()).toBe(true);
		expect(dep2Statement.isExported()).toBe(true);
		expect(sourceFile.getFullText()).toBe(
			"export const dep1 = 1;\nexport function dep2() {}",
		);
	});

	it("makes no change for an addExport-type dependency that is already exported", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"original.ts",
			"export const dep1 = 1;\nexport function dep2() {}",
		);
		const dep1Statement = sourceFile.getVariableStatementOrThrow("dep1");
		const dep2Statement = sourceFile.getFunctionOrThrow("dep2");

		const originalText = sourceFile.getFullText();

		const classifiedDependencies: DependencyClassification[] = [
			{
				type: "addExport",
				name: "dep1",
				statement: dep1Statement,
			},
			{
				type: "addExport",
				name: "dep2",
				statement: dep2Statement,
			},
		];

		ensureExportsInOriginalFile(classifiedDependencies, "original.ts");

		expect(dep1Statement.isExported()).toBe(true);
		expect(dep2Statement.isExported()).toBe(true);
		expect(sourceFile.getFullText()).toBe(originalText); // verify no change
	});

	it("ignores dependencies that are not of addExport type", () => {
		const project = createInMemoryProject();
		const sourceFile = project.createSourceFile(
			"original.ts",
			"const dep1 = 1;",
		);
		const dep1Statement = sourceFile.getVariableStatementOrThrow("dep1");

		const originalText = sourceFile.getFullText();

		const classifiedDependencies: DependencyClassification[] = [
			{
				type: "moveToNewFile", // not addExport
				statement: dep1Statement,
			},
		];

		ensureExportsInOriginalFile(classifiedDependencies, "original.ts");

		expect(dep1Statement.isExported()).toBe(false);
		expect(sourceFile.getFullText()).toBe(originalText);
	});

	it("logs a warning for a non-exportable node", () => {
		const project = createInMemoryProject();
		// a statement that cannot be exported (e.g., a labeled statement)
		const sourceFile = project.createSourceFile(
			"original.ts",
			"myLabel: for (let i = 0; i < 1; i++) {}",
		);
		const labeledStatement = sourceFile.getStatements()[0];

		const classifiedDependencies: DependencyClassification[] = [
			{
				type: "addExport",
				name: "myLabel", // arbitrary name
				statement: labeledStatement,
			},
		];

		ensureExportsInOriginalFile(classifiedDependencies, "original.ts");

		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"Attempted to add export to a non-exportable node",
			),
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining(labeledStatement.getKindName()),
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("myLabel"),
		);
	});
});
