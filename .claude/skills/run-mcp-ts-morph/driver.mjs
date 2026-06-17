#!/usr/bin/env node
// Driver / smoke harness for the mcp-ts-morph MCP server.
//
// Launches the built stdio server (dist/index.js), speaks MCP over stdio via
// the official SDK client, and drives a real end-to-end flow:
//   1. initialize handshake
//   2. tools/list  — assert the full tool suite is registered
//   3. tools/call  — exercise a read-only tool (get_diagnostics) AND a
//      mutating tool (rename_symbol, dryRun) against a throwaway fixture,
//      and assert the responses are real (a type error surfaces; the rename
//      reports the files it would touch).
//
// Exit code 0 = everything worked; non-zero = something is broken (the
// message says what). Safe to run repeatedly: the fixture is created fresh in
// a temp dir and removed at the end; dryRun means no fixture file is rewritten.
//
// Usage:
//   node .claude/skills/run-mcp-ts-morph/driver.mjs            # smoke run
//   REPO_ROOT=/path/to/repo node .../driver.mjs                # explicit root
//
// Requires: `pnpm build` to have produced dist/index.js first.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Skill lives at <root>/.claude/skills/run-mcp-ts-morph/ — three levels up.
const REPO_ROOT = process.env.REPO_ROOT ?? resolve(here, "../../..");
const SERVER_ENTRY = join(REPO_ROOT, "dist", "index.js");

function log(step, msg) {
	process.stderr.write(`[driver] ${step}: ${msg}\n`);
}
function fail(msg) {
	process.stderr.write(`\n[driver] FAIL: ${msg}\n`);
	process.exit(1);
}
// Throw (don't process.exit) for in-flight checks so main()'s `finally` still
// runs — otherwise a failed assertion would orphan the spawned server process
// and leak the temp fixture.
function assert(condition, msg) {
	if (!condition) throw new Error(msg);
}

if (!existsSync(SERVER_ENTRY)) {
	fail(`server entry not found at ${SERVER_ENTRY}. Run \`pnpm build\` first.`);
}

// --- Build a throwaway TypeScript project for the tools to chew on ----------
function makeFixture() {
	const dir = mkdtempSync(join(tmpdir(), "mcp-ts-morph-fixture-"));
	mkdirSync(join(dir, "src"));
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2020",
					module: "ESNext",
					moduleResolution: "node",
					strict: true,
					noEmit: true,
				},
				include: ["src"],
			},
			null,
			2,
		),
	);
	// One deliberate type error (TS2322) + one symbol with a cross-line use.
	writeFileSync(
		join(dir, "src", "index.ts"),
		[
			"export function greet(name: string): string {",
			"\treturn `hi ${name}`;",
			"}",
			"",
			"const bad: number = greet('world');", // string assigned to number -> TS2322
			"console.log(bad);",
			"",
		].join("\n"),
	);
	return dir;
}

function textOf(result) {
	return (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

async function main() {
	const fixture = makeFixture();
	const tsconfigPath = join(fixture, "tsconfig.json");
	const fixtureFile = join(fixture, "src", "index.ts");
	log("fixture", fixture);

	const transport = new StdioClientTransport({
		command: process.execPath, // node
		args: [SERVER_ENTRY],
		stderr: "inherit", // surface the server's pino logs
		env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "silent" },
	});
	const client = new Client({
		name: "run-mcp-ts-morph-driver",
		version: "1.0.0",
	});

	try {
		await client.connect(transport); // performs the initialize handshake
		log("connect", "initialize handshake OK");

		// 1. tools/list -------------------------------------------------------
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		log("tools/list", `${tools.length} tools registered`);
		process.stderr.write(`  ${names.join("\n  ")}\n`);
		assert(tools.length >= 15, `expected >= 15 tools, got ${tools.length}`);
		for (const required of [
			"get_diagnostics_by_tsmorph",
			"rename_symbol_by_tsmorph",
			"find_references_by_tsmorph",
		]) {
			assert(names.includes(required), `missing tool: ${required}`);
		}

		// 2. read-only tool: get_diagnostics ---------------------------------
		const diag = await client.callTool({
			name: "get_diagnostics_by_tsmorph",
			arguments: { tsconfigPath, filePaths: [fixtureFile] },
		});
		const diagText = textOf(diag);
		log("get_diagnostics", diagText.split("\n")[0]);
		assert(
			/TS2322|error/i.test(diagText),
			`expected a type error in diagnostics, got:\n${diagText}`,
		);

		// 3. mutating tool (dryRun): rename_symbol ---------------------------
		// `greet` is declared at line 1, column 17 (1-based) in the fixture.
		const rename = await client.callTool({
			name: "rename_symbol_by_tsmorph",
			arguments: {
				tsconfigPath,
				targetFilePath: fixtureFile,
				position: { line: 1, column: 17 },
				symbolName: "greet",
				newName: "salute",
				dryRun: true,
			},
		});
		const renameText = textOf(rename);
		log("rename_symbol(dryRun)", renameText.split("\n")[0]);
		assert(
			/Dry run|would modify/i.test(renameText),
			`expected a dry-run report, got:\n${renameText}`,
		);

		process.stderr.write(
			"\n[driver] PASS — server launched and driven end-to-end.\n",
		);
	} finally {
		await client.close().catch(() => {});
		rmSync(fixture, { recursive: true, force: true });
	}
}

main().catch((err) => fail(err?.stack ?? String(err)));
