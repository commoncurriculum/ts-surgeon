import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RunResult, run as runChild } from "./_child-process";
import { type TargetRepo, targetCheckoutDir } from "./targets";

export interface HealthResult {
	/** Number of type errors reported by tsc. */
	typeErrorCount: number;
	/** Set of failed unit test identifiers ("file > suite > test"). */
	failedTests: string[];
	/** Diagnostic output for failures (tail of type-check and test output). */
	detail: string;
}

function binPath(dir: string, bin: string): string {
	return path.join(dir, "node_modules", ".bin", bin);
}

/** Verification child processes always run in CI mode with colors disabled. */
function run(cmd: string, args: readonly string[], cwd: string): RunResult {
	return runChild(cmd, args, cwd, { CI: "true", FORCE_COLOR: "0" });
}

function tail(text: string, lines = 40): string {
	return text.split("\n").slice(-lines).join("\n");
}

function countTypeErrors(output: string, ok: boolean): number {
	if (ok) return 0;
	const matches = output.match(/error TS\d+/g);
	return matches ? matches.length : 0;
}

interface VitestJsonAssertion {
	ancestorTitles?: string[];
	title?: string;
	fullName?: string;
	status?: string;
}
interface VitestJsonFile {
	name?: string;
	assertionResults?: VitestJsonAssertion[];
}
interface VitestJson {
	testResults?: VitestJsonFile[];
}

function parseFailedTests(jsonFile: string, repoDir: string): string[] {
	if (!fs.existsSync(jsonFile)) return [];
	let parsed: VitestJson;
	try {
		parsed = JSON.parse(fs.readFileSync(jsonFile, "utf-8")) as VitestJson;
	} catch {
		return [];
	}
	const failed: string[] = [];
	for (const file of parsed.testResults ?? []) {
		const rel = file.name ? path.relative(repoDir, file.name) : "";
		for (const a of file.assertionResults ?? []) {
			if (a.status === "failed") {
				const name =
					a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(" > ");
				failed.push(`${rel} > ${name}`);
			}
		}
	}
	return failed.sort();
}

/**
 * Captures the health of the target repository (type error count + set of failing tests).
 * Absolute green is not required; this result is compared before and after refactoring
 * (differential green).
 */
export function checkHealth(target: TargetRepo): HealthResult {
	const dir = targetCheckoutDir(target);

	const type = run(
		binPath(dir, target.typecheckBin),
		target.typecheckArgs,
		dir,
	);

	const jsonFile = path.join(
		os.tmpdir(),
		`e2e-${target.name}-${process.pid}-${Date.now()}.json`,
	);
	const tests = run(
		binPath(dir, target.unitTestBin),
		[
			...target.unitTestArgs,
			"--reporter=json",
			"--outputFile",
			jsonFile,
			"--coverage.enabled=false",
		],
		dir,
	);
	const failedTests = parseFailedTests(jsonFile, dir);
	fs.rmSync(jsonFile, { force: true });

	return {
		typeErrorCount: countTypeErrors(type.output, type.ok),
		failedTests,
		detail: [
			`--- typecheck (${target.typecheckBin} ${target.typecheckArgs.join(" ")}) ok=${type.ok} ---`,
			tail(type.output),
			`--- unit tests (${target.unitTestBin} ${target.unitTestArgs.join(" ")}) exitOk=${tests.ok} failed=${failedTests.length} ---`,
			tail(tests.output),
		].join("\n"),
	};
}

export interface RegressionResult {
	ok: boolean;
	detail: string;
}

/**
 * Determines whether the post-refactor state (after) has regressed relative to
 * the baseline (differential green).
 * - No new type errors (after type error count <= baseline).
 * - No newly failing tests (after failing tests ⊆ baseline failing tests).
 *
 * Environment-dependent tests that were already failing at baseline time are
 * not treated as regressions.
 */
export function assertNoRegression(
	baseline: HealthResult,
	after: HealthResult,
): RegressionResult {
	const newTypeErrors = after.typeErrorCount > baseline.typeErrorCount;
	const baselineFailed = new Set(baseline.failedTests);
	const newlyFailed = after.failedTests.filter((t) => !baselineFailed.has(t));

	const ok = !newTypeErrors && newlyFailed.length === 0;
	if (ok) {
		return { ok, detail: "No regression" };
	}
	return {
		ok,
		detail: [
			newTypeErrors
				? `New type errors: baseline=${baseline.typeErrorCount} -> after=${after.typeErrorCount}`
				: "",
			newlyFailed.length > 0
				? `Newly failing tests:\n  ${newlyFailed.join("\n  ")}`
				: "",
			"--- after detail ---",
			after.detail,
		]
			.filter(Boolean)
			.join("\n"),
	};
}

/**
 * Returns whether the working tree is clean (used to verify round-trip rename identity).
 */
export function isWorkingTreeClean(target: TargetRepo): boolean {
	const dir = targetCheckoutDir(target);
	const res = run("git", ["status", "--porcelain"], dir);
	return res.ok && res.output.trim() === "";
}

/**
 * Restores files changed by refactoring to their git-managed state.
 */
export function resetTarget(target: TargetRepo): void {
	const dir = targetCheckoutDir(target);
	const checkout = run("git", ["checkout", "-q", "--", "."], dir);
	if (!checkout.ok) {
		throw new Error(
			`[e2e] ${target.name}: git checkout failed\n${checkout.output}`,
		);
	}
	const clean = run("git", ["clean", "-fdq"], dir);
	if (!clean.ok) {
		throw new Error(`[e2e] ${target.name}: git clean failed\n${clean.output}`);
	}
}
