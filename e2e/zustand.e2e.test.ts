import { beforeAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { ZUSTAND } from "./targets";
import { absPath, createScenario, textOf, tsconfigPathOf } from "./scenario";

const { harness, setup, reset, requirePrepared, expectNoRegression } =
	createScenario(ZUSTAND);

beforeAll(setup, 600_000);
afterEach(reset);

describe("zustand E2E (alias-related, differential-green verification)", () => {
	it("remove_path_alias: converting zustand alias imports in tests to relative paths keeps types/tests green", async (ctx) => {
		requirePrepared(ctx);
		const targetPath = absPath(ZUSTAND, "tests/basic.test.tsx");

		const before = fs.readFileSync(targetPath, "utf-8");
		expect(before).toMatch(/from 'zustand'/);

		const result = await harness.callTool("remove_path_alias_by_tsmorph", {
			tsconfigPath: tsconfigPathOf(ZUSTAND),
			targetPath,
			dryRun: false,
		});

		expect(result.isError, textOf(result)).toBeFalsy();
		const after = fs.readFileSync(targetPath, "utf-8");
		// Alias has been replaced with a relative path
		expect(after).not.toMatch(/from 'zustand'/);
		expect(after).toMatch(/from '\.\.\/src/);

		expectNoRegression();
	});

	it("rename_filesystem_entry: renaming a middleware file and updating imports keeps types/tests green", async (ctx) => {
		requirePrepared(ctx);
		const oldPath = absPath(ZUSTAND, "src/middleware/combine.ts");
		const newPath = absPath(ZUSTAND, "src/middleware/_e2e-combine.ts");

		const result = await harness.callTool(
			"rename_filesystem_entry_by_tsmorph",
			{
				tsconfigPath: tsconfigPathOf(ZUSTAND),
				renames: [{ oldPath, newPath }],
				dryRun: false,
			},
		);

		expect(result.isError, textOf(result)).toBeFalsy();
		expect(fs.existsSync(newPath)).toBe(true);
		expect(fs.existsSync(oldPath)).toBe(false);

		expectNoRegression();
	});
});
