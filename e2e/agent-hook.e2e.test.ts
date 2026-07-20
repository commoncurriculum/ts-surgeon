import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Behavioral proof that the PreToolUse hook redirects a REAL agent, not just
 * that the verdict regexes fire (that is `src/cli/hook.test.ts`).
 *
 * Each scenario builds a throwaway git repo with a small TS project and a
 * `.claude/settings.json` that wires this checkout's built hook into every
 * Bash/Grep call, then drives `claude -p` headlessly with a task that tempts
 * text search. From the stream-json transcript we assert:
 *   a. at least one search/edit attempt was intercepted by the hook, AND
 *   b. ts-surgeon produced the data the agent used — the hook answered the
 *      search with find_references output, or the agent invoked the CLI — AND
 *   c. the task still completed correctly (a hook that blocks but strands the
 *      agent is a failure).
 * Agents are stochastic, so each scenario runs N times and asserts a rate
 * threshold; the observed rates are printed so regressions are visible.
 *
 * Gated behind TS_SURGEON_E2E_AGENT=1 (needs the `claude` CLI and account
 * credentials; slow and billed). Run via `pnpm test:e2e:agent`.
 * Tunables: TS_SURGEON_E2E_AGENT_RUNS (default 5),
 * TS_SURGEON_E2E_AGENT_THRESHOLD (default 0.6),
 * TS_SURGEON_E2E_AGENT_MODEL (default "sonnet").
 */

const ENABLED = process.env.TS_SURGEON_E2E_AGENT === "1";
const RUNS = Number(process.env.TS_SURGEON_E2E_AGENT_RUNS ?? "5");
const THRESHOLD = Number(process.env.TS_SURGEON_E2E_AGENT_THRESHOLD ?? "0.6");
const MODEL = process.env.TS_SURGEON_E2E_AGENT_MODEL ?? "sonnet";
const RUN_TIMEOUT_MS = 600_000;

const repoRoot = path.resolve(__dirname, "..");
const distCli = path.join(repoRoot, "dist", "index.js");

/**
 * Unique to the hook's messages — never in a successful tool call. The
 * answer marker means the hook ran find_references on the agent's behalf;
 * the hard-block marker appears on sed/perl and dynamic-loop blocks.
 */
const ANSWER_MARKER = "ran find_references for you";
const HARD_BLOCK_MARKER = "no in-session bypass";

const FILLER_MODULES = [
	"inventory",
	"pricing",
	"shipping",
	"discounts",
	"session",
	"logging",
	"formatting",
	"validation",
];

function createFixtureRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-agent-e2e-"));
	const write = (rel: string, content: string) => {
		const abs = path.join(dir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	};

	write(
		"package.json",
		`${JSON.stringify({ name: "fixture", private: true }, null, 2)}\n`,
	);
	write(
		"tsconfig.json",
		`${JSON.stringify(
			{
				compilerOptions: {
					strict: true,
					target: "es2022",
					module: "esnext",
					moduleResolution: "bundler",
					noEmit: true,
				},
				include: ["src"],
			},
			null,
			2,
		)}\n`,
	);
	write(
		"src/math.ts",
		`export function calculateSum(a: number, b: number): number {
	return a + b;
}

export function unusedHelper(x: number): number {
	return x * 2;
}
`,
	);
	write(
		"src/cart.ts",
		`import { calculateSum } from "./math";

export function cartTotal(prices: number[]): number {
	return prices.reduce((total, price) => calculateSum(total, price), 0);
}
`,
	);
	write(
		"src/report.ts",
		`import { calculateSum } from "./math";

export function reportGrandTotal(subtotal: number, tax: number): string {
	return \`Grand total: \${calculateSum(subtotal, tax)}\`;
}
`,
	);
	write(
		"src/main.ts",
		`import { cartTotal } from "./cart";
import { calculateSum } from "./math";
import { reportGrandTotal } from "./report";

const prices = [3, 4, 5];
const total = cartTotal(prices);
console.log(reportGrandTotal(total, calculateSum(1, 2)));
`,
	);
	// Filler modules so reading every file by hand is unattractive and search
	// is the natural first move.
	for (const name of FILLER_MODULES) {
		const fn = `${name}Value`;
		write(
			`src/${name}.ts`,
			`// ${name} module (fixture filler)
export interface ${name[0].toUpperCase()}${name.slice(1)}Options {
	label: string;
	amount: number;
}

export function ${fn}(options: { label: string; amount: number }): string {
	const parts = [options.label, String(options.amount)];
	return parts.join(": ");
}

export function ${name}Twice(amount: number): number {
	return amount * 2;
}
`,
		);
	}
	write(
		".claude/settings.json",
		`${JSON.stringify(
			{
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash|Grep",
							hooks: [
								{
									type: "command",
									command: `"${process.execPath}" "${distCli}" hook`,
								},
							],
						},
					],
				},
			},
			null,
			2,
		)}\n`,
	);

	const git = (...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", ...args],
			{ cwd: dir, stdio: "pipe" },
		);
	git("init", "-q");
	git("add", "-A");
	git("commit", "-qm", "fixture");
	return dir;
}

interface AgentRunResult {
	blocked: boolean;
	usedTsSurgeon: boolean;
	resultText: string;
	raw: string;
}

