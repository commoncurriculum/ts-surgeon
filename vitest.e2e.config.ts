import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for E2E tests.
 *
 * Clones well-known OSS projects (hono, etc.) at pinned versions, applies each
 * MCP tool to the real project, then verifies that type-checking and the target
 * repository's unit tests produce the same result before and after refactoring
 * (differential green).
 *
 * Slow and network-dependent due to cloning and dependency installation.
 * Excluded from the default `pnpm test`; run explicitly with `pnpm test:e2e`.
 */
export default defineConfig({
	test: {
		include: ["e2e/**/*.e2e.test.ts"],
		// Long timeout because a single case runs clone + bun install + tsc + vitest
		testTimeout: 600_000,
		hookTimeout: 600_000,
		// Run serially because test files share the target repository working directory
		fileParallelism: false,
		pool: "threads",
		poolOptions: {
			threads: {
				singleThread: true,
			},
		},
	},
});
