import {
	answerSearchViaCli,
	buildSearchTeaching,
	evaluateBashCommand,
	INERT_PREFIX_NOTE,
	isOperatorAllowed,
	type SearchAnswerer,
} from "./cli/hook";

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
export const createTsSurgeonGuard =
	(answerSearch: SearchAnswerer) => async () => {
		// The command is only visible in the before hook; remember it per call
		// so the after hook can teach the ts-surgeon equivalent of an executed
		// search. Blocked calls never reach the after hook, so cap the map to
		// keep abandoned entries from accumulating.
		const pendingCommands = new Map<string, string>();
		return {
			"tool.execute.before": async (
				input: { tool: string; callID?: string },
				output: { args?: Record<string, unknown> },
			): Promise<void> => {
				if (input.tool !== "bash") {
					return;
				}
				const command = output.args?.command;
				if (typeof command !== "string" || isOperatorAllowed()) {
					return;
				}
				if (typeof input.callID === "string") {
					if (pendingCommands.size > 200) {
						pendingCommands.clear();
					}
					pendingCommands.set(input.callID, command);
				}
				const verdict = evaluateBashCommand(command);
				if (verdict.kind === "block") {
					throw new Error(verdict.reason);
				}
				if (verdict.kind === "answer-search") {
					const answer = answerSearch({
						symbolNames: verdict.symbolNames,
						searchRoot: verdict.searchRoot,
						cwd: process.cwd(),
					});
					if (answer.ok) {
						// Throwing blocks the call; the answer text is the block message.
						throw new Error(
							command.includes("TS_SURGEON_ALLOW")
								? `${INERT_PREFIX_NOTE}\n${answer.text}`
								: answer.text,
						);
					}
					// Fail open: the search could not be answered, so let it run.
				}
			},
			"tool.execute.after": async (
				input: { tool: string; callID?: string },
				output: { output?: unknown },
			): Promise<void> => {
				if (input.tool !== "bash" || typeof input.callID !== "string") {
					return;
				}
				const command = pendingCommands.get(input.callID);
				pendingCommands.delete(input.callID);
				if (command === undefined || isOperatorAllowed()) {
					return;
				}
				const teaching = buildSearchTeaching("Bash", { command });
				if (teaching !== undefined && typeof output.output === "string") {
					output.output += `\n\n${teaching}`;
				}
			},
		};
	};

export const TsSurgeonGuard = createTsSurgeonGuard(answerSearchViaCli);
