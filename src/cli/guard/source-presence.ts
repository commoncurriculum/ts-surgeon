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

/** Bounds the walk: a source-less tree must not cost more than a few ms. */
const ENTRY_BUDGET = 3000;

const cache = new Map<string, boolean>();

function containsSourceFile(root: string): boolean {
	const cached = cache.get(root);
	if (cached !== undefined) {
		return cached;
	}
	let budget = ENTRY_BUDGET;
	const queue: string[] = [root];
	let exhausted = false;
	let found = false;
	while (queue.length > 0 && !found) {
		const dir = queue.shift() as string;
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
				if (!SKIP_DIRS.has(entry.name)) {
					queue.push(path.join(dir, entry.name));
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
