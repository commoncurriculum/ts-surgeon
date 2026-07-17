import { evaluateBashCommand, strictFromEnv } from "./cli/hook";

/**
 * opencode plugin entry: the package's `main`/`exports` point here so that
 * listing `@commoncurriculum/ts-surgeon` in opencode.json's `"plugin"` array
 * loads the guard directly (opencode calls every exported plugin function).
 * The CLI is unaffected — `bin` resolves to dist/index.js without going
 * through `exports`.
 *
 * Typed structurally instead of against `@opencode-ai/plugin` to keep the
 * package dependency-free for CLI users; the shapes below mirror that
 * package's `tool.execute.before` hook contract (throwing blocks the call).
 */
export const TsSurgeonGuard = async () => ({
	"tool.execute.before": async (
		input: { tool: string },
		output: { args?: Record<string, unknown> },
	): Promise<void> => {
		if (input.tool !== "bash") {
			return;
		}
		const command = output.args?.command;
		if (typeof command !== "string") {
			return;
		}
		const verdict = evaluateBashCommand(command, { strict: strictFromEnv() });
		if (verdict.block) {
			throw new Error(verdict.reason);
		}
	},
});
