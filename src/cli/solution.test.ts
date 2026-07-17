import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli";

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

	it("warns on stderr when the tsconfig is solution-style and --all-projects is absent", async () => {
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
		expect(err.text).toContain("--all-projects");
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
		expect(err.text).toContain("read-only tools only");
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
