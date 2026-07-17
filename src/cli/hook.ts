import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { CliUsageError, type StdinReader } from "./params";

/**
 * PreToolUse guard for coding-agent harnesses (Claude Code hooks and
 * compatible). The harness pipes the pending tool call as JSON to
 * `ts-surgeon hook`; when the command is a hand-rolled TS/JS refactor
 * (in-place sed/perl over source files), the hook exits 2 with a message on
 * stderr telling the agent to use ts-surgeon instead. Everything else —
 * including anything the hook cannot parse — is allowed (exit 0): the guard
 * must never break the harness.
 */

/** Escape hatch: prefix a command with this to bypass the guard. */
export const ALLOW_MARKER = "TS_SURGEON_ALLOW=1";

const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)\b/;
const IN_PLACE_SED_RE = /\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*\b|--in-place\b)/;
const IN_PLACE_PERL_RE = /\bperl\s+-[a-zA-Z]*i/;
const RECURSIVE_SEARCH_RE = /\bgrep\s+[^|;&]*-[a-zA-Z]*r|\brg\s/;
const ANY_EXT_RE = /\.[a-z0-9]{1,6}\b/i;

const EDIT_BLOCK_MESSAGE = `ts-surgeon: this command hand-edits TypeScript/JavaScript sources with text replacement (sed/perl -i).
Text replacement misses imports, re-exports, and same-name collisions. Use the AST-accurate CLI instead:
  npx -y @commoncurriculum/ts-surgeon guide     # when to use which tool
  e.g. call rename_symbol / change_signature / organize_imports (all support --dry-run)
If this is genuinely not a refactor, re-run the command prefixed with ${ALLOW_MARKER}.`;

const SEARCH_BLOCK_MESSAGE = `ts-surgeon: this looks like a recursive text search for a code identifier.
Text search misses aliased imports and matches unrelated same-name tokens. Prefer the type-aware lookup:
  npx -y @commoncurriculum/ts-surgeon call find_references --target-file-path <file> --symbol-name <name>
If you really want a text search, re-run the command prefixed with ${ALLOW_MARKER}.`;

