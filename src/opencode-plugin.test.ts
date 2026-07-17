import { afterEach, describe, expect, it, vi } from "vitest";
import { TsSurgeonGuard } from "./opencode-plugin";

async function loadGuard() {
	const hooks = await TsSurgeonGuard();
	return hooks["tool.execute.before"];
}

describe("TsSurgeonGuard (opencode plugin)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
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

	it("honors TS_SURGEON_STRICT=1", async () => {
		const guard = await loadGuard();
		const search = { args: { command: "grep -rn calculateSum src/" } };
		await expect(guard({ tool: "bash" }, search)).resolves.toBeUndefined();
		vi.stubEnv("TS_SURGEON_STRICT", "1");
		await expect(guard({ tool: "bash" }, search)).rejects.toThrow(
			/find_references/,
		);
	});
});
