import { describe, expect, it } from "vitest";
import {
	formatSearchAnswer,
	mapBatchResults,
	resolveCliRuntime,
} from "./answer.js";

describe("resolveCliRuntime", () => {
	it("uses process.execPath under Node (Bun's execPath can be a compiled host app that cannot run scripts)", () => {
		// The test suite runs under Node, so the Node branch is what's provable
		// here; the Bun branch resolves node/bun from PATH via Bun.which.
		expect(typeof process.versions.bun).not.toBe("string");
		expect(resolveCliRuntime()).toBe(process.execPath);
	});
});

const ref = (n: number, file = "file") => ({
	filePath: `/repo/src/${file}${n}.ts`,
	line: n,
	column: 1,
	text: `calculateSum(${n})`,
});
const definition = {
	filePath: "/repo/src/math.ts",
	line: 1,
	column: 17,
	text: "export function calculateSum(a: number, b: number) {",
};

describe("formatSearchAnswer", () => {
	it("returns the definition and every reference with a rerun command", () => {
		const text = formatSearchAnswer("/repo/tsconfig.json", [
			{
				symbolName: "calculateSum",
				status: "found",
				definition,
				references: [ref(1), ref(2)],
			},
		]);
		expect(text).toContain("ran find_references");
		expect(text).toContain("/repo/src/math.ts:1:17");
		expect(text).toContain("/repo/src/file1.ts:1:1");
		expect(text).toContain("/repo/src/file2.ts:2:1");
		expect(text).toContain("--symbol-name calculateSum");
		expect(text).toContain("--tsconfig-path /repo/tsconfig.json");
		// The answer must not teach a typeable bypass either.
		expect(text).not.toMatch(/re-run|prefixed with|prefix a command/);
	});

	it("says so explicitly when nothing references the symbol", () => {
		const text = formatSearchAnswer("/repo/tsconfig.json", [
			{
				symbolName: "calculateSum",
				status: "found",
				definition,
				references: [],
			},
		]);
		expect(text).toMatch(/no references|nothing else/i);
	});

	it("caps long reference lists and reports the omitted count", () => {
		const refs = Array.from({ length: 55 }, (_, i) => ref(i + 1));
		const text = formatSearchAnswer("/repo/tsconfig.json", [
			{
				symbolName: "calculateSum",
				status: "found",
				definition,
				references: refs,
			},
		]);
		expect(text).toContain("/repo/src/file40.ts");
		expect(text).not.toContain("/repo/src/file41.ts");
		expect(text).toContain("15 more");
	});

	it("sections multiple symbols and reports unresolved and ambiguous ones", () => {
		const text = formatSearchAnswer("/repo/tsconfig.json", [
			{
				symbolName: "calculateSum",
				status: "found",
				definition,
				references: [ref(1)],
			},
			{ symbolName: "addKeyboardShortcuts", status: "not-found" },
			{
				symbolName: "render",
				status: "ambiguous",
				message: "'render' has 2 declarations in the project; …",
			},
		]);
		expect(text).toContain(
			"identifiers 'calculateSum', 'addKeyboardShortcuts', 'render'",
		);
		expect(text).toContain("── calculateSum");
		expect(text).toContain(
			"No project declaration named 'addKeyboardShortcuts'",
		);
		expect(text).toContain("2 declarations in the project");
		expect(text).toContain("ran find_references");
	});

	it("splits the display cap across the symbols that were found", () => {
		const many = (file: string) =>
			Array.from({ length: 30 }, (_, i) => ref(i + 1, file));
		const text = formatSearchAnswer("/repo/tsconfig.json", [
			{ symbolName: "a", status: "found", definition, references: many("a") },
			{ symbolName: "b", status: "found", definition, references: many("b") },
		]);
		// 40 total / 2 found = 20 per symbol
		expect(text).toContain("/repo/src/a20.ts");
		expect(text).not.toContain("/repo/src/a21.ts");
		expect(text).toContain("/repo/src/b20.ts");
		expect(text).not.toContain("/repo/src/b21.ts");
	});
});

describe("mapBatchResults", () => {
	it("zips batch entries back onto the requested symbols", () => {
		const results = mapBatchResults(
			["foo", "bar", "baz"],
			[
				{
					status: "success",
					data: { definition, references: [ref(1)] },
					message: "ok",
				},
				{
					status: "error",
					data: null,
					message: "No declaration named 'bar' found in the project.",
				},
				{
					status: "error",
					data: null,
					message: "'baz' has 2 declarations in the project; …",
				},
			],
		);
		expect(results?.map((r) => r.status)).toEqual([
			"found",
			"not-found",
			"ambiguous",
		]);
	});

	it("rejects output that is not the expected shape", () => {
		expect(mapBatchResults(["foo"], "nope")).toBeUndefined();
		expect(
			mapBatchResults(["foo", "bar"], [{ status: "success" }]),
		).toBeUndefined();
	});

	it("strips the CLI envelope framing from ambiguity messages", () => {
		const results = mapBatchResults(
			["baz"],
			[
				{
					status: "error",
					data: null,
					message:
						"Error: 'baz' has 2 declarations in the project; pick one:\n  - /a.ts:1:1\nStatus: Failure\nProcessing time: 0.16 seconds",
				},
			],
		);
		const first = results?.[0];
		expect(first?.status).toBe("ambiguous");
		if (first?.status === "ambiguous") {
			expect(first.message).not.toContain("Error:");
			expect(first.message).not.toContain("Status:");
			expect(first.message).not.toContain("Processing time");
			expect(first.message).toContain("/a.ts:1:1");
		}
	});
});