/** Extracts the first non-flag argument after a grep/rg invocation. */
function searchPattern(command: string): string | undefined {
	const match = command.match(/\b(?:grep|rg)\s+((?:-\S+\s+)*)(\S+)/);
	return match?.[2]?.replace(/^["']|["']$/g, "");
}

export interface HookVerdict {
	block: boolean;
	reason?: string;
}

/**
 * Decides whether a Bash command should be redirected to ts-surgeon.
 * Default mode blocks only in-place text edits of TS/JS sources; strict mode
 * additionally blocks recursive text searches for plain identifiers.
 */
export function evaluateBashCommand(
	command: string,
	{ strict = false }: { strict?: boolean } = {},
): HookVerdict {
	if (command.includes(ALLOW_MARKER)) {
		return { block: false };
	}
	const touchesSources = SOURCE_EXT_RE.test(command);
	if (
		touchesSources &&
		(IN_PLACE_SED_RE.test(command) || IN_PLACE_PERL_RE.test(command))
	) {
		return { block: true, reason: EDIT_BLOCK_MESSAGE };
	}
	if (strict && RECURSIVE_SEARCH_RE.test(command)) {
		// A search explicitly scoped to non-source files (e.g. *.md) is not an
		// identifier lookup — leave it alone.
		const scopedToNonSources = ANY_EXT_RE.test(command) && !touchesSources;
		const pattern = searchPattern(command);
		if (
			!scopedToNonSources &&
			pattern &&
			/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(pattern)
		) {
			return { block: true, reason: SEARCH_BLOCK_MESSAGE };
		}
	}
	return { block: false };
}

interface Writer {
	write(chunk: string): unknown;
}

/**
 * `ts-surgeon hook [--strict]` — reads the harness's PreToolUse JSON payload
 * from stdin ({ tool_name, tool_input: { command } }) and exits 2 with a
 * stderr message to block, 0 to allow.
 */
export function runHook(
	rest: string[],
	readStdin: StdinReader,
	err: Writer,
): number {
	let strict = false;
	for (const arg of rest) {
		if (arg === "--strict") {
			strict = true;
		} else {
			throw new CliUsageError(`Unknown option for hook: '${arg}'`);
		}
	}
	if (process.stdin.isTTY) {
		// Not being driven by a harness; nothing to check.
		return 0;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(readStdin());
	} catch {
		return 0;
	}
	if (payload === null || typeof payload !== "object") {
		return 0;
	}
	const { tool_name, tool_input } = payload as {
		tool_name?: string;
		tool_input?: { command?: string };
	};
	if (tool_name !== "Bash" || typeof tool_input?.command !== "string") {
		return 0;
	}
	const verdict = evaluateBashCommand(tool_input.command, { strict });
	if (verdict.block) {
		err.write(`${verdict.reason}\n`);
		return 2;
	}
	return 0;
}

const HOOK_COMMAND = "npx -y @commoncurriculum/ts-surgeon hook";

/** Contents of the generated opencode plugin (see installOpencodeHook). */
const OPENCODE_PLUGIN = `// Installed by \`ts-surgeon init --opencode-hook\`.
// Guards against hand-rolled TS/JS refactors: every bash tool call is checked
// by \`ts-surgeon hook\` (exit 2 = block, stderr explains what to use instead).
// Prefix a command with ${ALLOW_MARKER} to bypass. Delete this file to remove.
import { spawnSync } from "node:child_process";

export const TsSurgeonGuard = async () => ({
	"tool.execute.before": async (input, output) => {
		if (input.tool !== "bash") return;
		const command = output?.args?.command;
		if (typeof command !== "string") return;
		const payload = JSON.stringify({
			tool_name: "Bash",
			tool_input: { command },
		});
		const result = spawnSync(
			"npx",
			["-y", "@commoncurriculum/ts-surgeon", "hook"],
			{ input: payload, encoding: "utf-8" },
		);
		if (result.status === 2) {
			throw new Error(
				(result.stderr || "").trim() || "ts-surgeon blocked this command",
			);
		}
	},
});
`;

/**
 * Installs the guard as an opencode plugin
 * (.opencode/plugin/ts-surgeon.js). Idempotent.
 */
export function installOpencodeHook(cwd: string, out: Writer): void {
	const pluginPath = path.join(cwd, ".opencode", "plugin", "ts-surgeon.js");
	if (existsSync(pluginPath)) {
		out.write(`${pluginPath} already exists — nothing to do.\n`);
		return;
	}
	mkdirSync(path.dirname(pluginPath), { recursive: true });
	writeFileSync(pluginPath, OPENCODE_PLUGIN);
	out.write(
		`Installed the ts-surgeon guard as an opencode plugin at ${pluginPath} (blocks sed/perl -i on TS/JS sources; prefix a command with ${ALLOW_MARKER} to bypass).\n`,
	);
}

/**
 * Installs the PreToolUse guard into a project's .claude/settings.json
 * (Claude Code hooks). Merges with existing settings; idempotent.
 */
export function installClaudeHook(cwd: string, out: Writer): void {
	const settingsPath = path.join(cwd, ".claude", "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch (error) {
			throw new CliUsageError(
				`${settingsPath} is not valid JSON — fix it before installing the hook: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	settings.hooks ??= {};
	const hooks = settings.hooks as Record<string, unknown>;
	hooks.PreToolUse ??= [];
	const preToolUse = hooks.PreToolUse as Array<{
		matcher?: string;
		hooks?: Array<{ type?: string; command?: string }>;
	}>;
	const alreadyInstalled = preToolUse.some((entry) =>
		entry.hooks?.some((hook) => hook.command?.includes("ts-surgeon hook")),
	);
	if (alreadyInstalled) {
		out.write(
			`${settingsPath} already runs the ts-surgeon hook — nothing to do.\n`,
		);
		return;
	}
	preToolUse.push({
		matcher: "Bash",
		hooks: [{ type: "command", command: HOOK_COMMAND }],
	});

	mkdirSync(path.dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	out.write(
		`Installed the ts-surgeon PreToolUse guard in ${settingsPath} (blocks sed/perl -i on TS/JS sources; prefix a command with ${ALLOW_MARKER} to bypass).\n`,
	);
}
