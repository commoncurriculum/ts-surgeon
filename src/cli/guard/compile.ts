import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../version.js";

/**
 * Compiles the guard into a standalone executable with bun.
 *
 * The guard runs on every tool call, so what it costs is what the harness
 * costs. Through npx that is ~554ms per invocation — npx re-resolving the
 * package, then Node loading a module graph — to decide that `ls` is
 * harmless. Compiled and named directly in the hook config it is ~15ms.
 *
 * bun is a *build-time* dependency only: `npx -y bun` fetches it, and the
 * executable it produces embeds its own runtime, so the machine running the
 * guard needs neither bun nor node afterwards. That is why there is one path
 * here and no fallback ladder — a working npm is already assumed by every
 * other way this package is installed.
 *
 * The binary must be named directly by the hook config: putting a shell test
 * in front of it to pick a fallback costs ~2.5ms, which is most of what
 * compiling buys.
 */

/** Version-stamped so a package upgrade cannot leave a stale guard behind. */
export function guardBinaryPath(): string {
	return path.join(
		os.homedir(),
		".cache",
		"ts-surgeon",
		`guard-${VERSION}${process.platform === "win32" ? ".exe" : ""}`,
	);
}

/** The built guard entry shipped in this package. */
function guardEntryPath(): string {
	return fileURLToPath(new URL("../../guard-main.js", import.meta.url));
}

export interface CompileResult {
	binaryPath: string;
	alreadyPresent: boolean;
}

/**
 * Builds the guard executable unless the version-stamped one already exists.
 * Throws with bun's own output when the compile fails — a guard that silently
 * did not build would leave the hook config pointing at nothing.
 */
export function compileGuardBinary(force = false): CompileResult {
	const binaryPath = guardBinaryPath();
	if (!force && existsSync(binaryPath)) {
		return { binaryPath, alreadyPresent: true };
	}
	const entry = guardEntryPath();
	if (!existsSync(entry)) {
		throw new Error(
			`Cannot compile the guard: ${entry} is missing. Run \`pnpm build\` first if you are working from a checkout.`,
		);
	}
	mkdirSync(path.dirname(binaryPath), { recursive: true });
	try {
		execFileSync(
			"npx",
			[
				"-y",
				"bun",
				"build",
				entry,
				"--compile",
				"--bytecode",
				"--minify",
				"--outfile",
				binaryPath,
			],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		const detail =
			(error as { stderr?: string }).stderr ??
			(error as Error).message ??
			"unknown error";
		throw new Error(`bun failed to compile the guard:\n${detail}`);
	}
	if (!existsSync(binaryPath)) {
		throw new Error(`bun reported success but ${binaryPath} does not exist.`);
	}
	return { binaryPath, alreadyPresent: false };
}
