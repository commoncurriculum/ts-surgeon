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

	// ── Verdict corpus ────────────────────────────────────────────────────────
	// Every evasion observed in a real transcript gets added here as a fixture,
	// with a comment citing the date, so regressions are caught by `pnpm test`.
	// Keep must-allow cases as aggressively as must-block ones: an over-blocking
	// hook gets TS_SURGEON_ALLOW-prefixed reflexively and stops teaching anything.

	// Real transcript, 2026-07-19: export-enumeration + consumer-count loop.
	// The first grep is a regex over single files (fine); the offender is the
	// recursive, variable-pattern grep inside $() targeting --include='*.ts'.
	const TRANSCRIPT_UNUSED_EXPORT_SWEEP = `for f in shared/src/unified-tiptap/analytics/*.ts shared/src/unified-tiptap/nodes/*.ts; do
  grep -oE '^export (async )?(function|const|type|interface|class|enum) [A-Za-z_]+' "$f" | awk -v f="$f" '{print f":"$NF}'
done > /tmp/exports.txt
while IFS=: read -r file name; do
  hits=$(grep -rl --include='*.ts' --include='*.tsx' -w "$name" shared/src frontend/app | wc -l)
  [ "$hits" = "0" ] && echo "UNUSED-OUTSIDE-FILE: $file:$name"
done < /tmp/exports.txt`;

	const MUST_BLOCK: Array<{ command: string; expectInReason: string }> = [
		{
			command: TRANSCRIPT_UNUSED_EXPORT_SWEEP,
			expectInReason: "find_references",
		},
		// Recursive identifier searches over (potential) sources.
		{ command: "grep -r fooBar src/", expectInReason: "find_references" },
		{ command: "grep -rn calculateSum .", expectInReason: "find_references" },
		{ command: "rg fooBar", expectInReason: "find_references" },
		{ command: "rg calculateSum src/", expectInReason: "find_references" },
		{ command: "git grep -n calculateSum", expectInReason: "find_references" },
		{
			command: "grep -rn calculateSum src/**/*.ts",
			expectInReason: "find_references",
		},
		// The offending grep is NOT the first search in the command.
		{
			command:
				"grep -oE '^export (function|const) [A-Za-z_]+' src/index.ts | head && grep -rn calculateSum src/",
			expectInReason: "find_references",
		},
		// Variable-pattern recursive searches targeting sources (loop evasion).
		{
			command:
				"for name in $(cat names.txt); do grep -rl --include='*.ts' -w \"$name\" src/; done",
			expectInReason: "find_references",
		},
		{
			command:
				'while read -r name; do hits=$(grep -rn -w "$name" --include=\'*.tsx\' frontend/ | wc -l); echo "$name $hits"; done < names.txt',
			expectInReason: "find_references",
		},
		// Live agent validation, 2026-07-19: a wildcard --include glob is not a
		// non-source scope — `*.*` covers TS/JS sources too.
		{
			command:
				'grep -rn "calculateSum" --include="*.*" -l . 2>/dev/null | grep -v -E "node_modules|\\.git/"',
			expectInReason: "find_references",
		},
		// Multi-file search via find/xargs wrappers.
		{
			command: "find src -name '*.ts' | xargs grep -n useThing",
			expectInReason: "find_references",
		},
		// In-place edits (the pre-existing block, unchanged).
		{
			command: "sed -i 's/oldName/newName/g' src/utils.ts",
			expectInReason: "rename_symbol",
		},
		{
			command: "perl -pi -e 's/foo/bar/' src/index.js",
			expectInReason: "rename_symbol",
		},
	];

	const MUST_ALLOW: string[] = [
		// Searches explicitly scoped to non-source files.
		"grep -r TODO docs/",
		"grep -rn calculateSum docs/*.md",
		"git grep -n calculateSum -- '*.md'",
		"rg --type md installation",
		"rg calculateSum --glob '*.json'",
		// Non-recursive / single-file greps.
		'grep -n "pattern" one-file.ts',
		"grep calculateSum src/utils.ts",
		"grep -c error server.log",
		// Pipes into grep filter stdin, not the repo.
		"cat notes.txt | grep foo",
		"ps aux | grep node",
		"history | grep git",
		// Regex-y patterns are not identifier lookups.
		"grep -rn 'TODO|FIXME' src/",
		"rg 'foo bar' src/",
		"rg 'function\\s+\\w+' src/",
		// Comment-marker words are not code identifiers.
		"grep -rn TODO src/",
		// Non-source directory trees.
		"grep -rn error logs/",
		// The escape hatch always wins.
		`${ALLOW_MARKER} grep -rn calculateSum src/`,
		`${ALLOW_MARKER} sed -i 's/a/b/' src/x.ts`,
		// Everyday non-search commands.
		"ls -la",
		"git status && git diff",
		"pnpm test",
	];

	it("blocks every must-block corpus command", () => {
		for (const { command, expectInReason } of MUST_BLOCK) {
			const verdict = evaluateBashCommand(command);
			expect(verdict.block, command).toBe(true);
			expect(verdict.reason, command).toContain("ts-surgeon");
			expect(verdict.reason, command).toContain(expectInReason);
			expect(verdict.reason, command).toContain(ALLOW_MARKER);
		}
	});

	it("allows every must-allow corpus command", () => {
		for (const command of MUST_ALLOW) {
			expect(evaluateBashCommand(command).block, command).toBe(false);
		}
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

	it("exits 2 with guidance when a Bash recursive identifier search arrives", async () => {
		const err = createCapture();
		const code = await runCli(["hook"], createCapture(), err, {
			readStdin: () => payload("Bash", "grep -rn calculateSum src/"),
		});
		expect(code).toBe(2);
		expect(err.text).toContain("find_references");
		expect(err.text).toContain(ALLOW_MARKER);
	});

	it("accepts --strict as a deprecated no-op", async () => {
		const code = await runCli(
			["hook", "--strict"],
			createCapture(),
			createCapture(),
			{
				readStdin: () => payload("Bash", "ls -la"),
			},
		);
		expect(code).toBe(0);
	});

	function grepPayload(input: Record<string, unknown>): string {
		return JSON.stringify({ tool_name: "Grep", tool_input: input });
	}

	it("redirects the harness's native Grep tool for identifier lookups over sources", async () => {
		const err = createCapture();
		const code = await runCli(["hook"], createCapture(), err, {
			readStdin: () => grepPayload({ pattern: "calculateSum", path: "src" }),
		});
		expect(code).toBe(2);
		expect(err.text).toContain("find_references");
	});

	it("allows native Grep for regexes and non-source scopes", async () => {
		for (const input of [
			{ pattern: "TODO|FIXME", path: "src" },
			{ pattern: "calculateSum", glob: "*.md" },
			{ pattern: "calculateSum", path: "docs" },
			{ pattern: "calculateSum", type: "md" },
			{ pattern: "TODO" },
		]) {
			const code = await runCli(["hook"], createCapture(), createCapture(), {
				readStdin: () => grepPayload(input),
			});
			expect(code, JSON.stringify(input)).toBe(0);
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

	it("blocks searches regardless of TS_SURGEON_STRICT (split retired)", async () => {
		const search = payload("Bash", "grep -rn calculateSum src/");
		for (const stub of [undefined, "0", "1"]) {
			if (stub !== undefined) {
				vi.stubEnv("TS_SURGEON_STRICT", stub);
			}
			try {
				const err = createCapture();
				const code = await runCli(["hook"], createCapture(), err, {
					readStdin: () => search,
				});
				expect(code, `TS_SURGEON_STRICT=${stub}`).toBe(2);
				expect(err.text).toContain("find_references");
			} finally {
				vi.unstubAllEnvs();
			}
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
		expect(entry.matcher).toBe("Bash|Grep");
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

	it("rejects malformed opencode.json instead of corrupting it", () => {
		const configPath = path.join(tempDir, "opencode.json");
		// Root is an array — pushing a property onto it would serialize wrong.
		fs.writeFileSync(configPath, "[]");
		expect(() => installOpencodeHook(tempDir, createCapture())).toThrow(
			/must contain a JSON object/,
		);
		// "plugin" is a string, not an array.
		fs.writeFileSync(configPath, JSON.stringify({ plugin: "other-plugin" }));
		expect(() => installOpencodeHook(tempDir, createCapture())).toThrow(
			/non-array "plugin" field/,
		);
		// Untouched by the failed attempts.
		expect(fs.readFileSync(configPath, "utf-8")).toBe(
			JSON.stringify({ plugin: "other-plugin" }),
		);
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

	it("upgrades a pre-existing Bash-only matcher to Bash|Grep", () => {
		const settingsPath = path.join(tempDir, ".claude", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [
								{
									type: "command",
									command: "npx -y @commoncurriculum/ts-surgeon hook",
								},
							],
						},
					],
				},
			}),
		);

		const out = createCapture();
		installClaudeHook(tempDir, out);
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		expect(settings.hooks.PreToolUse).toHaveLength(1);
		expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash|Grep");
		expect(out.text).toContain("Upgraded");
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
