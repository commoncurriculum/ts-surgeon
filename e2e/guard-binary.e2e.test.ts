import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childEnv } from "./_child-process.js";

/**
 * `ts-surgeon install` end to end: compile the guard, point the hook config at
 * it, and prove the artifact actually guards.
 *
 * The point of compiling is that the hook config can name the executable
 * directly — through npx the same decision costs ~590ms per tool call instead
 * of ~15ms, and putting a shell wrapper in front to pick a fallback costs most
 * of the difference back. So this asserts the exact command shape, not just
 * that something was written.
 *
 * The binary embeds its own runtime, which is what lets bun be a build-time
 * dependency only. That claim is only worth anything if it is checked, so the
 * guard runs here with bun and node removed from PATH.
 *
 * Offline after the first `npx -y bun`; run via `pnpm test:e2e:guard`.
 */

const repoRoot = path.resolve(__dirname, "..");
const distCli = path.join(repoRoot, "dist", "index.js");

let home: string;
let project: string;
let binaryPath: string;
/** A PATH with no runtimes on it, to prove the binary needs none. */
let barePath: string;

function runGuard(
	payload: unknown,
	args: string[] = [],
): { status: number; stderr: string } {
	const res = spawnSync(binaryPath, args, {
		input: JSON.stringify(payload),
		encoding: "utf-8",
		maxBuffer: 16 * 1024 * 1024,
		// env -i equivalent: nothing inherited, no runtime reachable.
		env: { PATH: barePath, HOME: home },
	});
	if (res.error) {
		throw res.error;
	}
	return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

beforeAll(() => {
	expect(
		fs.existsSync(distCli),
		`${distCli} is missing — run \`pnpm build\` before \`pnpm test:e2e:guard\`.`,
	).toBe(true);

	home = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-guard-home-"));
	project = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-guard-proj-"));
	barePath = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-guard-path-"));

	// HOME decides the cache location, so the real one is never touched.
	const install = spawnSync(process.execPath, [distCli, "install"], {
		cwd: project,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
		env: childEnv({ HOME: home }),
	});
	expect(
		install.status,
		`install failed:\n${install.stdout}\n${install.stderr}`,
	).toBe(0);

	const settings = JSON.parse(
		fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf-8"),
	);
	binaryPath = path.join(home, ".cache", "ts-surgeon");
	binaryPath = path.join(
		binaryPath,
		fs.readdirSync(binaryPath).find((f) => f.startsWith("guard-")) ?? "missing",
	);
	expect(fs.existsSync(binaryPath)).toBe(true);

	// Stash for the command-shape assertions below.
	(globalThis as { __settings?: unknown }).__settings = settings;
});

afterAll(() => {
	for (const dir of [home, project, barePath]) {
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("ts-surgeon install", () => {
	it("names the executable directly, with no npx and no shell wrapper", () => {
		const settings = (globalThis as { __settings?: SettingsShape }).__settings;
		const pre = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? "";
		const post = settings?.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command ?? "";

		expect(pre).toBe(`"${binaryPath}"`);
		expect(post).toBe(`"${binaryPath}" --post`);
		for (const command of [pre, post]) {
			expect(command).not.toContain("npx");
			expect(command).not.toMatch(/\bif\b|&&|\|\||;/);
		}
	});

	it("blocks an in-place source edit with no runtime on PATH", () => {
		const { status, stderr } = runGuard({
			tool_name: "Bash",
			tool_input: { command: "sed -i '' s/a/b/ src/thing.ts" },
			cwd: project,
		});

		expect(stderr).toContain("ts-surgeon");
		expect(status).toBe(2);
	});

	it("allows an ordinary command with no runtime on PATH", () => {
		const { status, stderr } = runGuard({
			tool_name: "Bash",
			tool_input: { command: "ls -la" },
			cwd: project,
		});

		expect(stderr).toBe("");
		expect(status).toBe(0);
	});

	/**
	 * The expensive tier from inside the compiled guard. This is the only place
	 * that exercises tsgo resolution the way it actually ships: under Vitest,
	 * Vite's resolver finds the platform binary even when Node's would not, so
	 * a unit test here passes while the built artifact fails open silently.
	 */
	it("answers an identifier search from the compiled binary", () => {
		fs.mkdirSync(path.join(project, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(project, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { strict: true, target: "es2020" },
				include: ["src/**/*"],
			}),
		);
		fs.writeFileSync(
			path.join(project, "src", "util.ts"),
			"export function splitTitle(v: string) {\n\treturn v.split(' ');\n}\n",
		);
		fs.writeFileSync(
			path.join(project, "src", "use.ts"),
			"import { splitTitle } from './util.js';\nexport const a = splitTitle('x');\n",
		);

		// PATH must stay intact here: the guard spawns tsgo for this tier.
		const res = spawnSync(binaryPath, [], {
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "rg splitTitle src" },
				cwd: project,
			}),
			encoding: "utf-8",
			maxBuffer: 16 * 1024 * 1024,
			env: childEnv({ HOME: home }),
		});

		expect(res.stderr).toContain("ran find_references for you");
		expect(res.stderr).toContain("splitTitle");
		expect(res.stderr).toContain("src/use.ts");
		expect(res.status).toBe(2);
	});

	it("runs the teaching hook with no runtime on PATH", () => {
		const { status } = runGuard(
			{
				tool_name: "Bash",
				tool_input: { command: "ls -la" },
				cwd: project,
			},
			["--post"],
		);

		expect(status).toBe(0);
	});
});

interface SettingsShape {
	hooks?: {
		PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }>;
		PostToolUse?: Array<{ hooks?: Array<{ command?: string }> }>;
	};
}
