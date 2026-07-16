import { performance } from "node:perf_hooks";
import type { ToolResult } from "./registry";
import logger from "../utils/logger";

export interface ToolRunOutcome {
	/** Human-readable message describing the result (success wording is tool-specific). */
	message: string;
	/** Extra fields to merge into the "finished" info log (e.g. changedFilesCount). */
	log?: Record<string, unknown>;
	/** Machine-readable result payload, surfaced by the CLI's --json mode. */
	data?: unknown;
}

/**
 * Wraps a logger call so a logger failure (e.g. disk full when LOG_OUTPUT=file)
 * never interrupts tool result generation.
 */
function safeLog(
	level: "error" | "info",
	message: string,
	fields: Record<string, unknown>,
): void {
	try {
		logger[level](fields, message);
	} catch (loggerErr) {
		console.error(`Failed to write ${level} log:`, loggerErr);
	}
}

/**
 * Runs a tool handler with the shared shell every tool needs: timing,
 * error mapping, structured start/finish logging (flush included), the
 * `Status` / `Processing time` footer, and the `{ content, isError }` envelope.
 *
 * The caller's `run` owns only the tool-specific work and success message
 * (including any dryRun wording); failures are turned into an error response
 * automatically.
 */
export async function runTool(
	toolName: string,
	logArgs: Record<string, unknown>,
	run: () => Promise<ToolRunOutcome> | ToolRunOutcome,
): Promise<ToolResult> {
	const startTime = performance.now();
	let message = "";
	let isError = false;
	let extraLog: Record<string, unknown> = {};
	let data: unknown;

	try {
		const outcome = await run();
		message = outcome.message;
		extraLog = outcome.log ?? {};
		data = outcome.data;
	} catch (error) {
		safeLog("error", `Error executing ${toolName}`, {
			err: error,
			toolArgs: logArgs,
		});
		message = `Error: ${error instanceof Error ? error.message : String(error)}`;
		isError = true;
	}

	const elapsedMs = performance.now() - startTime;
	safeLog("info", `${toolName} tool finished`, {
		status: isError ? "Failure" : "Success",
		durationMs: Number.parseFloat(elapsedMs.toFixed(2)),
		...logArgs,
		...extraLog,
	});
	try {
		logger.flush();
	} catch (flushErr) {
		console.error("Failed to flush logs:", flushErr);
	}

	const seconds = (elapsedMs / 1000).toFixed(2);
	const text = `${message}\nStatus: ${
		isError ? "Failure" : "Success"
	}\nProcessing time: ${seconds} seconds`;

	return { content: [{ type: "text", text }], isError, data };
}

/** Formats a changed-files list for a tool message, or "(No changes)" when empty. */
export function formatChangedFiles(files: string[]): string {
	return files.length > 0 ? files.join("\n - ") : "(No changes)";
}
