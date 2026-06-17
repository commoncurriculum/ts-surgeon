import { spawnSync } from "node:child_process";

/**
 * Clean environment variables for child processes.
 * Strips VITEST_* / NODE_OPTIONS (loaders, etc.) injected by the outer Vitest
 * so they are not inherited by the child's package manager or test runner.
 *
 * @param extra Additional environment variables to merge (e.g. CI / FORCE_COLOR).
 */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
	for (const key of Object.keys(env)) {
		if (key.startsWith("VITEST")) {
			delete env[key];
		}
	}
	env.NODE_OPTIONS = undefined;
	return env;
}

export interface RunResult {
	ok: boolean;
	output: string;
}

/**
 * Runs a child process synchronously and returns the combined stdout/stderr
 * output along with success/failure status. maxBuffer is set large because
 * dependency installs and test output can be substantial.
 *
 * @param extraEnv Additional environment variables to merge into childEnv.
 */
export function run(
	cmd: string,
	args: readonly string[],
	cwd: string,
	extraEnv: NodeJS.ProcessEnv = {},
): RunResult {
	const res = spawnSync(cmd, args as string[], {
		cwd,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
		env: childEnv(extraEnv),
	});
	const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
	if (res.error) {
		return { ok: false, output: `${res.error.message}\n${output}` };
	}
	return { ok: res.status === 0, output };
}

export function commandExists(cmd: string): boolean {
	const res = spawnSync(cmd, ["--version"], { encoding: "utf-8" });
	return !res.error && res.status === 0;
}
