import { expect } from "vitest";
import { Project } from "ts-morph";
import * as path from "node:path";
import { prepareTarget } from "./prepare-target";
import {
	assertNoRegression,
	checkHealth,
	type HealthResult,
	resetTarget,
} from "./verify-target";
import { createToolHarness, type ToolResult } from "./call-tool";
import { targetCheckoutDir, type TargetRepo } from "./targets";

export { prepareTarget } from "./prepare-target";
export {
	checkHealth,
	assertNoRegression,
	resetTarget,
	isWorkingTreeClean,
	type HealthResult,
	type RegressionResult,
} from "./verify-target";
export { createToolHarness, type ToolResult } from "./call-tool";

/** Concatenates the text content of a ToolResult. */
export function textOf(result: ToolResult): string {
	return result.content.map((c) => c.text).join("\n");
}

export interface TargetScenario {
	harness: ReturnType<typeof createToolHarness>;
	/** Prepares the target repository and captures the baseline (call in beforeAll). */
	setup: () => void;
	/** Restores the working tree changed by refactoring (call in afterEach). */
	reset: () => void;
	/** Skips the current test case if preparation failed. */
	requirePrepared: (ctx: { skip: (note?: string) => void }) => void;
	/** Asserts that there is no regression from the baseline after refactoring. */
	expectNoRegression: () => void;
}

/**
 * When E2E_REQUIRE_PREPARED is set, turns preparation failures into hard failures
 * instead of skips. This guards against the CI (nightly) silently passing as green
 * when all tests are skipped due to a missing bun or network failure. Locally the
 * variable is unset, so the previous skip behavior is preserved.
 */
function preparationIsMandatory(): boolean {
	const v = process.env.E2E_REQUIRE_PREPARED;
	return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/**
 * Creates the per-target-repository E2E scenario state (harness / baseline)
 * along with shared lifecycle helpers and assertions.
 * Register beforeAll(setup) / afterEach(reset) in the test file.
 */
export function createScenario(target: TargetRepo): TargetScenario {
	const harness = createToolHarness();
	let baseline: HealthResult | undefined;

	return {
		harness,
		setup() {
			try {
				prepareTarget(target);
				baseline = checkHealth(target);
			} catch (e) {
				if (preparationIsMandatory()) throw e;
				// If clone / install fails (e.g. no network or bun not found),
				// leave baseline undefined and skip each test case.
				baseline = undefined;
			}
		},
		reset() {
			if (baseline) resetTarget(target);
		},
		requirePrepared(ctx) {
			if (baseline) return;
			if (preparationIsMandatory()) {
				throw new Error(
					`${target.name} E2E preparation failed (E2E_REQUIRE_PREPARED is set — failing instead of skipping)`,
				);
			}
			ctx.skip(
				`${target.name} preparation (clone/install/baseline) failed — skipping`,
			);
		},
		expectNoRegression() {
			const reg = assertNoRegression(
				baseline as HealthResult,
				checkHealth(target),
			);
			expect(reg.ok, reg.detail).toBe(true);
		},
	};
}

export interface Position {
	line: number;
	column: number;
}

/**
 * Uses ts-morph to compute the position (1-based line/column) of the name
 * identifier of an export declaration within the target repository.
 * The result is stable because the version is pinned, and this is more
 * readable and robust than hard-coding line numbers.
 */
export function locateSymbolPosition(
	target: TargetRepo,
	relFilePath: string,
	symbolName: string,
): { absFilePath: string; position: Position } {
	const dir = targetCheckoutDir(target);
	const tsconfigPath = path.join(dir, target.tsconfigRelPath);
	const absFilePath = path.join(dir, relFilePath);

	const project = new Project({ tsConfigFilePath: tsconfigPath });
	const sf = project.getSourceFile(absFilePath);
	if (!sf) {
		throw new Error(
			`[e2e] ${target.name}: ${relFilePath} is not included in the tsconfig project (${target.tsconfigRelPath})`,
		);
	}

	const decl =
		sf.getVariableDeclaration(symbolName) ??
		sf.getFunction(symbolName) ??
		sf.getClass(symbolName) ??
		sf.getInterface(symbolName) ??
		sf.getTypeAlias(symbolName);
	if (!decl) {
		throw new Error(
			`[e2e] ${target.name}: export '${symbolName}' not found in ${relFilePath}`,
		);
	}

	const nameNode = decl.getNameNode();
	const { line, column } = sf.getLineAndColumnAtPos(nameNode.getStart());
	return { absFilePath, position: { line, column } };
}

export function absPath(target: TargetRepo, relPath: string): string {
	return path.join(targetCheckoutDir(target), relPath);
}

export function tsconfigPathOf(target: TargetRepo): string {
	return path.join(targetCheckoutDir(target), target.tsconfigRelPath);
}
