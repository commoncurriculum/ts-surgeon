import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childEnv } from "./_child-process.js";

/**
 * The guard answering an identifier search through `node dist/index.js` — the
 * shape `npx … ts-surgeon hook` runs, and the one opencode uses.
 *
 * This exists because a unit test could not catch the bug it guards. tsgo's
 * platform binary is an optional dependency *of* @typescript/native-preview,
 * so under pnpm it is resolvable only from that package's directory. Vitest's
 * resolver finds it anyway, and so does a bun-compiled binary; plain Node
 * running dist/ does not. The result was a guard that silently failed open on
 * every identifier search while every test stayed green.
 *
 * Offline once tsgo is installed; run via `pnpm test:e2e:tsgo`.
 */

const repoRoot = path.resolve(__dirname, "..");
const distCli = path.join(repoRoot, "dist", "index.js");

let project: string;

beforeAll(() => {
	expect(
		fs.existsSync(distCli),
		`${distCli} is missing — run \`pnpm build\` before \`pnpm test:e2e:tsgo\`.`,
	).toBe(true);

	project = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-tsgo-answer-"));
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
});

afterAll(() => {
	if (project) {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

function runHook(command: string): { status: number; stderr: string } {
	const res = spawnSync(process.execPath, [distCli, "hook"], {
		input: JSON.stringify({
			tool_name: "Bash",
			tool_input: { command },
			cwd: project,
		}),
		encoding: "utf-8",
		maxBuffer: 16 * 1024 * 1024,
		env: childEnv({ TS_SURGEON_ANSWER_TIMEOUT_MS: "120000" }),
	});
	if (res.error) {
		throw res.error;
	}
	return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

describe("tsgo answers through the built CLI", () => {
	it("answers an identifier search with real references", () => {
		const { status, stderr } = runHook("rg splitTitle src");

		expect(stderr).toContain("ran find_references for you");
		expect(stderr).toContain("src/util.ts");
		expect(stderr).toContain("src/use.ts");
		expect(status).toBe(2);
	});

	it("still lets a search run when nothing declares the name", () => {
		const { status, stderr } = runHook("rg neverDeclaredAnywhere src");

		expect(stderr).not.toContain("ran find_references for you");
		expect(status).toBe(0);
	});
});
