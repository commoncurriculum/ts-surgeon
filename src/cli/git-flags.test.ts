import { spawnSync } from "node:child_process";
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

describe("call --git-changed / --git-staged", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let srcDir: string;

	beforeEach(() => {
		// realpathSync canonicalizes the path: on macOS os.tmpdir() is under
		// the /var -> /private/var symlink, but `git rev-parse --show-toplevel`
		// always reports the canonical path. Without this the diff paths (under
		// /private/var) would not match the project files (under /var) and the
		// tool would find no source files to process.
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "tsurgeon-gitflags-")),
		);
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*"],
			}),
		);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function git(...args: string[]): void {
		const result = spawnSync("git", args, {
			cwd: tempDir,
			encoding: "utf-8",
		});
		expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
	}

	function setUpRepo(): { mPath: string; appPath: string } {
		const mPath = path.join(srcDir, "m.ts");
		const appPath = path.join(srcDir, "app.ts");
		fs.writeFileSync(mPath, "export const used = 1;\nexport const dead = 2;\n");
		fs.writeFileSync(
			appPath,
			'import { used } from "./m";\nconsole.log(used);\n',
		);
		fs.writeFileSync(path.join(tempDir, "notes.md"), "initial\n");
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		git("add", ".");
		git("commit", "-qm", "init");
		return { mPath, appPath };
	}

	it("--git-changed scopes filePaths to the unstaged TS/JS changes", async () => {
		const { mPath, appPath } = setUpRepo();
		// app.ts gains an unused import; a non-source file changes too
		fs.writeFileSync(
			appPath,
			'import { used, dead } from "./m";\nconsole.log(used);\n',
		);
		fs.writeFileSync(path.join(tempDir, "notes.md"), "changed\n");

		const out = createCapture();
		const err = createCapture();
		const code = await runCli(
			[
				"call",
				"organize_imports",
				"--git-changed",
				"--tsconfig-path",
				tsconfigPath,
			],
			out,
			err,
			{ cwd: tempDir },
		);
		expect(err.text).toBe("");
		expect(code).toBe(0);

		expect(fs.readFileSync(appPath, "utf-8")).not.toContain("dead");
		// the unchanged file was not processed
		expect(fs.readFileSync(mPath, "utf-8")).toContain("dead");
	});

	it("--git-staged uses the staged diff", async () => {
		const { appPath } = setUpRepo();
		fs.writeFileSync(
			appPath,
			'import { used, dead } from "./m";\nconsole.log(used);\n',
		);
		git("add", "src/app.ts");

		const out = createCapture();
		const err = createCapture();
		const code = await runCli(
			[
				"call",
				"organize_imports",
				"--git-staged",
				"--tsconfig-path",
				tsconfigPath,
			],
			out,
			err,
			{ cwd: tempDir },
		);
		expect(err.text).toBe("");
		expect(code).toBe(0);

		expect(fs.readFileSync(appPath, "utf-8")).not.toContain("dead");
	});

	it("exits 2 when the diff lists no TS/JS source files", async () => {
		setUpRepo();
		fs.writeFileSync(path.join(tempDir, "notes.md"), "changed\n");

		const err = createCapture();
		const code = await runCli(
			["call", "organize_imports", "--git-changed"],
			createCapture(),
			err,
			{ cwd: tempDir },
		);
		expect(code).toBe(2);
		expect(err.text).toContain("no existing TS/JS source files");
	});

	it("exits 2 outside a git repository", async () => {
		// tempDir has no git repo unless setUpRepo() ran
		const err = createCapture();
		const code = await runCli(
			["call", "organize_imports", "--git-changed"],
			createCapture(),
			err,
			{ cwd: tempDir },
		);
		expect(code).toBe(2);
		expect(err.text).toContain("not inside a git repository");
	});

	it("exits 2 when combined with another file-list flag", async () => {
		const err = createCapture();
		const code = await runCli(
			["call", "organize_imports", "--git-changed", "--git-staged"],
			createCapture(),
			err,
		);
		expect(code).toBe(2);
		expect(err.text).toContain("at most one of");
	});
});
