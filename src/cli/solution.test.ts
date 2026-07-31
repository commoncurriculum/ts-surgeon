import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";

function createCapture() {
	let buffer = "";
	return {
		write(chunk: string) {
			buffer += chunk;
			return true;
		},
		get text() {
			return buffer;
		},
	};
}

describe("solution-style tsconfigs (--all-projects)", () => {
	let tempDir: string;
	let solutionPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsurgeon-solution-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSolution(): void {
		const monoDir = path.join(tempDir, "mono");
		solutionPath = path.join(monoDir, "tsconfig.json");
		for (const pkg of ["pkg-a", "pkg-b"]) {
			const pkgSrc = path.join(monoDir, pkg, "src");
			fs.mkdirSync(pkgSrc, { recursive: true });
			fs.writeFileSync(
				path.join(monoDir, pkg, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { strict: true, composite: true },
					include: ["src/**/*"],
				}),
			);
		}
		fs.writeFileSync(
			path.join(monoDir, "pkg-a", "src", "a.ts"),
			"export const ok: number = 1;\n",
		);
		fs.writeFileSync(
			path.join(monoDir, "pkg-b", "src", "b.ts"),
			"export const bad: number = 'oops';\n",
		);
		fs.writeFileSync(
			solutionPath,
			// tsconfig JSON allows comments — the reader must cope
			`{\n\t// solution root\n\t"files": [],\n\t"references": [{ "path": "./pkg-a" }, { "path": "./pkg-b" }]\n}\n`,
		);
	}

	function writePlainProject(): string {
		const plainTsconfig = path.join(tempDir, "tsconfig.json");
		fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
		fs.writeFileSync(
			plainTsconfig,
			JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*"],
			}),
		);
		return plainTsconfig;
	}

	it("fans a read-only tool across the referenced projects by default", async () => {
		// Defect report, 2026-07-29: the old behavior warned on every single
		// invocation and told the caller to re-run with a flag, for the only
		// behavior that could have been meant. Fanning out is now the default and
		// the note just says what happened.
		writeSolution();
		const out = createCapture();
		const err = createCapture();

		const code = await runCli(
			["call", "get_diagnostics", "--tsconfig-path", solutionPath],
			out,
			err,
		);

		expect(code).toBe(0);
		expect(err.text).toContain("solution-style tsconfig");
		expect(err.text).toContain("--single-project");
		expect(out.text).toContain(path.join("pkg-a", "tsconfig.json"));
		expect(out.text).toContain(path.join("pkg-b", "tsconfig.json"));
	});

	it("--single-project opts out of the fan-out", async () => {
		writeSolution();
		const out = createCapture();
		const err = createCapture();

		const code = await runCli(
			[
				"call",
				"get_diagnostics",
				"--single-project",
				"--tsconfig-path",
				solutionPath,
			],
			out,
			err,
		);

		expect(code).toBe(0);
		expect(err.text).toContain("solution-style tsconfig");
		expect(out.text).not.toContain(path.join("pkg-b", "tsconfig.json"));
	});

	it("still warns for a mutating tool, which cannot fan out", async () => {
		writeSolution();
		const out = createCapture();
		const err = createCapture();

		await runCli(
			[
				"call",
				"organize_imports",
				"--tsconfig-path",
				solutionPath,
				"--file-paths",
				path.join(tempDir, "mono", "pkg-a", "src", "index.ts"),
			],
			out,
			err,
		);

		expect(err.text).toContain("solution-style tsconfig");
		expect(err.text).toContain(path.join("pkg-a", "tsconfig.json"));
	});

	it("--all-projects runs a read-only tool per referenced project inside the standard envelope", async () => {
		writeSolution();
		const out = createCapture();
		const err = createCapture();

		const code = await runCli(
			[
				"call",
				"get_diagnostics",
				"--all-projects",
				"--json",
				"--tsconfig-path",
				solutionPath,
			],
			out,
			err,
		);

		expect(code).toBe(0);
		const parsed = JSON.parse(out.text);
		// the standard { tool, status, data, message } envelope holds
		expect(parsed.tool).toBe("get_diagnostics");
		expect(parsed.status).toBe("success");
		expect(typeof parsed.message).toBe("string");
		expect(parsed.data.byProject).toHaveLength(2);
		const [a, b] = parsed.data.byProject;
		expect(a.tsconfigPath).toContain("pkg-a");
		expect(a.message).toContain("No diagnostics");
		expect(b.tsconfigPath).toContain("pkg-b");
		expect(b.message).toContain("TS2322");
		// the solution root's own (empty) project is not run
		expect(
			parsed.data.byProject.some(
				(p: { tsconfigPath: string }) => p.tsconfigPath === solutionPath,
			),
		).toBe(false);
	});

	it("keeps the tool's own array fields readable at the top of data", async () => {
		// Fanning out used to replace data with { byProject } alone. Once fan-out
		// became the default, `data.diagnostics` against a solution config silently
		// became undefined for every existing --json consumer.
		writeSolution();
		const out = createCapture();
		const err = createCapture();

		const code = await runCli(
			["call", "get_diagnostics", "--json", "--tsconfig-path", solutionPath],
			out,
			err,
		);

		expect(code).toBe(0);
		const parsed = JSON.parse(out.text);
		expect(parsed.data.byProject).toHaveLength(2);
		// pkg-b's TS2322 is reachable without walking byProject by hand.
		expect(Array.isArray(parsed.data.diagnostics)).toBe(true);
		expect(
			parsed.data.diagnostics.some((d: { code?: number }) => d.code === 2322),
		).toBe(true);
		// Scalars are not invented: they have no single value across projects.
		expect(parsed.data.scannedFiles).toBeUndefined();
	});

	it("--all-projects text output sections results per project", async () => {
		writeSolution();
		const out = createCapture();

		const code = await runCli(
			[
				"call",
				"get_diagnostics",
				"--all-projects",
				"--tsconfig-path",
				solutionPath,
			],
			out,
			createCapture(),
		);

		expect(code).toBe(0);
		expect(out.text).toContain(
			`## ${path.join(tempDir, "mono", "pkg-a", "tsconfig.json")}`,
		);
		expect(out.text).toContain("TS2322");
	});

	it("--all-projects rejects mutating tools with a usage error", async () => {
		writeSolution();
		const err = createCapture();

		const code = await runCli(
			[
				"call",
				"organize_imports",
				"--all-projects",
				"--tsconfig-path",
				solutionPath,
			],
			createCapture(),
			err,
		);

		expect(code).toBe(2);
		expect(err.text).toContain("must run against a single project's tsconfig");
	});

	it("does not fail the fan-out when the target file belongs to one referenced project", async () => {
		// The most common monorepo lookup: solution tsconfig + a targetFilePath
		// inside one referenced project. The other projects answer "not part of
		// this project" — an expected property of fanning out, not an error of
		// the call (caught in review, 2026-07-31: a fully correct answer exited 1).
		writeSolution();
		const out = createCapture();
		const err = createCapture();

		const code = await runCli(
			[
				"call",
				"find_references",
				"--json",
				"--tsconfig-path",
				solutionPath,
				"--target-file-path",
				path.join(tempDir, "mono", "pkg-a", "src", "a.ts"),
				"--symbol-name",
				"ok",
			],
			out,
			err,
		);

		expect(code).toBe(0);
		const parsed = JSON.parse(out.text);
		expect(parsed.status).toBe("success");
		const statuses = parsed.data.byProject.map(
			(p: { status: string }) => p.status,
		);
		expect(statuses).toContain("success");
		expect(statuses).toContain("skipped");
		expect(statuses).not.toContain("error");
		// The miss keeps its cause visible, without the envelope's framing.
		const skipped = parsed.data.byProject.find(
			(p: { status: string }) => p.status === "skipped",
		);
		expect(skipped.message).toContain("not part of the TypeScript project");
	});

	it("keeps expected misses as errors when no project succeeds", async () => {
		writeSolution();
		const out = createCapture();
		const err = createCapture();

		const code = await runCli(
			[
				"call",
				"find_references",
				"--json",
				"--tsconfig-path",
				solutionPath,
				"--symbol-name",
				"doesNotExistAnywhere",
			],
			out,
			err,
		);

		expect(code).toBe(1);
		const parsed = JSON.parse(out.text);
		expect(parsed.status).toBe("error");
	});

	it("merges structurally identical items from different projects once", async () => {
		// A file included by two referenced projects reports the same diagnostic
		// from each; concatenation without dedupe makes one problem read as two.
		const monoDir = path.join(tempDir, "mono");
		solutionPath = path.join(monoDir, "tsconfig.json");
		const sharedDir = path.join(monoDir, "shared");
		fs.mkdirSync(sharedDir, { recursive: true });
		fs.writeFileSync(
			path.join(sharedDir, "shared.ts"),
			"export const bad: number = 'oops';\n",
		);
		for (const pkg of ["pkg-a", "pkg-b"]) {
			const pkgDir = path.join(monoDir, pkg);
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { strict: true, composite: true },
					include: ["../shared/**/*"],
				}),
			);
		}
		fs.writeFileSync(
			solutionPath,
			JSON.stringify({
				files: [],
				references: [{ path: "./pkg-a" }, { path: "./pkg-b" }],
			}),
		);
		const out = createCapture();

		const code = await runCli(
			["call", "get_diagnostics", "--json", "--tsconfig-path", solutionPath],
			out,
			createCapture(),
		);

		expect(code).toBe(0); // reporting diagnostics is a successful lookup
		const parsed = JSON.parse(out.text);
		const shared = parsed.data.diagnostics.filter(
			(d: { code?: number }) => d.code === 2322,
		);
		expect(shared).toHaveLength(1);
	});

	it("--all-projects on a non-solution tsconfig is a usage error", async () => {
		const plainTsconfig = writePlainProject();
		const err = createCapture();

		const code = await runCli(
			[
				"call",
				"get_diagnostics",
				"--all-projects",
				"--tsconfig-path",
				plainTsconfig,
			],
			createCapture(),
			err,
		);

		expect(code).toBe(2);
		expect(err.text).toContain('no "references"');
	});
});
