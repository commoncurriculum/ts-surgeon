import * as fs from "node:fs";
import { commandExists, run } from "./_child-process";
import { E2E_CACHE_DIR, type TargetRepo, targetCheckoutDir } from "./targets";

function readyMarkerPath(target: TargetRepo): string {
	return `${targetCheckoutDir(target)}.ready`;
}

/**
 * Clones the target repository at a pinned commit and installs its dependencies.
 * If already prepared (a .ready marker exists), returns the checkout directory immediately.
 *
 * - Shallow fetch of only the specific commit (GitHub allows SHA-targeted fetches).
 * - Dependencies are installed with frozen-lockfile + ignore-scripts to pin the
 *   lockfile and skip postinstall scripts.
 * - The .ready marker lives outside the checkout directory so git clean between
 *   scenarios does not remove it.
 */
export function prepareTarget(target: TargetRepo): string {
	const dir = targetCheckoutDir(target);
	const marker = readyMarkerPath(target);

	if (fs.existsSync(marker) && fs.existsSync(dir)) {
		return dir;
	}

	const pkgManager = target.installArgv[0];
	if (!commandExists(pkgManager)) {
		throw new Error(
			`[e2e] Package manager '${pkgManager}' not found (required to prepare ${target.name}).`,
		);
	}

	fs.mkdirSync(E2E_CACHE_DIR, { recursive: true });
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(marker, { force: true });
	fs.mkdirSync(dir, { recursive: true });

	const steps: Array<{ cmd: string; args: string[] }> = [
		{ cmd: "git", args: ["init", "-q"] },
		{ cmd: "git", args: ["remote", "add", "origin", target.repoUrl] },
		{ cmd: "git", args: ["fetch", "--depth", "1", "origin", target.commit] },
		{ cmd: "git", args: ["checkout", "-q", "--detach", "FETCH_HEAD"] },
	];
	for (const step of steps) {
		const { ok, output } = run(step.cmd, step.args, dir);
		if (!ok) {
			throw new Error(
				`[e2e] ${target.name}: '${step.cmd} ${step.args.join(" ")}' failed.\n${output}`,
			);
		}
	}

	const { ok, output } = run(pkgManager, target.installArgv.slice(1), dir);
	if (!ok) {
		throw new Error(
			`[e2e] ${target.name}: dependency install '${target.installArgv.join(" ")}' failed.\n${output}`,
		);
	}

	fs.writeFileSync(marker, `${target.commit}\n${new Date().toISOString()}\n`);
	return dir;
}
