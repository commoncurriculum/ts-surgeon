import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchAnswerRequest, SearchAnswerer } from "./cli/hook";
import { createTsSurgeonGuard } from "./opencode-guard";
import TsSurgeonGuard from "./opencode-plugin";

/** Fake answerer: records requests, returns a canned answer (or refuses). */
function fakeAnswerer(ok: boolean) {
	const calls: SearchAnswerRequest[] = [];
	const answerSearch: SearchAnswerer = (req) => {
		calls.push(req);
		return ok
			? { ok: true, text: `ANSWERED ${req.symbolNames.join(", ")}` }
			: { ok: false };
	};
	return { calls, answerSearch };
}

async function loadGuard(answerSearch?: SearchAnswerer) {
	const hooks = answerSearch
		? await createTsSurgeonGuard(answerSearch)()
		: await TsSurgeonGuard();
	return hooks["tool.execute.before"];
}

describe("TsSurgeonGuard (opencode plugin)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("exports the callable plugin directly", () => {
		expect(typeof TsSurgeonGuard).toBe("function");
	});

	it("throws on bash commands that hand-edit TS/JS sources", async () => {
		const guard = await loadGuard();
		await expect(
			guard(
				{ tool: "bash" },
				{ args: { command: "sed -i 's/a/b/' src/x.ts" } },
			),
		).rejects.toThrow(/ts-surgeon/);
	});

	it("ignores other tools, harmless commands, and missing args", async () => {
		const guard = await loadGuard();
		await expect(
			guard({ tool: "read" }, { args: { filePath: "src/x.ts" } }),
		).resolves.toBeUndefined();
		await expect(
			guard({ tool: "bash" }, { args: { command: "ls -la" } }),
		).resolves.toBeUndefined();
		await expect(guard({ tool: "bash" }, {})).resolves.toBeUndefined();
	});

	it("answers identifier searches by throwing the find_references output", async () => {
		const { calls, answerSearch } = fakeAnswerer(true);
		const guard = await loadGuard(answerSearch);
		await expect(
			guard(
				{ tool: "bash" },
				{ args: { command: "grep -rn calculateSum src/" } },
			),
		).rejects.toThrow(/ANSWERED calculateSum/);
		expect(calls[0]?.symbolNames).toEqual(["calculateSum"]);
		expect(calls[0]?.searchRoot).toBe("src/");
	});

	it("fails open when the search cannot be answered", async () => {
		const { calls, answerSearch } = fakeAnswerer(false);
		const guard = await loadGuard(answerSearch);
		await expect(
			guard(
				{ tool: "bash" },
				{ args: { command: "grep -rn calculateSum src/" } },
			),
		).resolves.toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("ignores inline TS_SURGEON_ALLOW prefixes but honors the operator env hatch", async () => {
		const { answerSearch } = fakeAnswerer(true);
		const guard = await loadGuard(answerSearch);
		await expect(
			guard(
				{ tool: "bash" },
				{ args: { command: "TS_SURGEON_ALLOW=1 grep -rn calculateSum src/" } },
			),
		).rejects.toThrow(/operator-only[\s\S]*ANSWERED calculateSum/);
		vi.stubEnv("TS_SURGEON_ALLOW", "1");
		await expect(
			guard(
				{ tool: "bash" },
				{ args: { command: "grep -rn calculateSum src/" } },
			),
		).resolves.toBeUndefined();
	});

	it("teaches the ts-surgeon equivalent after an executed search", async () => {
		const { answerSearch } = fakeAnswerer(false); // fail open → search runs
		const hooks = await createTsSurgeonGuard(answerSearch)();
		await hooks["tool.execute.before"](
			{ tool: "bash", callID: "c1" },
			{ args: { command: "grep -rn calculateSum src/" } },
		);
		const result = { output: "src/cart.ts:2: calculateSum(1, 2)" };
		await hooks["tool.execute.after"]({ tool: "bash", callID: "c1" }, result);
		expect(result.output).toContain("next time");
		expect(result.output).toContain(
			"call find_references --symbol-name calculateSum",
		);
	});

	it("answers searches regardless of TS_SURGEON_STRICT (strict split retired)", async () => {
		const { answerSearch } = fakeAnswerer(true);
		const guard = await loadGuard(answerSearch);
		const search = { args: { command: "grep -rn calculateSum src/" } };
		await expect(guard({ tool: "bash" }, search)).rejects.toThrow(
			/ANSWERED calculateSum/,
		);
		// The old TS_SURGEON_STRICT opt-in is gone; the env var changes nothing.
		vi.stubEnv("TS_SURGEON_STRICT", "0");
		await expect(guard({ tool: "bash" }, search)).rejects.toThrow(
			/ANSWERED calculateSum/,
		);
	});
});
