import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findNearestTsconfig } from "../paths.js";
import { hasFileExtension } from "./scope.js";

/**
 * Stage 5 of the guard pipeline: instead of arguing with an identifier hunt,
 * run find_references for every hunted symbol and hand the agent the real
 * references. One `batch` child process serves all symbols (the parsed
 * project is shared), bounded by a time budget; ok:false at any point means
 * "could not answer — let the original search run" (fail-open on reads).
 */

export interface SearchAnswerRequest {
	symbolNames: string[];
	searchRoot?: string;
	/** The harness session's working directory (from the hook payload). */
	cwd: string;
}

/** ok:false means "could not answer — let the original search run". */
export type SearchAnswer = { ok: true; text: string } | { ok: false };
export type SearchAnswerer = (req: SearchAnswerRequest) => SearchAnswer;

interface AnswerLocation {
	filePath: string;
	line: number;
	column: number;
	text: string;
}

export type PerSymbolResult =
	| {
			symbolName: string;
			status: "found";
			definition: AnswerLocation | null;
			references: AnswerLocation[];
	  }
	| { symbolName: string; status: "ambiguous"; message: string }
	| { symbolName: string; status: "not-found" };

/**
 * Zips a `batch --json` result array back onto the symbols that were asked
 * about. undefined = the output was not the expected shape (fail open).
 */
export function mapBatchResults(
	symbolNames: string[],
	parsed: unknown,
): PerSymbolResult[] | undefined {
	if (!Array.isArray(parsed) || parsed.length !== symbolNames.length) {
		return undefined;
	}
	return parsed.map((entry, i) => {
		const symbolName = symbolNames[i];
		const e = entry as {
			status?: unknown;
			data?: {
				definition?: AnswerLocation | null;
				references?: AnswerLocation[];
			} | null;
			message?: unknown;
		};
		if (e.status === "success" && e.data != null) {
			return {
				symbolName,
				status: "found",
				definition: e.data.definition ?? null,
				references: Array.isArray(e.data.references) ? e.data.references : [],
			};
		}
		const message = typeof e.message === "string" ? e.message : "";
		if (message.includes("declarations in the project")) {
			// Strip the CLI envelope's framing (Error: prefix, Status/timing
			// footer) — only the candidate list matters here.
			const cleaned = message
				.replace(/^Error:\s*/, "")
				.split("\n")
				.filter((line) => !/^(Status:|Processing time:)/.test(line.trim()))
				.join("\n")
				.trim();
			return { symbolName, status: "ambiguous", message: cleaned };
		}
		return { symbolName, status: "not-found" };
	});
}

/** Total reference lines shown; split across however many symbols were found. */
const REFERENCE_DISPLAY_CAP = 40;

/** Renders per-symbol find_references output as the hook's answer. */
export function formatSearchAnswer(
	tsconfigPath: string,
	results: PerSymbolResult[],
): string {
	const names = results.map((r) => `'${r.symbolName}'`).join(", ");
	const plural = results.length > 1 ? "s" : "";
	const lines: string[] = [
		`ts-surgeon: this search hunts the identifier${plural} ${names}, so the hook ran find_references for you (AST-accurate: no comment/string false hits; aliased imports and re-exports included).`,
	];
	const foundCount = results.filter((r) => r.status === "found").length;
	const perSymbolCap = Math.max(
		5,
		Math.floor(REFERENCE_DISPLAY_CAP / Math.max(1, foundCount)),
	);
	const loc = (l: AnswerLocation) =>
		`${l.filePath}:${l.line}:${l.column}  ${l.text}`;
	for (const result of results) {
		if (results.length > 1) {
			lines.push(`── ${result.symbolName}`);
		}
		if (result.status === "found") {
			lines.push(
				result.definition
					? `Definition: ${loc(result.definition)}`
					: "Definition: (not reported)",
			);
			if (result.references.length === 0) {
				lines.push(
					`References: none — nothing else in the project references '${result.symbolName}'.`,
				);
			} else {
				lines.push(`References (${result.references.length}):`);
				for (const ref of result.references.slice(0, perSymbolCap)) {
					lines.push(`  ${loc(ref)}`);
				}
				if (result.references.length > perSymbolCap) {
					lines.push(
						`  … and ${result.references.length - perSymbolCap} more; run the command below for the full list.`,
					);
				}
			}
		} else if (result.status === "ambiguous") {
			lines.push(
				`Multiple declarations — a text search would have conflated them. ${result.message}`,
			);
		} else {
			lines.push(
				`No project declaration named '${result.symbolName}' — likely external (a library symbol) or text-only. Grep specific files by name if you need raw mentions; that is always allowed.`,
			);
		}
	}
	lines.push(
		"Run this lookup directly next time:",
		`  npx -y @commoncurriculum/ts-surgeon call find_references --tsconfig-path ${tsconfigPath} --symbol-name ${results[0]?.symbolName ?? "<name>"}`,
		"Free-text/regex searches and greps over explicitly named files are never intercepted.",
	);
	return lines.join("\n");
}

