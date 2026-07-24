import {
	buildSearchTeaching,
	evaluateBashCommand,
	evaluateGrepToolInput,
	INERT_PREFIX_NOTE,
	isOperatorAllowed,
	type SearchAnswerer,
} from "./cli/hook.js";

export const createTsSurgeonGuard =
	(answerSearch: SearchAnswerer) => async () => {
		// The search input is only visible in the before hook; remember it per call
		// so the after hook can teach the ts-surgeon equivalent of an executed
		// search. Blocked calls never reach the after hook, so cap the map to
		// keep abandoned entries from accumulating.
		const pendingSearches = new Map<
			string,
			{ toolName: "Bash" | "Grep"; toolInput: Record<string, unknown> }
		>();
		return {
			"tool.execute.before": async (
				input: { tool: string; callID?: string },
				output: { args?: Record<string, unknown> },
			): Promise<void> => {
				if (input.tool !== "bash" && input.tool !== "grep") {
					return;
				}
				const toolInput = output.args;
				if (toolInput === undefined || isOperatorAllowed()) {
					return;
				}
				const command = toolInput.command;
				if (input.tool === "bash" && typeof command !== "string") return;
				if (typeof input.callID === "string") {
					if (pendingSearches.size > 200) {
						pendingSearches.clear();
					}
					pendingSearches.set(input.callID, {
						toolName: input.tool === "bash" ? "Bash" : "Grep",
						toolInput,
					});
				}
				const verdict =
					input.tool === "bash"
						? evaluateBashCommand(command as string)
						: evaluateGrepToolInput(toolInput);
				if (verdict.kind === "block") {
					throw new Error(verdict.reason);
				}
				if (verdict.kind === "answer-search") {
					const answer = await answerSearch({
						symbolNames: verdict.symbolNames,
						searchRoot: verdict.searchRoot,
						cwd: process.cwd(),
					});
					if (answer.ok) {
						// Throwing blocks the call; the answer text is the block message.
						throw new Error(
							typeof command === "string" &&
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
				if (
					(input.tool !== "bash" && input.tool !== "grep") ||
					typeof input.callID !== "string"
				) {
					return;
				}
				const search = pendingSearches.get(input.callID);
				pendingSearches.delete(input.callID);
				if (search === undefined || isOperatorAllowed()) {
					return;
				}
				const teaching = buildSearchTeaching(search.toolName, search.toolInput);
				if (teaching !== undefined && typeof output.output === "string") {
					output.output += `\n\n${teaching}`;
				}
			},
		};
	};
