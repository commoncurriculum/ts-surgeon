import { defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig({
	test: {
		// E2E tests (real repository clone-based) are run separately via pnpm test:e2e
		exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
		env: {
			API_ADDRESS: "http://localhost:8080",
		},
		restoreMocks: true,
		mockReset: true,
		clearMocks: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html", "lcov"],
			exclude: [
				"node_modules/**",
				"dist/**",
				"packages/sandbox/**",
				"**/*.test.ts",
				"**/*.spec.ts",
				"**/index.ts",
				"vitest.config.ts",
				"src/utils/logger.ts",
				"src/utils/logger-helpers.ts",
				"src/errors/**",
			],
			thresholds: {
				lines: 70,
				functions: 70,
				branches: 65,
				statements: 70,
			},
			clean: true,
			all: true,
		},
	},
});
