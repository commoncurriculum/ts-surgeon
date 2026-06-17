import * as path from "node:path";

/**
 * Definition of the external repositories used as E2E targets.
 *
 * Versions must always be pinned (commit SHA pinning). The tag is a
 * human-readable label; the actual checkout is done by commit SHA so that
 * upstream changes do not affect results.
 */
export interface TargetRepo {
	/** Identifier (also used as the cache directory name). */
	readonly name: string;
	/** URL to clone from. */
	readonly repoUrl: string;
	/** Human-readable tag label (documentation only; the actual checkout uses the commit SHA). */
	readonly tag: string;
	/** Pinned commit SHA. After cloning, this SHA is checked out. */
	readonly commit: string;
	/**
	 * Repository-relative path to the tsconfig passed to MCP tools.
	 * A root tsconfig with project references (files:[]) does not load source files,
	 * so choose a config that includes the entire src tree.
	 */
	readonly tsconfigRelPath: string;
	/**
	 * Dependency install command (argv; [0] is the package manager executable on PATH).
	 * Uses frozen-lockfile + ignore-scripts to pin the lockfile and skip postinstall.
	 */
	readonly installArgv: readonly string[];
	/** Type-check: executable name and arguments under node_modules/.bin of the target repo. */
	readonly typecheckBin: string;
	readonly typecheckArgs: readonly string[];
	/**
	 * Unit tests: only the subset that runs under Node.
	 * format/lint are excluded because refactoring always produces diffs there.
	 */
	readonly unitTestBin: string;
	readonly unitTestArgs: readonly string[];
}

/**
 * hono: a medium-sized repository with no path aliases, native bun.
 * Used as the target for rename / find-references / move / find-unused / get-type / change-signature.
 * The root tsconfig uses project references, so tsconfig.spec.json (which includes the full src tree) is used.
 * vitest uses a multi-runtime setup, so only the `main` project (Node) is executed.
 */
export const HONO: TargetRepo = {
	name: "hono",
	repoUrl: "https://github.com/honojs/hono.git",
	tag: "v4.12.23",
	commit: "83bfb3bb4a12c1d92c163a39e907df5d662ff78d",
	tsconfigRelPath: "tsconfig.spec.json",
	installArgv: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
	typecheckBin: "tsc",
	typecheckArgs: ["--noEmit", "-p", "tsconfig.spec.json"],
	unitTestBin: "vitest",
	unitTestArgs: ["run", "--project", "main"],
};

/**
 * zustand: a single package with path aliases (zustand / zustand/* → ./src/*), using pnpm.
 * Used as the target for remove_path_alias and rename-file-system (import updates via aliases).
 * Type-checking uses the root tsconfig.json (includes src + tests, noEmit).
 */
export const ZUSTAND: TargetRepo = {
	name: "zustand",
	repoUrl: "https://github.com/pmndrs/zustand.git",
	tag: "v5.0.13",
	commit: "6bc451efd5f0d4ef6e7b2c8d6fc6f8340562a31d",
	tsconfigRelPath: "tsconfig.json",
	installArgv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
	typecheckBin: "tsc",
	typecheckArgs: ["--noEmit"],
	unitTestBin: "vitest",
	unitTestArgs: ["run"],
};

export const E2E_CACHE_DIR = path.resolve(__dirname, ".cache");

export function targetCheckoutDir(target: TargetRepo): string {
	return path.join(
		E2E_CACHE_DIR,
		`${target.name}@${target.commit.slice(0, 12)}`,
	);
}
