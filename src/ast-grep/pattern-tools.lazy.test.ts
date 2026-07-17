import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli";

// Simulates a platform without a prebuilt @ast-grep/napi binary: the module
// throws at load time. Because the pattern tools load it lazily, only they
// may fail — every other command must keep working.
vi.mock("@ast-grep/napi", () => {
	throw new Error("Cannot find native binding");
});

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

describe("lazy @ast-grep/napi loading", () => {
	let tempDir: string;
	let tsconfigPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsurgeon-lazy-"));
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		const srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*"],
			}),
		);
		fs.writeFileSync(path.join(srcDir, "a.ts"), 'console.log("x");\n');
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("list still works when the native binary cannot load", async () => {
		const out = createCapture();
		const code = await runCli(["list"], out, createCapture());
		expect(code).toBe(0);
		expect(out.text).toContain("search_pattern");
		expect(out.text).toContain("rename_symbol");
	});

	it("other tools still run when the native binary cannot load", async () => {
		const goodPath = path.join(tempDir, "src", "a.ts");
		const out = createCapture();
		const code = await runCli(
			[
				"call",
				"get_diagnostics",
				"--params",
				JSON.stringify({ tsconfigPath, filePaths: [goodPath] }),
			],
			out,
			createCapture(),
		);
		expect(code).toBe(0);
		expect(out.text).toContain("No diagnostics");
	});

	it("doctor reports the broken binary and exits 1", async () => {
		const out = createCapture();
		const code = await runCli(["doctor"], out, createCapture());
		expect(code).toBe(1);
		expect(out.text).toContain("ast-grep native binary: FAILED");
		expect(out.text).toContain(
			"search_pattern / rewrite_pattern are unavailable",
		);
	});

	it("call rewrite_where degrades the same way as the other pattern tools", async () => {
		const out = createCapture();
		const code = await runCli(
			[
				"call",
				"rewrite_where",
				"--params",
				JSON.stringify({
					tsconfigPath,
					pattern: "$X.close()",
					rewrite: "shutdown($X)",
					where: { capture: "X", type: "DbConnection" },
				}),
			],
			out,
			createCapture(),
		);
		expect(code).toBe(1);
		expect(out.text).toContain("@ast-grep/napi");
	});

	it("call search_pattern exits 1 with a message naming the platform issue", async () => {
		const out = createCapture();
		const code = await runCli(
			[
				"call",
				"search_pattern",
				"--params",
				JSON.stringify({ tsconfigPath, pattern: "console.log($$$A)" }),
			],
			out,
			createCapture(),
		);
		expect(code).toBe(1);
		expect(out.text).toContain("@ast-grep/napi");
		expect(out.text).toContain(`${process.platform}-${process.arch}`);
		expect(out.text).toContain("every other ts-surgeon tool still works");
	});
});
