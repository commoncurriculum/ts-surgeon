import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli";
import {
	ALLOW_MARKER,
	evaluateBashCommand,
	installClaudeHook,
	installOpencodeHook,
} from "./hook";

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

describe("evaluateBashCommand", () => {
	it("blocks in-place sed on TS/JS sources", () => {
		for (const command of [
			"sed -i 's/oldName/newName/g' src/utils.ts",
			"sed -i '' 's/a/b/' lib/component.tsx",
			"grep -rl oldName src | xargs sed -i 's/oldName/newName/g' # .ts files",
			"find src -name '*.ts' -exec sed -i 's/foo/bar/' {} +",
			"perl -pi -e 's/foo/bar/' src/index.js",
		]) {
			const verdict = evaluateBashCommand(command);
			expect(verdict.block, command).toBe(true);
			expect(verdict.reason).toContain("ts-surgeon");
		}
	});

	it("allows sed on non-source files and read-only sed", () => {
		for (const command of [
			"sed -i 's/foo/bar/' README.md",
			"sed -n '10,20p' src/utils.ts",
			"sed 's/foo/bar/' src/utils.ts > /tmp/out.txt",
		]) {
			expect(evaluateBashCommand(command).block, command).toBe(false);
		}
	});

	it("honors the escape hatch", () => {
		expect(
			evaluateBashCommand(
				`${ALLOW_MARKER} sed -i 's/oldName/newName/g' src/utils.ts`,
			).block,
		).toBe(false);
	});

	it("allows recursive identifier searches by default, blocks them in strict mode", () => {
		const command = "grep -rn calculateSum src/";
		expect(evaluateBashCommand(command).block).toBe(false);
		const strict = evaluateBashCommand(command, { strict: true });
		expect(strict.block).toBe(true);
		expect(strict.reason).toContain("find_references");
		// rg too
		expect(
			evaluateBashCommand("rg calculateSum src/", { strict: true }).block,
		).toBe(true);
		// regex-y patterns are not identifier lookups — leave them alone
		expect(
			evaluateBashCommand("grep -rn 'TODO|FIXME' src/", { strict: true }).block,
		).toBe(false);
		// searches scoped to non-source files are not identifier lookups
		expect(
			evaluateBashCommand("grep -rn calculateSum docs/*.md", { strict: true })
				.block,
		).toBe(false);
		// ...but explicit source targets still block
		expect(
			evaluateBashCommand("grep -rn calculateSum src/**/*.ts", {
				strict: true,
			}).block,
		).toBe(true);
	});
});

describe("hook command (runCli)", () => {
	function payload(toolName: string, command?: string): string {
		return JSON.stringify({
			tool_name: toolName,
			tool_input: command === undefined ? {} : { command },
		});
	}

	it("exits 2 with guidance when a Bash refactor-by-sed arrives", async () => {
		const err = createCapture();
		const code = await runCli(["hook"], createCapture(), err, {
			readStdin: () => payload("Bash", "sed -i 's/a/b/' src/x.ts"),
		});
		expect(code).toBe(2);
		expect(err.text).toContain("ts-surgeon");
		expect(err.text).toContain(ALLOW_MARKER);
	});

	it("exits 0 for non-Bash tools, harmless commands, and garbage payloads", async () => {
		for (const stdin of [
			payload("Edit", undefined),
			payload("Bash", "ls -la"),
			"{not json",
			"null",
		]) {
			const code = await runCli(["hook"], createCapture(), createCapture(), {
				readStdin: () => stdin,
			});
			expect(code, stdin).toBe(0);
		}
	});

	it("rejects unknown options", async () => {
		const err = createCapture();
		const code = await runCli(["hook", "--nope"], createCapture(), err, {
			readStdin: () => payload("Bash", "ls"),
		});
		expect(code).toBe(2);
		expect(err.text).toContain("Unknown option for hook");
	});

	it("enables strict mode via TS_SURGEON_STRICT=1 (fixed plugin command lines)", async () => {
		const search = payload("Bash", "grep -rn calculateSum src/");
		const defaultCode = await runCli(
			["hook"],
			createCapture(),
			createCapture(),
			{ readStdin: () => search },
		);
		expect(defaultCode).toBe(0);

		vi.stubEnv("TS_SURGEON_STRICT", "1");
		try {
			const err = createCapture();
			const code = await runCli(["hook"], createCapture(), err, {
				readStdin: () => search,
			});
			expect(code).toBe(2);
			expect(err.text).toContain("find_references");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("installClaudeHook", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsurgeon-hook-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates .claude/settings.json with the PreToolUse guard", () => {
		const out = createCapture();
		installClaudeHook(tempDir, out);
		const settings = JSON.parse(
			fs.readFileSync(path.join(tempDir, ".claude", "settings.json"), "utf-8"),
		);
		const entry = settings.hooks.PreToolUse[0];
		expect(entry.matcher).toBe("Bash");
		expect(entry.hooks[0].command).toContain("ts-surgeon hook");
		expect(out.text).toContain("Installed");
	});

	it("registers the opencode plugin in opencode.json and is idempotent", () => {
		const out = createCapture();
		installOpencodeHook(tempDir, out);
		const config = JSON.parse(
			fs.readFileSync(path.join(tempDir, "opencode.json"), "utf-8"),
		);
		expect(config.plugin).toEqual(["@commoncurriculum/ts-surgeon"]);
		expect(config.$schema).toBe("https://opencode.ai/config.json");
		expect(out.text).toContain("Registered");

		const out2 = createCapture();
		installOpencodeHook(tempDir, out2);
		expect(out2.text).toContain("nothing to do");
	});

	it("merges the opencode plugin into an existing config and flags the legacy file", () => {
		fs.writeFileSync(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({ model: "anthropic/claude", plugin: ["other-plugin"] }),
		);
		const legacyPath = path.join(
			tempDir,
			".opencode",
			"plugin",
			"ts-surgeon.js",
		);
		fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
		fs.writeFileSync(legacyPath, "// old copy-installed guard\n");

		const out = createCapture();
		installOpencodeHook(tempDir, out);
		const config = JSON.parse(
			fs.readFileSync(path.join(tempDir, "opencode.json"), "utf-8"),
		);
		expect(config.model).toBe("anthropic/claude");
		expect(config.plugin).toEqual([
			"other-plugin",
			"@commoncurriculum/ts-surgeon",
		]);
		expect(out.text).toContain("old copy-installed guard");
	});

	it("merges into existing settings and is idempotent", () => {
		const settingsPath = path.join(tempDir, ".claude", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				env: { FOO: "bar" },
				hooks: {
					PostToolUse: [
						{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] },
					],
				},
			}),
		);

		installClaudeHook(tempDir, createCapture());
		const out2 = createCapture();
		installClaudeHook(tempDir, out2);
		expect(out2.text).toContain("nothing to do");

		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		expect(settings.env.FOO).toBe("bar");
		expect(settings.hooks.PostToolUse).toHaveLength(1);
		expect(settings.hooks.PreToolUse).toHaveLength(1);
	});
});
