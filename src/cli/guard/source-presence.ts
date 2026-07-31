import * as fs from "node:fs";
import * as path from "node:path";
import { SOURCE_EXT_RE } from "./scope.js";

/**
 * Does a searched path hold any TypeScript/JavaScript at all?
 *
 * The scope stage (scope.ts) reasons about extensions and filters; it treats a
 * bare directory as "unknown", which the policy reads as source. That is right
 * in a TS repo and wrong in a polyglot one: a `grep -r defmodule lib/` in an
 * Elixir directory came back with advice to use find_references/search_pattern
 * (defect report, 2026-07-29). Advice for a toolchain the searched code does
 * not use is noise, and noise is what teaches agents to tune the guard out.
 *
 * The check is deliberately one-directional: it returns false only when the
 * searched roots demonstrably contain no TS/JS. A root that does not exist, an
 * unreadable directory, or an exhausted budget all answer true — unknown keeps
 * the previous behavior, so a legitimate lookup is never dropped over a
 * filesystem hiccup.
 */

/** Directories never worth descending into when sniffing for project sources. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	"_build",
	"deps",
	"target",
	".next",
	".turbo",
	".cache",
]);

/**
 * Bounds the walk. This runs inside a PreToolUse hook — one process per tool
 * call, so nothing is reused between calls — and it must never cost more than
 * the grep it is deciding about. Breadth-first with both caps means a source
 * tree answers from the shallow levels, where source directories actually live,
 * and a source-less tree gives up quickly instead of walking a monorepo.
 */
const ENTRY_BUDGET = 1500;
const MAX_DEPTH = 6;

const cache = new Map<string, boolean>();

function containsSourceFile(root: string): boolean {
	const cached = cache.get(root);
	if (cached !== undefined) {
		return cached;
	}
	let budget = ENTRY_BUDGET;
	const queue: Array<{ dir: string; depth: number }> = [
		{ dir: root, depth: 0 },
	];
	let exhausted = false;
	let found = false;
	// Both flags are terminal: the result below is `found || exhausted`, so once
	// either is set nothing further can change the answer. Draining the rest of
	// the queue anyway cost one readdirSync per queued directory — ~1500 wasted
	// syscalls on a wide source-less tree, which is exactly the latency this
	// budget exists to prevent.
	while (queue.length > 0 && !found && !exhausted) {
		const { dir, depth } = queue.shift() as { dir: string; depth: number };
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			// Unreadable: cannot prove absence, so do not claim it.
			exhausted = true;
			break;
		}
		for (const entry of entries) {
			if (budget-- <= 0) {
				exhausted = true;
				break;
			}
			if (entry.isDirectory()) {
				if (depth >= MAX_DEPTH) {
					// Deeper than this is not worth a hook's latency; unknown, so
					// the answer stays "cannot prove absence".
					exhausted = true;
				} else if (!SKIP_DIRS.has(entry.name)) {
					queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
				}
			} else if (SOURCE_EXT_RE.test(entry.name)) {
				found = true;
				break;
			}
		}
	}
	const result = found || exhausted;
	cache.set(root, result);
	return result;
}

/**
 * True unless every searched root exists and provably holds no TS/JS sources.
 * Roots that do not exist on disk are ignored (an unresolvable path says
 * nothing); when none of them exist, the answer is true.
 */
export function rootsContainSources(paths: string[], cwd: string): boolean {
	const roots: string[] = [];
	for (const p of paths) {
		const absolute = path.resolve(cwd, p);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(absolute);
		} catch {
			continue;
		}
		if (stat.isFile()) {
			// An explicitly named file answers for itself.
			if (SOURCE_EXT_RE.test(absolute)) {
				return true;
			}
			continue;
		}
		roots.push(absolute);
	}
	if (roots.length === 0) {
		return paths.length === 0 || !paths.some((p) => existsOnDisk(p, cwd));
	}
	return roots.some(containsSourceFile);
}

function existsOnDisk(p: string, cwd: string): boolean {
	try {
		fs.statSync(path.resolve(cwd, p));
		return true;
	} catch {
		return false;
	}
}
