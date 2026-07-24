import { runHook, runPostHook } from "./cli/hook.js";
import { readStdinDefault } from "./cli/params.js";

/**
 * Entry point of the compiled guard binary (`ts-surgeon install`).
 *
 * The guard runs on every single tool call, so it must not pay for anything it
 * does not use: no tool registry, no ts-morph, no TypeScript compiler. It
 * reuses runHook/runPostHook so there is exactly one decision path shared with
 * `ts-surgeon hook`; only the entry differs. The expensive tier (an actual
 * find_references answer) is a child process, spawned from answer.ts.
 */

const command = process.argv[2];
const out = { write: (chunk: string) => process.stdout.write(chunk) };
const err = { write: (chunk: string) => process.stderr.write(chunk) };

try {
	process.exitCode =
		command === "--post"
			? runPostHook(readStdinDefault, out)
			: runHook([], readStdinDefault, err);
} catch {
	// The guard must never break the harness: anything unexpected allows.
	process.exitCode = 0;
}
