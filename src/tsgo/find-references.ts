import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createLspClient } from "./lsp-client.js";
import { resolveTsgoExe } from "./resolve-exe.js";

/**
 * Project-wide find-references through tsgo's language server.
 *
 * The guard answers an intercepted identifier search by looking up real
 * references, and doing that through ts-morph means parsing the project and
 * loading the dependency type graph on every call. tsgo answers the same
 * question in a fraction of the time, from a process that starts, answers and
 * exits — no daemon, no cache, nothing to invalidate.
 *
 * The subtlety is `workspace/symbol`. It is the editor's quick-open search:
 * fuzzy, scoped to the whole repository rather than the project, and it
 * returns duplicates. Taking its first hit would answer from an arbitrary
 * same-named symbol in an unrelated package — the exact class of wrong answer
 * that makes a semantic tool worth less than grep. So candidates are scoped to
 * the project, deduplicated by position, and anything other than exactly one
 * declaration is reported as such rather than guessed at.
 */

export interface TsgoLocation {
	filePath: string;
	line: number;
	column: number;
}

export type TsgoReferencesResult =
	| { status: "found"; declaration: TsgoLocation; references: TsgoLocation[] }
	| { status: "ambiguous"; candidates: TsgoLocation[] }
	| { status: "not-found" }
	| { status: "unavailable"; reason: string };

interface LspLocation {
	uri: string;
	range: { start: { line: number; character: number } };
}

interface WorkspaceSymbol {
	name: string;
	location: LspLocation;
}

function toLocation(location: LspLocation): TsgoLocation {
	return {
		filePath: fileURLToPath(location.uri),
		// LSP positions are 0-based; every other location in this codebase is not.
		line: location.range.start.line + 1,
		column: location.range.start.character + 1,
	};
}

/**
 * tsgo loads a project lazily, on the first didOpen — until then
 * `workspace/symbol` answers from an empty index. Any file in the project
 * works as the trigger.
 */
function firstSourceFile(dir: string, depth = 0): string | undefined {
	if (depth > 8) return undefined;
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const directories: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
				directories.push(full);
			}
		} else if (
			/\.(ts|tsx|mts|cts)$/.test(entry.name) &&
			!entry.name.endsWith(".d.ts")
		) {
			return full;
		}
	}
	for (const directory of directories) {
		const found = firstSourceFile(directory, depth + 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

export interface TsgoReferencesRequest {
	/** Project root; candidates outside it are not this project's symbols. */
	rootDir: string;
	symbolName: string;
	timeoutMs: number;
}

export async function findReferencesViaTsgo(
	request: TsgoReferencesRequest,
): Promise<TsgoReferencesResult> {
	const exePath = resolveTsgoExe();
	if (exePath === undefined) {
		return { status: "unavailable", reason: "tsgo executable not found" };
	}
	const seed = firstSourceFile(request.rootDir);
	if (seed === undefined) {
		return { status: "unavailable", reason: "no source file under the root" };
	}

	const client = createLspClient(exePath, request.timeoutMs);
	try {
		const rootUri = pathToFileURL(request.rootDir).toString();
		await client.request("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders: [
				{ uri: rootUri, name: path.basename(request.rootDir) },
			],
			capabilities: {},
		});
		client.notify("initialized", {});
		client.notify("textDocument/didOpen", {
			textDocument: {
				uri: pathToFileURL(seed).toString(),
				languageId: "typescript",
				version: 1,
				text: readFileSync(seed, "utf-8"),
			},
		});

		const symbols = (await client.request("workspace/symbol", {
			query: request.symbolName,
		})) as WorkspaceSymbol[] | null;

		const rootPrefix = `${path.resolve(request.rootDir)}${path.sep}`;
		const seen = new Set<string>();
		const candidates: WorkspaceSymbol[] = [];
		for (const symbol of symbols ?? []) {
			if (symbol.name !== request.symbolName) continue;
			let filePath: string;
			try {
				filePath = fileURLToPath(symbol.location.uri);
			} catch {
				continue;
			}
			if (!filePath.startsWith(rootPrefix)) continue;
			const key = `${filePath}:${symbol.location.range.start.line}:${symbol.location.range.start.character}`;
			if (seen.has(key)) continue;
			seen.add(key);
			candidates.push(symbol);
		}

		if (candidates.length === 0) {
			return { status: "not-found" };
		}
		if (candidates.length > 1) {
			return {
				status: "ambiguous",
				candidates: candidates.map((c) => toLocation(c.location)),
			};
		}

		const declaration = candidates[0].location;
		const declarationPath = fileURLToPath(declaration.uri);
		client.notify("textDocument/didOpen", {
			textDocument: {
				uri: declaration.uri,
				languageId: "typescript",
				version: 1,
				text: readFileSync(declarationPath, "utf-8"),
			},
		});
		const references = (await client.request("textDocument/references", {
			textDocument: { uri: declaration.uri },
			position: declaration.range.start,
			context: { includeDeclaration: true },
		})) as LspLocation[] | null;

		return {
			status: "found",
			declaration: toLocation(declaration),
			references: (references ?? []).map(toLocation),
		};
	} catch (error) {
		return {
			status: "unavailable",
			reason: error instanceof Error ? error.message : String(error),
		};
	} finally {
		client.dispose();
	}
}
