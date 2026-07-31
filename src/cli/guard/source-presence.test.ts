import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Counts directory reads without changing behavior: the walk's cost is the
// thing under test in the last case, and an ESM namespace cannot be spied.
const counter = vi.hoisted(() => ({ readdirCalls: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
			counter.readdirCalls++;
			return actual.readdirSync(...args);
		},
	};
});

const fs = await import("node:fs");
const { rootsContainSources } = await import("./source-presence.js");

/**
 * The gate that stops ts-surgeon advising a TypeScript toolset after a search
 * through Elixir (or Go, or Python). It is one-directional on purpose: false
 * ONLY when the searched roots exist and demonstrably hold no TS/JS.
 */

const tmpRoots: string[] = [];

function makeTree(
	label: string,
	build: (root: string) => void,
): { root: string; parent: string } {
	// A fresh directory per case: source-presence memoizes by absolute root.
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), `ts-surgeon-${label}-`));
	tmpRoots.push(parent);
	const root = path.join(parent, "tree");
	fs.mkdirSync(root, { recursive: true });
	build(root);
	return { root, parent };
}

afterAll(() => {
	for (const dir of tmpRoots) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("rootsContainSources", () => {
	it("is false for a directory that exists and holds no TS/JS", () => {
		const { root, parent } = makeTree("elixir", (dir) => {
			fs.mkdirSync(path.join(dir, "lib", "app"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "lib", "app", "worker.ex"),
				"defmodule App.Worker do\nend\n",
			);
			fs.writeFileSync(
				path.join(dir, "mix.exs"),
				"defmodule App.MixProject do\nend\n",
			);
		});
		expect(rootsContainSources(["tree"], parent)).toBe(false);
		expect(rootsContainSources([root], parent)).toBe(false);
	});

	it("is true as soon as one source file turns up", () => {
		const { parent } = makeTree("mixed", (dir) => {
			fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "lib", "worker.ex"),
				"defmodule W do\nend\n",
			);
			fs.mkdirSync(path.join(dir, "assets", "js"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "assets", "js", "app.ts"),
				"export const a = 1;\n",
			);
		});
		expect(rootsContainSources(["tree"], parent)).toBe(true);
	});

	it("does not claim absence for paths it cannot see", () => {
		const { parent } = makeTree("absent", () => {});
		// A path that does not exist proves nothing, so the previous behavior stands.
		expect(rootsContainSources(["no/such/dir"], parent)).toBe(true);
		// No paths at all: an unscoped search, which is not this gate's business.
		expect(rootsContainSources([], parent)).toBe(true);
	});

	it("lets an explicitly named source file answer for itself", () => {
		const { parent } = makeTree("named", (dir) => {
			fs.writeFileSync(path.join(dir, "app.ts"), "export const a = 1;\n");
			fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n");
		});
		expect(rootsContainSources(["tree/app.ts"], parent)).toBe(true);
		expect(rootsContainSources(["tree/notes.md"], parent)).toBe(false);
	});

	/**
	 * Regression: the walk kept draining its queue after the entry budget ran
	 * out, costing one readdirSync per already-queued directory (~1500 wasted
	 * syscalls on a wide tree). The result is `found || exhausted`, so both flags
	 * are terminal — once either is set the answer cannot change, and this runs
	 * in a PreToolUse hook that must not cost more than the grep it adjudicates.
	 */
	it("stops walking once the answer is decided", () => {
		const { root, parent } = makeTree("wide", (dir) => {
			// Wide and source-less: enough entries to exhaust the budget at depth 1,
			// with far more directories queued behind it than the budget allows.
			for (let i = 0; i < 40; i++) {
				for (let j = 0; j < 40; j++) {
					fs.mkdirSync(path.join(dir, `pkg${i}`, `sub${j}`), {
						recursive: true,
					});
				}
			}
		});
		counter.readdirCalls = 0;
		// Budget exhausted without proving absence, so the safe answer is true.
		expect(rootsContainSources([root], parent)).toBe(true);
		// 1 (root) + 40 (pkg dirs) is what the budget actually pays for; the 1600
		// queued leaves must not be read. Before the fix this was ~1501.
		expect(counter.readdirCalls).toBeLessThan(100);
	});
});
