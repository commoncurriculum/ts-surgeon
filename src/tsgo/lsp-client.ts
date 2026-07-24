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
 */

interface JsonRpcMessage {
	id?: number | string;
	method?: string;
	result?: unknown;
	error?: unknown;
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

export function createLspClient(exePath: string, timeoutMs: number): LspClient {
	const proc: ChildProcess = spawn(exePath, ["--lsp", "-stdio"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	// Draining stderr keeps the child from blocking on a full pipe.
	proc.stderr?.resume();

	let buffer = Buffer.alloc(0);
	const pending = new Map<number, (message: JsonRpcMessage) => void>();
	let nextId = 1;
	let disposed = false;

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
				pending.get(message.id)?.(message);
				pending.delete(message.id);
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
				pending.set(id, (message) => {
					clearTimeout(timer);
					resolve(message.result);
				});
				send({ jsonrpc: "2.0", id, method, params });
			});
		},
		notify(method, params) {
			send({ jsonrpc: "2.0", method, params });
		},
		dispose() {
			disposed = true;
			for (const [, resolve] of pending) {
				resolve({});
			}
			pending.clear();
			proc.kill();
		},
	};
}
