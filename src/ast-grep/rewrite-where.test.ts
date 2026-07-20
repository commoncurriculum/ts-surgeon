import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeProject } from "../ts-morph/_utils/ts-morph-project.js";
import { rewriteWhere } from "./rewrite-where.js";

describe("rewriteWhere", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let srcDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsurgeon-where-"));
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		srcDir = path.join(tempDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*"],
			}),
		);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeConnectionFixture(): string {
		const filePath = path.join(srcDir, "app.ts");
		fs.writeFileSync(
			path.join(srcDir, "db.ts"),
			[
				"export class DbConnection {",
				"  close(): void {}",
				"  commit(): void {}",
				"}",
				"export class PooledConnection extends DbConnection {}",
				// no commit(): NOT structurally assignable to DbConnection
				"export class FileHandle {",
				"  close(): void {}",
				"}",
				"",
			].join("\n"),
		);
		fs.writeFileSync(
			filePath,
			[
				'import { DbConnection, FileHandle, PooledConnection } from "./db";',
				"const db = new DbConnection();",
				"const fh = new FileHandle();",
				"const pool = new PooledConnection();",
				"db.close();",
				"fh.close();",
				"pool.close();",
				"",
			].join("\n"),
		);
		return filePath;
	}

	it("mode 'is': rewrites only call sites whose capture has exactly the named type", async () => {
		const filePath = writeConnectionFixture();
		const project = initializeProject(tsconfigPath);

		const result = await rewriteWhere(project, {
			pattern: "$X.close()",
			rewrite: "shutdown($X)",
			where: { capture: "X", type: "DbConnection" },
		});

		// three syntactic matches, one predicated (pool is PooledConnection, not DbConnection)
		expect(result.matchCount).toBe(3);
		expect(result.rewrittenCount).toBe(1);
		const content = fs.readFileSync(filePath, "utf-8");
		expect(content).toContain("shutdown(db)");
		expect(content).toContain("fh.close()");
		expect(content).toContain("pool.close()");
	});

	it("mode 'extends': also rewrites subclasses (is-or-inherits)", async () => {
		const filePath = writeConnectionFixture();
		const project = initializeProject(tsconfigPath);

		const result = await rewriteWhere(project, {
			pattern: "$X.close()",
			rewrite: "shutdown($X)",
			where: { capture: "X", type: "DbConnection", mode: "extends" },
		});

		expect(result.rewrittenCount).toBe(2);
		const content = fs.readFileSync(filePath, "utf-8");
		expect(content).toContain("shutdown(db)");
		expect(content).toContain("shutdown(pool)");
		expect(content).toContain("fh.close()");
	});

	it("matches object-type aliases by their alias name", async () => {
		// The checker preserves alias symbols for object/union type aliases
		// (a class instance type referenced via an alias resolves straight to
		// the class — covered by the 'is' test above).
		const filePath = path.join(srcDir, "alias.ts");
		fs.writeFileSync(
			filePath,
			[
				"type Conn = { close(): void };",
				"const c: Conn = { close() {} };",
				"c.close();",
				"",
			].join("\n"),
		);
		const project = initializeProject(tsconfigPath);

		const byAlias = await rewriteWhere(project, {
			pattern: "$X.close()",
			rewrite: "shutdown($X)",
			where: { capture: "X", type: "Conn" },
			dryRun: true,
			filePaths: [filePath],
		});
		expect(byAlias.rewrittenCount).toBe(1);
	});

	it("mode 'is' does not match a union containing the type; 'assignable' follows the checker", async () => {
		fs.writeFileSync(
			path.join(srcDir, "union.ts"),
			[
				'import { DbConnection } from "./db";',
				"declare const maybe: DbConnection | undefined;",
				"maybe?.close();",
				"",
			].join("\n"),
		);
		writeConnectionFixture();
		const project = initializeProject(tsconfigPath);

		const isResult = await rewriteWhere(project, {
			pattern: "$X?.close()",
			rewrite: "shutdown($X)",
			where: { capture: "X", type: "DbConnection" },
			dryRun: true,
		});
		expect(isResult.rewrittenCount).toBe(0);

		// under strict, DbConnection | undefined is not assignable to DbConnection either
		const assignableResult = await rewriteWhere(project, {
			pattern: "$X?.close()",
			rewrite: "shutdown($X)",
			where: {
				capture: "X",
				type: "DbConnection",
				mode: "assignable",
				typeDeclarationPath: path.join(srcDir, "db.ts"),
			},
			dryRun: true,
		});
		expect(assignableResult.rewrittenCount).toBe(0);
	});

	it("mode 'assignable': a subclass is assignable to its base (structural, per the checker)", async () => {
		const filePath = writeConnectionFixture();
		const project = initializeProject(tsconfigPath);

		const result = await rewriteWhere(project, {
			pattern: "$X.close()",
			rewrite: "shutdown($X)",
			where: {
				capture: "X",
				type: "DbConnection",
				mode: "assignable",
				typeDeclarationPath: path.join(srcDir, "db.ts"),
			},
		});

		// db and pool are assignable; FileHandle lacks commit() so it is not.
		// Note assignability is structural — a same-shape class WOULD match.
		expect(result.rewrittenCount).toBe(2);
		const content = fs.readFileSync(filePath, "utf-8");
		expect(content).toContain("shutdown(db)");
		expect(content).toContain("shutdown(pool)");
		expect(content).toContain("fh.close()");
	});

	it("mode 'assignable' without typeDeclarationPath is a clear error", async () => {
		writeConnectionFixture();
		const project = initializeProject(tsconfigPath);

		await expect(
			rewriteWhere(project, {
				pattern: "$X.close()",
				rewrite: "shutdown($X)",
				where: { capture: "X", type: "DbConnection", mode: "assignable" },
			}),
		).rejects.toThrow(/typeDeclarationPath/);
	});

	it("errors when where.capture names no metavariable in the pattern", async () => {
		writeConnectionFixture();
		const project = initializeProject(tsconfigPath);

		await expect(
			rewriteWhere(project, {
				pattern: "$X.close()",
				rewrite: "shutdown($X)",
				where: { capture: "Y", type: "DbConnection" },
			}),
		).rejects.toThrow(/no capture \$Y/);
	});

	it("maps offsets correctly with non-ASCII text before the match", async () => {
		const filePath = path.join(srcDir, "unicode.ts");
		fs.writeFileSync(
			filePath,
			[
				"// 日本語のコメント 🎉 — multibyte before the match",
				'const label = "café ☕";',
				"class DbConnection { close(): void {} }",
				"const db = new DbConnection();",
				"db.close();",
				"",
			].join("\n"),
		);
		const project = initializeProject(tsconfigPath);

		const result = await rewriteWhere(project, {
			pattern: "$X.close()",
			rewrite: "shutdown($X)",
			where: { capture: "X", type: "DbConnection" },
		});

		expect(result.rewrittenCount).toBe(1);
		const content = fs.readFileSync(filePath, "utf-8");
		expect(content).toContain("shutdown(db)");
		expect(content).toContain('const label = "café ☕";');
	});

	it("dryRun reports the same files without writing", async () => {
		const filePath = writeConnectionFixture();
		const before = fs.readFileSync(filePath, "utf-8");
		const project = initializeProject(tsconfigPath);

		const result = await rewriteWhere(project, {
			pattern: "$X.close()",
			rewrite: "shutdown($X)",
			where: { capture: "X", type: "DbConnection" },
			dryRun: true,
		});

		expect(result.rewrittenCount).toBe(1);
		expect(result.changedFiles).toEqual([filePath]);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});
});
