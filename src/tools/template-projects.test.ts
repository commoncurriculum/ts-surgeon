import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolRegistry, type ToolRegistry } from "./registry.js";

/**
 * Projects whose references live partly outside the TypeScript program.
 *
 * Reconstructs the shape from the 2026-07-29 defect report: an Ember + Glint
 * app where `<BasicTooltip />` in an .hbs template is the ONLY real consumer of
 * a component class. ts-morph cannot resolve that edge — the point of these
 * tests is that no tool claims otherwise.
 */

function textOf(result: { content?: Array<{ text?: string }> }): string {
	return result.content?.[0]?.text ?? "";
}

describe("Glint/Ember projects (references outside the TS program)", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let componentPath: string;
	let templatePath: string;
	let registry: ToolRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-glint-"));
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: { target: "es2020", module: "esnext", strict: true },
				include: ["app/**/*"],
				glint: { environment: "ember-loose" },
			}),
		);
		fs.mkdirSync(path.join(tempDir, "app", "components"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "app", "templates"), { recursive: true });

		componentPath = path.join(tempDir, "app/components/basic-tooltip.ts");
		fs.writeFileSync(
			componentPath,
			[
				"export default class BasicTooltipComponent {",
				"  text = 'hi';",
				"}",
				"",
			].join("\n"),
		);
		templatePath = path.join(tempDir, "app/templates/application.hbs");
		fs.writeFileSync(templatePath, "<div>\n  <BasicTooltip />\n</div>\n");
		registry = createToolRegistry();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("find_references reports the template blind spot instead of implying completeness", async () => {
		const result = await registry.call("find_references", {
			tsconfigPath,
			targetFilePath: componentPath,
			symbolName: "BasicTooltipComponent",
		});
		const text = textOf(result);
		expect(text).toContain("Incomplete result");
		expect(text).toContain("Glint (Ember)");
		// The consumer ts-morph cannot see is named explicitly, as a text match.
		expect(text).toContain("application.hbs:2");
	});

	it("rename_symbol says which templates it did not update", async () => {
		const result = await registry.call("rename_symbol", {
			tsconfigPath,
			targetFilePath: componentPath,
			symbolName: "BasicTooltipComponent",
			newName: "TooltipComponent",
		});
		const text = textOf(result);
		expect(text).toContain("Rename successful");
		expect(text).toContain("Incomplete edit");
		expect(text).toContain("application.hbs");
	});

	it("safe_delete_symbol refuses rather than deleting a symbol a template may use", async () => {
		const result = await registry.call("safe_delete_symbol", {
			tsconfigPath,
			targetFilePath: componentPath,
			symbolName: "BasicTooltipComponent",
		});
		expect(textOf(result)).toContain("Not deleted");
		// The declaration is still there: the promise is "only when unreferenced".
		expect(fs.readFileSync(componentPath, "utf-8")).toContain(
			"BasicTooltipComponent",
		);
	});

	it("rename_filesystem_entry flags templates that resolve the file by name", async () => {
		const result = await registry.call("rename_filesystem_entry", {
			tsconfigPath,
			renames: [
				{
					oldPath: componentPath,
					newPath: path.join(tempDir, "app/components/tooltip.ts"),
				},
			],
		});
		const text = textOf(result);
		expect(text).toContain("Incomplete edit");
		expect(text).toContain("application.hbs");
	});

	it("stays silent in an ordinary TypeScript project", async () => {
		// No glint key: nothing to caveat, and no template scan is worth paying for.
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: { target: "es2020", module: "esnext", strict: true },
				include: ["app/**/*"],
			}),
		);
		const result = await registry.call("find_references", {
			tsconfigPath,
			targetFilePath: componentPath,
			symbolName: "BasicTooltipComponent",
		});
		expect(textOf(result)).not.toContain("Incomplete");
	});
});
