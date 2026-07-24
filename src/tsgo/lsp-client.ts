import { type ChildProcess, spawn } from "node:child_process";

/**
 * A minimal LSP client for one short conversation with `tsgo --lsp`.
 *
 * Deliberately not a general client: it exists to ask a single question and
 * exit, so there is no daemon, no reconnect, and no document lifecycle beyond
 * the open needed to load a project.
 *
 * Two behaviours here were found the hard way and are load-bearing:
 *
 * 1. The server sends requests *to* the client (client/registerCapability) and
 *    blocks until they are answered. A client that ignores them deadlocks —
 *    the symptom is a `textDocument/references` that never returns.
 * 2. Every read has to survive TCP-style fragmentation: a single stdout chunk
 *    may hold part of a message, several messages, or both.
 *
 * A request settles four ways: a result, a JSON-RPC error, the process dying,
 * or the timeout. The first three settle immediately so a crashed tsgo fails
 * the guard open at once rather than stalling for the full budget.
 */

interface JsonRpcMessage {
	id?: number | string;
	method?: string;
	result?: unknown;
	error?: { message?: string } | unknown;
}

export interface LspClient {
	request(method: string, params: unknown): Promise<unknown>;
	notify(method: string, params: unknown): void;
	dispose(): void;
}

/** Thrown when the server is silent past the caller's budget. */
export class LspTimeoutError extends Error {
	constructor(method: string, ms: number) {
		super(`tsgo did not answer ${method} within ${ms}ms`);
		this.name = "LspTimeoutError";
	}
}

/** Thrown when tsgo answers a request with a JSON-RPC error. */
export class LspRequestError extends Error {
	constructor(method: string, detail: string) {
		super(`tsgo failed ${method}: ${detail}`);
		this.name = "LspRequestError";
	}
}

/** Thrown at every in-flight request when the tsgo process goes away. */
export class LspProcessError extends Error {
	constructor(detail: string) {
		super(`tsgo exited before answering: ${detail}`);
		this.name = "LspProcessError";
	}
}

export function createLspClient(exePath: string, timeoutMs: number): LspClient {
	const proc: ChildProcess = spawn(exePath, ["--lsp", "-stdio"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	// Draining stderr keeps the child from blocking on a full pipe.
	proc.stderr?.resume();

	let buffer = Buffer.alloc(0);
	interface Pending {
		settle(message: JsonRpcMessage): void;
		fail(error: Error): void;
	}
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let disposed = false;

	const failAllPending = (error: Error): void => {
		const entries = [...pending.values()];
		pending.clear();
		for (const entry of entries) entry.fail(error);
	};

	// A crashed or exited tsgo would otherwise leave every request hanging until
	// its timeout; fail them at once so the guard fails open immediately.
	proc.on("error", (error) => failAllPending(error));
	proc.on("exit", (code, signal) => {
		if (disposed) return;
		failAllPending(new LspProcessError(signal ?? `code ${code}`));
	});

	const send = (payload: unknown): void => {
		if (disposed) return;
		const body = JSON.stringify(payload);
		proc.stdin?.write(
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
		);
	};

	proc.stdout?.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const length = /Content-Length: (\d+)/i.exec(
				buffer.subarray(0, headerEnd).toString(),
			)?.[1];
			if (length === undefined) return;
			const start = headerEnd + 4;
			const size = Number(length);
			if (buffer.length < start + size) return;
			const body = buffer.subarray(start, start + size).toString();
			buffer = buffer.subarray(start + size);

			let message: JsonRpcMessage;
			try {
				message = JSON.parse(body) as JsonRpcMessage;
			} catch {
				continue;
			}
			if (message.id !== undefined && message.method !== undefined) {
				// A server-to-client request. It blocks the server until answered,
				// and we implement none of them, so answer null.
				send({ jsonrpc: "2.0", id: message.id, result: null });
				continue;
			}
			if (typeof message.id === "number") {
				const entry = pending.get(message.id);
				pending.delete(message.id);
				entry?.settle(message);
			}
		}
	});

	return {
		request(method, params) {
			const id = nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new LspTimeoutError(method, timeoutMs));
				}, timeoutMs);
				pending.set(id, {
					settle(message) {
						clearTimeout(timer);
						if (message.error !== undefined) {
							const detail =
								typeof message.error === "object" &&
								message.error !== null &&
								"message" in message.error
									? String((message.error as { message?: unknown }).message)
									: JSON.stringify(message.error);
							reject(new LspRequestError(method, detail));
							return;
						}
						resolve(message.result);
					},
					fail(error) {
						clearTimeout(timer);
						reject(error);
					},
				});
				send({ jsonrpc: "2.0", id, method, params });
			});
		},
		notify(method, params) {
			send({ jsonrpc: "2.0", method, params });
		},
		dispose() {
			disposed = true;
			failAllPending(new LspProcessError("client disposed"));
			proc.kill();
		},
	};
}
