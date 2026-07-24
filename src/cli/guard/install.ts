import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { CliUsageError } from "../params.js";
import { ALLOW_MARKER } from "./messages.js";

/**
 * Installers that register the guard with a harness: Claude Code hook
 * entries in .claude/settings.json, and the opencode plugin in
 * opencode.json. Pure config-file mutation — no policy logic lives here.
 */

/**
 * The compiled guard, named directly — no `npx`, no shell wrapper in front of
 * it. Both cost more than the guard itself: see compile.ts. Quoted because the
 * cache path contains the user's home directory.
 */
function hookCommands(binaryPath: string): {
	pre: string;
	post: string;
} {
	const quoted = `"${binaryPath}"`;
	return { pre: quoted, post: `${quoted} --post` };
}

/**
 * Recognises a hook entry this installer owns, and nothing else. The installer
 * rewrites what it matches, so "mentions ts-surgeon" is too broad a test — it
 * would silently eat an unrelated `ts-surgeon doctor` hook someone added by
 * hand. Only two shapes qualify: the npx command older versions wrote, and a
 * compiled guard, which always lives at .../ts-surgeon/guard-<version>.
 */
const GUARD_COMMAND = /ts-surgeon hook\b|[/\\]ts-surgeon[/\\]guard-[^"']*/;

/** npm package opencode loads as the guard plugin (this package itself). */
const OPENCODE_PLUGIN_PACKAGE = "@commoncurriculum/ts-surgeon";

interface Writer {
	write(chunk: string): unknown;
}

/**
 * Registers the guard in the project's opencode.json `"plugin"` array — the
 * package's main export is the opencode plugin, and opencode auto-installs
 * npm plugins at startup. Merges with existing config; idempotent.
 */
export function installOpencodeHook(cwd: string, out: Writer): void {
	const configPath = path.join(cwd, "opencode.json");
	let config: Record<string, unknown> = {
		$schema: "https://opencode.ai/config.json",
	};
	if (existsSync(configPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (error) {
			throw new CliUsageError(
				`${configPath} is not valid JSON — fix it before installing the plugin: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			throw new CliUsageError(
				`${configPath} must contain a JSON object to register the plugin (found ${Array.isArray(parsed) ? "an array" : typeof parsed}).`,
			);
		}
		config = parsed as Record<string, unknown>;
	}

	config.plugin ??= [];
	if (!Array.isArray(config.plugin)) {
		throw new CliUsageError(
			`${configPath} has a non-array "plugin" field — fix it before installing (expected e.g. ["@commoncurriculum/ts-surgeon"]).`,
		);
	}
	const plugins: unknown[] = config.plugin;
	if (
		plugins.some(
			(entry) =>
				typeof entry === "string" && entry.startsWith(OPENCODE_PLUGIN_PACKAGE),
		)
	) {
		out.write(
			`${configPath} already lists the ${OPENCODE_PLUGIN_PACKAGE} plugin — nothing to do.\n`,
		);
		return;
	}
	plugins.push(OPENCODE_PLUGIN_PACKAGE);
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
	out.write(
		`Registered the ${OPENCODE_PLUGIN_PACKAGE} guard plugin in ${configPath} (blocks sed/perl -i on TS/JS sources; answers recursive identifier searches with find_references output and fails open when it cannot answer; operators can disable it by launching the agent with ${ALLOW_MARKER} in the environment).\n`,
	);

	// Older versions of this installer copied a standalone plugin file instead.
	for (const legacy of [
		path.join(cwd, ".opencode", "plugin", "ts-surgeon.js"),
		path.join(cwd, ".opencode", "plugins", "ts-surgeon.js"),
	]) {
		if (existsSync(legacy)) {
			out.write(
				`Note: ${legacy} is the old copy-installed guard — delete it to avoid running the check twice.\n`,
			);
		}
	}
}

/**
 * Installs the PreToolUse guard and the PostToolUse teaching hook into a
 * project's .claude/settings.json (Claude Code hooks). Merges with existing
 * settings; idempotent; upgrades older installs in place.
 */
export function installClaudeHook(
	cwd: string,
	out: Writer,
	binaryPath: string,
): void {
	const { pre, post } = hookCommands(binaryPath);
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
	hooks.PostToolUse ??= [];
	type HookEntry = {
		matcher?: string;
		hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
	};
	const preToolUse = hooks.PreToolUse as HookEntry[];
	const postToolUse = hooks.PostToolUse as HookEntry[];
	const notes: string[] = [];

	const isGuardHook = (entry: HookEntry) =>
		entry.hooks?.some(
			(hook) =>
				hook.command !== undefined &&
				GUARD_COMMAND.test(hook.command) &&
				!hook.command.includes("--post"),
		);

	const existing = preToolUse.find(isGuardHook);
	if (existing) {
		if (existing.matcher === "Bash") {
			// Older installs only guarded Bash; extend them to the native Grep tool.
			existing.matcher = "Bash|Grep";
			notes.push(
				`Upgraded the ts-surgeon hook matcher in ${settingsPath} from Bash to Bash|Grep (the guard now also redirects the native Grep tool).\n`,
			);
		}
		for (const hook of existing.hooks ?? []) {
			if (hook.command !== undefined && hook.command !== pre) {
				hook.command = pre;
				notes.push(
					`Pointed the ts-surgeon PreToolUse guard in ${settingsPath} at the compiled binary (${binaryPath}) — it no longer starts a package manager on every tool call.\n`,
				);
			}
		}
	} else {
		preToolUse.push({
			matcher: "Bash|Grep",
			// Generous timeout: answering a search runs find_references in a child
			// process, which loads the ts-morph project (bounded by
			// TS_SURGEON_ANSWER_TIMEOUT_MS).
			hooks: [{ type: "command", command: pre, timeout: 120 }],
		});
		notes.push(
			`Installed the ts-surgeon PreToolUse guard in ${settingsPath} (blocks sed/perl -i on TS/JS sources; answers recursive identifier searches with find_references output and fails open when it cannot answer; operators can disable it by launching the agent with ${ALLOW_MARKER} in the environment).\n`,
		);
	}

	// `--post` alone would match any unrelated hook that happens to take that
	// flag; it only identifies ours alongside a guard command.
	const existingPost = postToolUse.find((entry) =>
		entry.hooks?.some(
			(hook) =>
				hook.command !== undefined &&
				GUARD_COMMAND.test(hook.command) &&
				hook.command.includes("--post"),
		),
	);
	if (existingPost) {
		for (const hook of existingPost.hooks ?? []) {
			if (hook.command !== undefined && hook.command !== post) {
				hook.command = post;
				notes.push(
					`Pointed the ts-surgeon PostToolUse hook in ${settingsPath} at the compiled binary.\n`,
				);
			}
		}
	} else {
		postToolUse.push({
			matcher: "Bash|Grep",
			hooks: [{ type: "command", command: post, timeout: 30 }],
		});
		notes.push(
			`Added the ts-surgeon PostToolUse teaching hook in ${settingsPath} (after an executed search it suggests the exact ts-surgeon equivalent — e.g. call find_references --symbol-name <name>).\n`,
		);
	}

	if (notes.length === 0) {
		out.write(
			`${settingsPath} already runs the ts-surgeon hooks — nothing to do.\n`,
		);
		return;
	}
	mkdirSync(path.dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	for (const note of notes) {
		out.write(note);
	}
}
