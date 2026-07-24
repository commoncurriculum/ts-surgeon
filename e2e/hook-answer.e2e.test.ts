import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childEnv } from "./_child-process.js";

/**
 * The guard's bargain, driven end to end: a real project on disk, the real
 * built CLI, real exit codes. A name with no project declaration must let the
 * search run (exit 0); a real symbol must still be answered (exit 2).
 *
 * Lives in e2e because it needs `dist/` — under Vitest the source build
 * resolves its own CLI entry to `src/index.js`, which never exists, so the
 * answerer always fails open and any assertion about exit 0 would pass
 * vacuously. Here the two cases share one fixture and one binary, so the
 * exit-0 case cannot pass for the wrong reason: a broken or missing CLI takes
 * the exit-2 case down with it.
 *
 * Offline and fast, unlike the clone-based e2e suites — run in CI via
 * `pnpm test:e2e:hook`.
 */

const repoRoot = path.resolve(__dirname, "..");
const distCli = path.join(repoRoot, "dist", "index.js");

/** Unique to the hook's answer; never printed by a search it let through. */
const ANSWER_MARKER = "ran find_references for you";

let fixture: string;

function runHook(command: string): { status: number; stderr: string } {
	const res = spawnSync(process.execPath, [distCli, "hook"], {
		input: JSON.stringify({
			tool_name: "Bash",
			tool_input: { command },
			cwd: fixture,
		}),
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
		// Generous budget so a cold parse cannot time out into a false fail-open.
		env: childEnv({ TS_SURGEON_ANSWER_TIMEOUT_MS: "120000" }),
	});
	if (res.error) {
		throw res.error;
	}
	return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

beforeAll(() => {
	// A missing build must fail loudly here, not silently skip: a skipped
	// guarantee reads exactly like a kept one.
	expect(
		fs.existsSync(distCli),
		`${distCli} is missing — run \`pnpm build\` before \`pnpm test:e2e:hook\`.`,
	).toBe(true);

	fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-hook-answer-"));
	const src = path.join(fixture, "src");
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(
		path.join(fixture, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { strict: true, target: "es2020" },
			include: ["src/**/*"],
		}),
	);
	// A CSS-module import is an index signature: `styles.lessonTitle` has no
	// declaration to find, which is the whole point of the fixture.
	fs.writeFileSync(
		path.join(src, "styles.d.ts"),
		"declare const styles: Record<string, string>;\nexport default styles;\n",
	);
	fs.writeFileSync(
		path.join(src, "title.ts"),
		`import styles from './styles';

export function splitTitle(value: string): string[] {
	return value.split(' ');
}

export const attrs = { class: styles.lessonTitle };
export const parts = splitTitle('a b');
`,
	);
});

afterAll(() => {
	if (fixture) {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

describe("hook answers", () => {
	it("lets a search run when the name has no project declaration", () => {
		const { status, stderr } = runHook("rg lessonTitle src");

		expect(stderr).not.toContain(ANSWER_MARKER);
		expect(status).toBe(0);
	});

	it("still answers a search for a real symbol", () => {
		const { status, stderr } = runHook("rg splitTitle src");

		expect(stderr).toContain(ANSWER_MARKER);
		expect(stderr).toContain("splitTitle");
		expect(status).toBe(2);
	});
});
