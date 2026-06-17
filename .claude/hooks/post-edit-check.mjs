#!/usr/bin/env node
// PostToolUse hook: when a .ts file under src is edited, run the related tests + type check.
// On failure, exit 2 to return stderr to Claude and prompt a fix.
// Input: the Claude Code PostToolUse JSON on stdin (tool_name / tool_input.file_path, etc.).

import { execFileSync } from "node:child_process";
import { relative, isAbsolute } from "node:path";

function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
	});
}

const raw = await readStdin();
let payload;
try {
	payload = JSON.parse(raw);
} catch {
	// Not JSON — do nothing
	process.exit(0);
}

const filePath = payload?.tool_input?.file_path;
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

if (!filePath) process.exit(0);

const rel = isAbsolute(filePath) ? relative(projectDir, filePath) : filePath;

// Only target .ts/.tsx under src (excluding .d.ts and dist/coverage/node_modules)
const isTarget =
	rel.startsWith("src/") && /\.(ts|tsx)$/.test(rel) && !rel.endsWith(".d.ts");

if (!isTarget) process.exit(0);

const failures = [];

function run(label, file, args) {
	try {
		execFileSync(file, args, {
			cwd: projectDir,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		});
	} catch (err) {
		const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
		failures.push(`### ${label} failed\n${out}`);
	}
}

const vitestArgs = [
	"exec",
	"vitest",
	rel.includes(".test.") ? "run" : "related",
	rel,
	"--run",
	"--pool",
	"threads",
	"--poolOptions.threads.singleThread",
];

run("Related tests", "pnpm", vitestArgs);
run("Type check (check-types)", "pnpm", ["run", "check-types"]);

if (failures.length > 0) {
	process.stderr.write(
		`Post-edit check detected problems (${rel}):\n\n${failures.join("\n\n")}\n`,
	);
	process.exit(2);
}

process.exit(0);
