import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findSymbolReferences } from "../ts-morph/find-references.js";
import { findReferencesViaTsgo } from "./find-references.js";
import { resolveTsgoExe } from "./resolve-exe.js";

/**
 * tsgo and ts-morph must answer the same question the same way.
 *
 * Speed is only worth having if the answer is identical, so this runs both
 * engines over one real project on disk and compares location sets. Both are
 * the real implementations — no stubs — because the thing being checked is
 * precisely whether two real engines agree.
 */

let projectDir: string;

/** `file:line` — column is excluded: the engines anchor differently and both are right. */
function positions(
	locations: Array<{ filePath: string; line: number }>,
): string[] {
	return locations
		.map((l) => `${path.relative(projectDir, l.filePath)}:${l.line}`)
		.sort();
}

function write(relative: string, contents: string): void {
	const full = path.join(projectDir, relative);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents);
}

beforeAll(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsgo-agreement-"));
	fs.writeFileSync(
		path.join(projectDir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { strict: true, target: "es2020", module: "esnext" },
			include: ["src/**/*"],
		}),
	);
	write(
		"src/util.ts",
		`export function splitTitle(value: string): string[] {
	return value.split(" ");
}

export const UNUSED_EVERYWHERE = 1;
`,
	);
	write(
		"src/consumer-a.ts",
		`import { splitTitle } from "./util.js";

export const a = splitTitle("x y");
export const b = splitTitle("p q");
`,
	);
	// An aliased re-export: the file that uses `renamed` never spells `splitTitle`.
	write(
		"src/reexport.ts",
		`export { splitTitle as renamed } from "./util.js";`,
	);
	write(
		"src/consumer-b.ts",
		`import { renamed } from "./reexport.js";

export const c = renamed("m n");
`,
	);
	// Index-signature property reads: a name with no declaration anywhere.
	write(
		"src/styles.d.ts",
		`declare const styles: Record<string, string>;
export default styles;
`,
	);
	write(
		"src/uses-styles.ts",
		`import styles from "./styles.js";

export const cls = styles.lessonTitle;
export const cls2 = styles.lessonTitle;
`,
	);
});

afterAll(() => {
	if (projectDir) {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

describe("tsgo agrees with ts-morph", () => {
	it("resolves the tsgo executable from the installed package", () => {
		expect(resolveTsgoExe()).toBeDefined();
	});

	it("finds the same locations for an exported function", async () => {
		const viaTsMorph = await findSymbolReferences({
			tsconfigPath: path.join(projectDir, "tsconfig.json"),
			symbolName: "splitTitle",
		});
		const viaTsgo = await findReferencesViaTsgo({
			rootDir: projectDir,
			symbolName: "splitTitle",
			timeoutMs: 60_000,
		});

		expect(viaTsgo.status).toBe("found");
		if (viaTsgo.status !== "found") return;

		const tsMorphAll = [
			...(viaTsMorph.definition ? [viaTsMorph.definition] : []),
			...viaTsMorph.references,
		];
		expect(positions(viaTsgo.references)).toEqual(positions(tsMorphAll));
	});

	it("reports no declaration for index-signature property reads", async () => {
		const viaTsgo = await findReferencesViaTsgo({
			rootDir: projectDir,
			symbolName: "lessonTitle",
			timeoutMs: 60_000,
		});

		// Neither engine may invent an answer: `styles.lessonTitle` is a read, not
		// a declaration. ts-morph's exact wording differs by version (it says
		// "no declaration" once #36 lands, "N declarations" before), so what is
		// asserted is that it refuses, not how it phrases the refusal.
		await expect(
			findSymbolReferences({
				tsconfigPath: path.join(projectDir, "tsconfig.json"),
				symbolName: "lessonTitle",
			}),
		).rejects.toThrow(/lessonTitle/);
		expect(viaTsgo.status).toBe("not-found");
	});

	it("finds a symbol whose only use is through an aliased re-export", async () => {
		const viaTsgo = await findReferencesViaTsgo({
			rootDir: projectDir,
			symbolName: "renamed",
			timeoutMs: 60_000,
		});

		expect(viaTsgo.status).toBe("found");
		if (viaTsgo.status !== "found") return;
		// consumer-b.ts uses it without ever spelling `splitTitle` — the case a
		// text search cannot see.
		expect(positions(viaTsgo.references)).toContain("src/consumer-b.ts:3");
	});

	it("reports a declaration with no other references", async () => {
		const viaTsgo = await findReferencesViaTsgo({
			rootDir: projectDir,
			symbolName: "UNUSED_EVERYWHERE",
			timeoutMs: 60_000,
		});

		expect(viaTsgo.status).toBe("found");
		if (viaTsgo.status !== "found") return;
		expect(positions(viaTsgo.references)).toEqual(["src/util.ts:5"]);
	});
});
