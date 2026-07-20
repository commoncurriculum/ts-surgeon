import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli";
import {
	ALLOW_MARKER,
	evaluateBashCommand,
	formatSearchAnswer,
	installClaudeHook,
	installOpencodeHook,
	type SearchAnswerRequest,
	type SearchAnswerer,
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
			expect(verdict.kind, command).toBe("block");
			if (verdict.kind === "block") {
				expect(verdict.reason).toContain("ts-surgeon");
			}
		}
	});

	it("allows sed on non-source files and read-only sed", () => {
		for (const command of [
			"sed -i 's/foo/bar/' README.md",
			"sed -n '10,20p' src/utils.ts",
			"sed 's/foo/bar/' src/utils.ts > /tmp/out.txt",
		]) {
			expect(evaluateBashCommand(command).kind, command).toBe("allow");
		}
	});

	it("ignores the inline TS_SURGEON_ALLOW prefix on edits (escape hatch is operator-only)", () => {
		const verdict = evaluateBashCommand(
			`${ALLOW_MARKER} sed -i 's/oldName/newName/g' src/utils.ts`,
		);
		expect(verdict.kind).toBe("block");
		if (verdict.kind === "block") {
			expect(verdict.reason).toContain("operator-only");
			expect(verdict.reason).toContain("ignored");
		}
	});

	// ── Verdict corpus ────────────────────────────────────────────────────────
	// Every evasion observed in a real transcript gets added here as a fixture,
	// with a comment citing the date, so regressions are caught by `pnpm test`.
	// Keep must-allow cases as aggressively as must-block ones: an over-blocking
	// hook trains agents to fight the guard instead of learning the tools.

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

	// Real transcript, 2026-07-19 (evening): the block messages advertised the
	// TS_SURGEON_ALLOW=1 prefix, so the agent cargo-culted it onto every search
	// — including recursive identifier hunts — and never touched the tools. The
	// prefix is now inert; only an operator-set env var bypasses the guard.
	const TRANSCRIPT_ALLOW_PREFIX_SWEEP = `TS_SURGEON_ALLOW=1 grep -rn -B3 -A 10 "runDeleteStandard" shared/src/unified-tiptap/extensions/standard/ | head -40; echo ----; sed -n 165,205p shared/src/unified-tiptap/analytics/instrumented-commands.ts; echo ----; TS_SURGEON_ALLOW=1 grep -n "standardNode\\|export function cardNode\\|googleClassroomCardNode" shared/test/fixtures/lesson.ts | head`;

	// Same transcript: a recursive hunt for a declaration site ("function name")
	// is an identifier lookup wearing a two-word coat — find_references territory.
	const TRANSCRIPT_DECLARATION_HUNT = `TS_SURGEON_ALLOW=1 grep -rn -B2 -A 10 "function renderStringAsData" shared/src/unified-tiptap/ | head -25; echo ----; sed -n 56,100p shared/src/unified-tiptap/extensions/card-normal/card-normal-extension.ts`;

	// Hard blocks: in-place text edits and runtime-dynamic loop evasions. These
	// have no answerable single symbol, so the guard still says no — but the
	// message names tools that work without knowing the declaring file.
	const MUST_BLOCK: Array<{ command: string; expectInReason: string }> = [
		{
			command: TRANSCRIPT_UNUSED_EXPORT_SWEEP,
			expectInReason: "find_unused_exports",
		},
		{
			command: `${ALLOW_MARKER} sed -i 's/a/b/' src/x.ts`,
			expectInReason: "rename_symbol",
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

	// Identifier hunts are no longer argued with: the hook runs find_references
	// itself and returns real references (or lets the grep through when it
	// cannot answer). The classifier must extract the symbol being hunted.
	const MUST_ANSWER: Array<{
		command: string;
		symbol: string;
		root?: string;
	}> = [
		{
			command: TRANSCRIPT_ALLOW_PREFIX_SWEEP,
			symbol: "runDeleteStandard",
			root: "shared/src/unified-tiptap/extensions/standard/",
		},
		{
			command: TRANSCRIPT_DECLARATION_HUNT,
			symbol: "renderStringAsData",
			root: "shared/src/unified-tiptap/",
		},
		// Declaration hunts are identifier lookups wearing a two-word coat.
		{
			command: 'grep -rn "function renderStringAsData" src/',
			symbol: "renderStringAsData",
			root: "src/",
		},
		{
			command: "rg 'export const cartTotal' shared/src/",
			symbol: "cartTotal",
			root: "shared/src/",
		},
		// The inline prefix neither bypasses nor changes the answer.
		{
			command: `${ALLOW_MARKER} grep -rn calculateSum src/`,
			symbol: "calculateSum",
			root: "src/",
		},
		// Recursive identifier searches over (potential) sources.
		{ command: "grep -r fooBar src/", symbol: "fooBar", root: "src/" },
		{ command: "grep -rn calculateSum .", symbol: "calculateSum", root: "." },
		{ command: "rg fooBar", symbol: "fooBar" },
		{ command: "rg calculateSum src/", symbol: "calculateSum", root: "src/" },
		{ command: "git grep -n calculateSum", symbol: "calculateSum" },
		{ command: "grep -rn calculateSum src/**/*.ts", symbol: "calculateSum" },
		// The offending grep is NOT the first search in the command.
		{
			command:
				"grep -oE '^export (function|const) [A-Za-z_]+' src/index.ts | head && grep -rn calculateSum src/",
			symbol: "calculateSum",
			root: "src/",
		},
		// Live agent validation, 2026-07-19: a wildcard --include glob is not a
		// non-source scope — `*.*` covers TS/JS sources too.
		{
			command:
				'grep -rn "calculateSum" --include="*.*" -l . 2>/dev/null | grep -v -E "node_modules|\\.git/"',
			symbol: "calculateSum",
		},
		// Multi-file search via find/xargs wrappers.
		{
			command: "find src -name '*.ts' | xargs grep -n useThing",
			symbol: "useThing",
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
		// Real transcript, 2026-07-19 (evening): reading context out of explicitly
		// named files is legitimate even with a reflexive -rn — recursion is inert
		// when every path is a concrete file. (The agent's inert TS_SURGEON_ALLOW=1
		// prefixes are kept verbatim; they must not flip an allowed command.)
		'cd /repo && TS_SURGEON_ALLOW=1 grep -n "ObjectId" shared/src/unified-tiptap/extensions/card-normal/card-normal-extension.ts shared/src/unified-tiptap/extensions/image-node/image-node-extension.ts | head -4; TS_SURGEON_ALLOW=1 grep -rn -A3 "addKeyboardShortcuts" shared/src/unified-tiptap/extensions/card-google-classroom/card-google-classroom-extension.ts shared/src/unified-tiptap/extensions/standard/standard-extension.ts | head',
		"grep -rn addKeyboardShortcuts a.ts b.ts",
		'grep -rn -A 6 "id:" shared/src/unified-tiptap/extensions/card-normal/card-normal-extension.ts | head -22',
		// Everyday non-search commands.
		"ls -la",
		"git status && git diff",
		"pnpm test",
	];

	it("hard-blocks every must-block corpus command", () => {
		for (const { command, expectInReason } of MUST_BLOCK) {
			const verdict = evaluateBashCommand(command);
			expect(verdict.kind, command).toBe("block");
			if (verdict.kind !== "block") continue;
			expect(verdict.reason, command).toContain("ts-surgeon");
			expect(verdict.reason, command).toContain(expectInReason);
			// No block message may teach the agent a typeable bypass (that is how
			// the prefix got cargo-culted in the first place).
			expect(verdict.reason, command).not.toMatch(
				/re-run|prefixed with|prefix a command/,
			);
		}
	});

	it("classifies every identifier hunt as answerable, with the hunted symbol", () => {
		for (const { command, symbol, root } of MUST_ANSWER) {
			const verdict = evaluateBashCommand(command);
			expect(verdict.kind, command).toBe("answer-search");
			if (verdict.kind !== "answer-search") continue;
			expect(verdict.symbolName, command).toBe(symbol);
			if (root !== undefined) {
				expect(verdict.searchRoot, command).toBe(root);
			}
		}
	});

	it("allows every must-allow corpus command", () => {
		for (const command of MUST_ALLOW) {
			expect(evaluateBashCommand(command).kind, command).toBe("allow");
		}
	});
});

describe("formatSearchAnswer", () => {
	const ref = (n: number) => ({
		filePath: `/repo/src/file${n}.ts`,
		line: n,
		column: 1,
		text: `calculateSum(${n})`,
	});
	const definition = {
		filePath: "/repo/src/math.ts",
		line: 1,
		column: 17,
		text: "export function calculateSum(a: number, b: number) {",
	};

	it("returns the definition and every reference with a rerun command", () => {
		const text = formatSearchAnswer("calculateSum", "/repo/tsconfig.json", {
			definition,
			references: [ref(1), ref(2)],
		});
		expect(text).toContain("ran find_references");
		expect(text).toContain("/repo/src/math.ts:1:17");
		expect(text).toContain("/repo/src/file1.ts:1:1");
		expect(text).toContain("/repo/src/file2.ts:2:1");
		expect(text).toContain("--symbol-name calculateSum");
		expect(text).toContain("--tsconfig-path /repo/tsconfig.json");
		// The answer must not teach a typeable bypass either.
		expect(text).not.toMatch(/re-run|prefixed with|prefix a command/);
	});

	it("says so explicitly when nothing references the symbol", () => {
		const text = formatSearchAnswer("calculateSum", "/repo/tsconfig.json", {
			definition,
			references: [],
		});
		expect(text).toMatch(/no references|nothing else/i);
	});

	it("caps long reference lists and reports the omitted count", () => {
		const refs = Array.from({ length: 55 }, (_, i) => ref(i + 1));
		const text = formatSearchAnswer("calculateSum", "/repo/tsconfig.json", {
			definition,
			references: refs,
		});
		expect(text).toContain("/repo/src/file40.ts");
		expect(text).not.toContain("/repo/src/file41.ts");
		expect(text).toContain("15 more");
	});
});

describe("hook command (runCli)", () => {
	function payload(toolName: string, command?: string, cwd?: string): string {
		return JSON.stringify({
			tool_name: toolName,
			tool_input: command === undefined ? {} : { command },
			...(cwd === undefined ? {} : { cwd }),
		});
	}

	/** Fake answerer: records requests, returns a canned answer (or refuses). */
	function fakeAnswerer(ok: boolean) {
		const calls: SearchAnswerRequest[] = [];
		const answerSearch: SearchAnswerer = (req) => {
			calls.push(req);
			return ok
				? { ok: true, text: `ANSWERED ${req.symbolName}` }
				: { ok: false };
		};
		return { calls, answerSearch };
	}

	it("exits 2 with guidance when a Bash refactor-by-sed arrives", async () => {
		const err = createCapture();
		const code = await runCli(["hook"], createCapture(), err, {
			readStdin: () => payload("Bash", "sed -i 's/a/b/' src/x.ts"),
		});
		expect(code).toBe(2);
		expect(err.text).toContain("ts-surgeon");
		expect(err.text).not.toMatch(/re-run|prefixed with/);
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

	it("answers a recursive identifier search with find_references output", async () => {
		const { calls, answerSearch } = fakeAnswerer(true);
		const err = createCapture();
		const code = await runCli(["hook"], createCapture(), err, {
			readStdin: () => payload("Bash", "grep -rn calculateSum src/", "/repo"),
			answerSearch,
		});
		expect(code).toBe(2);
		expect(err.text).toContain("ANSWERED calculateSum");
		expect(calls).toEqual([
			{ symbolName: "calculateSum", searchRoot: "src/", cwd: "/repo" },
		]);
	});

	it("fails open (allows the grep) when the search cannot be answered", async () => {
		const { calls, answerSearch } = fakeAnswerer(false);
		const err = createCapture();
		const code = await runCli(["hook"], createCapture(), err, {
			readStdin: () => payload("Bash", "grep -rn calculateSum src/"),
			answerSearch,
		});
		expect(code).toBe(0);
		expect(err.text).toBe("");
		expect(calls).toHaveLength(1);
	});

	it("prefixes the answer with the inert-prefix note when the agent cargo-cults TS_SURGEON_ALLOW", async () => {
		const { answerSearch } = fakeAnswerer(true);
		const err = createCapture();
		const code = await runCli(["hook"], createCapture(), err, {
			readStdin: () =>
				payload("Bash", `${ALLOW_MARKER} grep -rn calculateSum src/`),
			answerSearch,
		});
		expect(code).toBe(2);
		expect(err.text).toContain("operator-only");
		expect(err.text).toContain("ANSWERED calculateSum");
	});

	it("honors TS_SURGEON_ALLOW=1 only from the hook's own environment", async () => {
		const search = payload("Bash", "grep -rn calculateSum src/");
		try {
			vi.stubEnv("TS_SURGEON_ALLOW", "1");
			const { calls, answerSearch } = fakeAnswerer(true);
			const code = await runCli(["hook"], createCapture(), createCapture(), {
				readStdin: () => search,
				answerSearch,
			});
			expect(code).toBe(0);
			expect(calls).toHaveLength(0);
		} finally {
			vi.unstubAllEnvs();
		}
		// Any other value (or unset) does not bypass.
		try {
			vi.stubEnv("TS_SURGEON_ALLOW", "0");
			const { answerSearch } = fakeAnswerer(true);
			const err = createCapture();
			const code = await runCli(["hook"], createCapture(), err, {
				readStdin: () => search,
				answerSearch,
			});
			expect(code).toBe(2);
			expect(err.text).toContain("ANSWERED calculateSum");
		} finally {
			vi.unstubAllEnvs();
		}
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

	function grepPayload(input: Record<string, unknown>, cwd?: string): string {
		return JSON.stringify({
			tool_name: "Grep",
			tool_input: input,
			...(cwd === undefined ? {} : { cwd }),
		});
	}

	it("answers the harness's native Grep tool for identifier lookups over sources", async () => {
		const { calls, answerSearch } = fakeAnswerer(true);
		const err = createCapture();
		const code = await runCli(["hook"], createCapture(), err, {
			readStdin: () =>
				grepPayload({ pattern: "calculateSum", path: "src" }, "/repo"),
			answerSearch,
		});
		expect(code).toBe(2);
		expect(err.text).toContain("ANSWERED calculateSum");
		expect(calls).toEqual([
			{ symbolName: "calculateSum", searchRoot: "src", cwd: "/repo" },
		]);
	});

	it("fails open on native Grep when the search cannot be answered", async () => {
		const { answerSearch } = fakeAnswerer(false);
		const code = await runCli(["hook"], createCapture(), createCapture(), {
			readStdin: () => grepPayload({ pattern: "calculateSum", path: "src" }),
			answerSearch,
		});
		expect(code).toBe(0);
	});

	it("allows native Grep for regexes and non-source scopes", async () => {
		for (const input of [
			{ pattern: "TODO|FIXME", path: "src" },
			{ pattern: "calculateSum", glob: "*.md" },
			{ pattern: "calculateSum", path: "docs" },
			{ pattern: "calculateSum", type: "md" },
			{ pattern: "TODO" },
		]) {
			const { calls, answerSearch } = fakeAnswerer(true);
			const code = await runCli(["hook"], createCapture(), createCapture(), {
				readStdin: () => grepPayload(input),
				answerSearch,
			});
			expect(code, JSON.stringify(input)).toBe(0);
			expect(calls, JSON.stringify(input)).toHaveLength(0);
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

	it("answers searches regardless of TS_SURGEON_STRICT (split retired)", async () => {
		const search = payload("Bash", "grep -rn calculateSum src/");
		for (const stub of [undefined, "0", "1"]) {
			if (stub !== undefined) {
				vi.stubEnv("TS_SURGEON_STRICT", stub);
			}
			try {
				const { answerSearch } = fakeAnswerer(true);
				const err = createCapture();
				const code = await runCli(["hook"], createCapture(), err, {
					readStdin: () => search,
					answerSearch,
				});
				expect(code, `TS_SURGEON_STRICT=${stub}`).toBe(2);
				expect(err.text).toContain("ANSWERED calculateSum");
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