/**
 * Hard ceiling for the in-hook find_references child process. The grep being
 * intercepted would return in about a second, so an answer is only worth a
 * few seconds' wait — beyond that, stalling the agent and then failing open
 * is strictly worse than letting the grep run. Projects that load slowly but
 * are worth answering can raise TS_SURGEON_ANSWER_TIMEOUT_MS.
 */
const ANSWER_TIMEOUT_MS = Number(
	process.env.TS_SURGEON_ANSWER_TIMEOUT_MS ?? "10000",
);

/**
 * The JS runtime that runs the CLI child process. Under Node, process.execPath
 * is the node binary. Under Bun that is not reliable: inside a compiled
 * executable (opencode ships as one) process.execPath is the host app's own
 * binary, which ignores script arguments — spawning it would print the app's
 * banner instead of running the CLI. Resolve a real runtime from PATH via
 * Bun.which instead (node first: the CLI targets node). undefined → fail open.
 */
export function resolveCliRuntime(): string | undefined {
	if (typeof process.versions.bun !== "string") {
		return process.execPath;
	}
	const which = (globalThis as { Bun?: { which?(bin: string): string | null } })
		.Bun?.which;
	return which?.("node") ?? which?.("bun") ?? undefined;
}

/**
 * The real answerer: locate the nearest tsconfig above the searched path,
 * then run this package's own CLI (`batch` of find_references calls — one
 * parsed project serves every symbol) in a child process with a time budget.
 * The answer stands when at least one symbol resolved (or was ambiguous —
 * the candidate list is itself an answer); symbols with no project
 * declaration are reported as such. Zero resolvable symbols, no tsconfig, no
 * built CLI, crash, or timeout → ok:false, and the caller lets the search
 * run.
 */
export const answerSearchViaCli: SearchAnswerer = (req) => {
	if (req.symbolNames.length === 0) {
		return { ok: false };
	}
	let rootDir = existsSync(req.cwd) ? req.cwd : process.cwd();
	if (req.searchRoot !== undefined) {
		// Reduce globs ("src/**/*.ts") and file paths to a directory to walk up
		// from; fall back to the session cwd when it does not exist.
		let dir = path.resolve(rootDir, req.searchRoot.split(/[*?[]/)[0]);
		if (hasFileExtension(dir)) {
			dir = path.dirname(dir);
		}
		while (dir !== path.dirname(dir) && !existsSync(dir)) {
			dir = path.dirname(dir);
		}
		if (existsSync(dir)) {
			rootDir = dir;
		}
	}
	const tsconfigPath = findNearestTsconfig(rootDir);
	if (tsconfigPath === undefined) {
		return { ok: false };
	}
	const cliEntry = fileURLToPath(new URL("../../index.js", import.meta.url));
	if (!existsSync(cliEntry)) {
		return { ok: false };
	}
	const runtime = resolveCliRuntime();
	if (runtime === undefined) {
		return { ok: false };
	}
	const ops = req.symbolNames.map((symbolName) => ({
		tool: "find_references",
		params: { tsconfigPath, symbolName },
	}));
	let stdout: string;
	try {
		stdout = execFileSync(
			runtime,
			[
				cliEntry,
				"batch",
				"--continue-on-error",
				"--params",
				JSON.stringify(ops),
			],
			{
				encoding: "utf-8",
				timeout: ANSWER_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: 64 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		// batch exits 1 when any op errored but still prints the full array;
		// a timeout or crash leaves nothing parseable and fails open below.
		const out = (error as { stdout?: unknown }).stdout;
		if (typeof out !== "string" || out === "") {
			return { ok: false };
		}
		stdout = out;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { ok: false };
	}
	const results = mapBatchResults(req.symbolNames, parsed);
	if (results === undefined) {
		return { ok: false };
	}
	if (!results.some((r) => r.status === "found" || r.status === "ambiguous")) {
		return { ok: false };
	}
	return { ok: true, text: formatSearchAnswer(tsconfigPath, results) };
};