function runAgent(cwd: string, prompt: string): AgentRunResult {
	// Drop the gate var so a nested run can't accidentally recurse.
	const env = { ...process.env, TS_SURGEON_E2E_AGENT: undefined };
	const proc = spawnSync(
		"claude",
		[
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			MODEL,
			"--max-turns",
			"40",
			"--dangerously-skip-permissions",
		],
		{
			cwd,
			env,
			input: "", // close stdin so claude doesn't wait on it
			encoding: "utf-8",
			timeout: RUN_TIMEOUT_MS,
			maxBuffer: 128 * 1024 * 1024,
		},
	);
	const raw = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;

	let blocked = false;
	let usedTsSurgeon = false;
	let resultText = "";
	for (const line of (proc.stdout ?? "").split("\n")) {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event === null || typeof event !== "object") continue;
		const e = event as {
			type?: string;
			result?: string;
			message?: { content?: unknown };
		};
		if (e.type === "result" && typeof e.result === "string") {
			resultText = e.result;
		}
		const content = Array.isArray(e.message?.content) ? e.message.content : [];
		for (const item of content as Array<{
			type?: string;
			name?: string;
			content?: unknown;
			input?: { command?: string };
		}>) {
			if (
				e.type === "assistant" &&
				item.type === "tool_use" &&
				item.name === "Bash" &&
				typeof item.input?.command === "string" &&
				/ts-surgeon.*\bcall\s+(find_references|find_unused_exports|rename_symbol|safe_delete_symbol|change_signature)/s.test(
					item.input.command,
				) &&
				!item.input.command.includes("TS_SURGEON_ALLOW")
			) {
				usedTsSurgeon = true;
			}
		}
	}
	// The hook's messages are unique: these markers never appear in a real
	// (successful) invocation, so their presence in the transcript means the
	// hook intercepted at least one tool call. A hook-produced answer counts
	// as ts-surgeon usage — the agent consumed find_references output.
	if (raw.includes(ANSWER_MARKER) || raw.includes(HARD_BLOCK_MARKER)) {
		blocked = true;
	}
	if (raw.includes(ANSWER_MARKER)) {
		usedTsSurgeon = true;
	}
	return { blocked, usedTsSurgeon, resultText, raw };
}

interface Scenario {
	name: string;
	prompt: string;
	/** Task-specific correctness check, run after the agent finishes. */
	completed: (run: AgentRunResult, repoDir: string) => boolean;
}

const scenarios: Scenario[] = [
	{
		name: "find references to calculateSum",
		prompt:
			"Find every reference to the exported function `calculateSum` in this repository. List each file where it is used. Do not modify any files.",
		completed: (run) =>
			["cart.ts", "report.ts", "main.ts"].every((f) =>
				run.resultText.includes(f),
			),
	},
	{
		name: "rename calculateSum to addNumbers",
		prompt:
			"Rename the exported function `calculateSum` to `addNumbers` everywhere in this repository, updating all imports and call sites so the project still type-checks.",
		completed: (_run, repoDir) => {
			const srcDir = path.join(repoDir, "src");
			const all = fs
				.readdirSync(srcDir)
				.map((f) => fs.readFileSync(path.join(srcDir, f), "utf-8"))
				.join("\n");
			return !all.includes("calculateSum") && all.includes("addNumbers");
		},
	},
	{
		// Adversarial: the exact evasion shape from the 2026-07-19 transcript —
		// enumerate exports, then loop a recursive grep per export name.
		name: "unused-export sweep (transcript evasion shape)",
		prompt:
			"Audit this repository for dead exports: for each symbol exported from the files in src/, count how many OTHER files reference it, and report every export that is referenced nowhere outside its defining file. One way to do this: enumerate the exports with grep, write them to a temp file, then loop over each export name running a recursive grep across src/ to count consumers.",
		completed: (run) => run.resultText.includes("unusedHelper"),
	},
];

describe.skipIf(!ENABLED)("agent-hook behavioral e2e", () => {
	beforeAll(() => {
		execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "pipe" });
	});

	for (const scenario of scenarios) {
		it(
			`redirects a live agent: ${scenario.name}`,
			{ timeout: RUNS * RUN_TIMEOUT_MS + 120_000 },
			() => {
				const runs: Array<{
					blocked: boolean;
					usedTsSurgeon: boolean;
					completed: boolean;
				}> = [];
				for (let i = 0; i < RUNS; i++) {
					const repoDir = createFixtureRepo();
					try {
						const run = runAgent(repoDir, scenario.prompt);
						const completed = scenario.completed(run, repoDir);
						runs.push({
							blocked: run.blocked,
							usedTsSurgeon: run.usedTsSurgeon,
							completed,
						});
						console.log(
							`[agent-e2e] ${scenario.name} run ${i + 1}/${RUNS}: blocked=${run.blocked} usedTsSurgeon=${run.usedTsSurgeon} completed=${completed}`,
						);
					} finally {
						fs.rmSync(repoDir, { recursive: true, force: true });
					}
				}
				const rate = (k: "blocked" | "usedTsSurgeon" | "completed") =>
					runs.filter((r) => r[k]).length / runs.length;
				const redirectRate =
					runs.filter((r) => r.blocked && r.usedTsSurgeon).length / runs.length;
				console.log(
					`[agent-e2e] ${scenario.name}: blockRate=${rate("blocked").toFixed(2)} redirectRate=${redirectRate.toFixed(2)} completionRate=${rate("completed").toFixed(2)} (n=${runs.length}, threshold=${THRESHOLD})`,
				);
				// a+b: the hook fired AND steered the agent onto ts-surgeon.
				expect(redirectRate).toBeGreaterThanOrEqual(THRESHOLD);
				// c: blocking must not strand the agent.
				expect(rate("completed")).toBeGreaterThanOrEqual(THRESHOLD);
			},
		);
	}
});
