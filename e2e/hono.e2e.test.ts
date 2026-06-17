import { beforeAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { HONO } from "./targets";
import {
	absPath,
	createScenario,
	isWorkingTreeClean,
	locateSymbolPosition,
	textOf,
	tsconfigPathOf,
} from "./scenario";

const URL_FILE = "src/utils/url.ts";

const { harness, setup, reset, requirePrepared, expectNoRegression } =
	createScenario(HONO);

beforeAll(setup, 600_000);
afterEach(reset);

describe("hono E2E (read-only tools)", () => {
	it("find_references: returns at least one reference for getPattern", async (ctx) => {
		requirePrepared(ctx);
		const { absFilePath, position } = locateSymbolPosition(
			HONO,
			URL_FILE,
			"getPattern",
		);

		const result = await harness.callTool("find_references_by_tsmorph", {
			tsconfigPath: tsconfigPathOf(HONO),
			targetFilePath: absFilePath,
			position,
		});

		expect(result.isError).toBeFalsy();
		expect(textOf(result).toLowerCase()).toContain("reference");
	});

	it("get_type_at_position: retrieves type information for getPattern", async (ctx) => {
		requirePrepared(ctx);
		const { absFilePath, position } = locateSymbolPosition(
			HONO,
			URL_FILE,
			"getPattern",
		);

		const result = await harness.callTool("get_type_at_position_by_tsmorph", {
			tsconfigPath: tsconfigPathOf(HONO),
			targetFilePath: absFilePath,
			position,
		});

		expect(result.isError).toBeFalsy();
		const text = textOf(result);
		expect(text).toContain("Type:");
		expect(text).toContain("getPattern");
	});

	it("find_unused_exports: lists candidates without error", async (ctx) => {
		requirePrepared(ctx);
		const result = await harness.callTool("find_unused_exports_by_tsmorph", {
			tsconfigPath: tsconfigPathOf(HONO),
		});

		expect(result.isError).toBeFalsy();
		const text = textOf(result);
		expect(
			text.includes("Unused export candidates") ||
				text.includes("No unused exports found"),
		).toBe(true);
	});
});

describe("hono E2E (mutating tools, differential-green verification)", () => {
	it("rename_symbol: round-trip rename of getPattern restores original & types/tests stay green", async (ctx) => {
		requirePrepared(ctx);
		const tsconfigPath = tsconfigPathOf(HONO);
		const tmpName = "getPattern_e2e_tmp";

		const forward = locateSymbolPosition(HONO, URL_FILE, "getPattern");
		const r1 = await harness.callTool("rename_symbol_by_tsmorph", {
			tsconfigPath,
			targetFilePath: forward.absFilePath,
			position: forward.position,
			symbolName: "getPattern",
			newName: tmpName,
			dryRun: false,
		});
		expect(r1.isError).toBeFalsy();

		expectNoRegression();

		// Round-trip: rename back to original
		const back = locateSymbolPosition(HONO, URL_FILE, tmpName);
		const r2 = await harness.callTool("rename_symbol_by_tsmorph", {
			tsconfigPath,
			targetFilePath: back.absFilePath,
			position: back.position,
			symbolName: tmpName,
			newName: "getPattern",
			dryRun: false,
		});
		expect(r2.isError).toBeFalsy();
		expect(isWorkingTreeClean(HONO)).toBe(true);
	});

	it("move_symbol_to_file: moving getPattern to another file keeps types/tests green", async (ctx) => {
		requirePrepared(ctx);
		const targetFilePath = absPath(HONO, "src/utils/_e2e-get-pattern.ts");

		const result = await harness.callTool("move_symbol_to_file_by_tsmorph", {
			tsconfigPath: tsconfigPathOf(HONO),
			originalFilePath: absPath(HONO, URL_FILE),
			targetFilePath,
			symbolToMove: "getPattern",
			declarationKindString: "VariableStatement",
			dryRun: false,
		});

		expect(result.isError, textOf(result)).toBeFalsy();
		expect(fs.existsSync(targetFilePath)).toBe(true);

		expectNoRegression();
	});

	// Case where the original file still contains a reference to the moved symbol
	// (i.e. a back-import is required). splitPath is referenced by splitRoutingPath
	// in the same file, so a reverse import from the destination is needed.
	// The old implementation threw
	// "children of the old and new trees were expected to have the same count"
	// inside fixMissingImports() (fixed in add-back-imports-to-original-file.ts).
	it("move_symbol_to_file: moving splitPath (which has remaining references in the source file) keeps types/tests green", async (ctx) => {
		requirePrepared(ctx);
		const targetFilePath = absPath(HONO, "src/utils/_e2e-split.ts");

		const result = await harness.callTool("move_symbol_to_file_by_tsmorph", {
			tsconfigPath: tsconfigPathOf(HONO),
			originalFilePath: absPath(HONO, URL_FILE),
			targetFilePath,
			symbolToMove: "splitPath",
			declarationKindString: "VariableStatement",
			dryRun: false,
		});

		expect(result.isError, textOf(result)).toBeFalsy();
		expect(fs.existsSync(targetFilePath)).toBe(true);

		expectNoRegression();
	});

	it("change_signature: adding a trailing argument to tryDecode keeps types/tests green", async (ctx) => {
		requirePrepared(ctx);
		const { absFilePath, position } = locateSymbolPosition(
			HONO,
			URL_FILE,
			"tryDecode",
		);

		const result = await harness.callTool("change_signature_by_tsmorph", {
			tsconfigPath: tsconfigPathOf(HONO),
			targetFilePath: absFilePath,
			position,
			functionName: "tryDecode",
			changes: [
				{
					kind: "add",
					index: 2,
					name: "_e2eFlag",
					typeText: "boolean",
					argumentForCallers: "false",
				},
			],
			dryRun: false,
		});

		expect(result.isError, textOf(result)).toBeFalsy();
		expectNoRegression();
	});
});
