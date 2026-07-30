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

	it("does not let incidental matches bury the real invocation", async () => {
		// `Item` also spells every `{{item.name}}` and `as |item|` in an app. Taking
		// the first 25 matches in walk order would report block-param noise and drop
		// the one line that actually resolves the component.
		fs.writeFileSync(
			path.join(tempDir, "app/components/item.ts"),
			"export default class Item {\n  label = 'x';\n}\n",
		);
		const noise = Array.from(
			{ length: 40 },
			(_, i) => `  <span>{{item.name}} {{item.id}} row ${i}</span>`,
		).join("\n");
		fs.writeFileSync(
			path.join(tempDir, "app/templates/a-noise.hbs"),
			`{{#each model.rows as |item|}}\n${noise}\n{{/each}}\n`,
		);
		fs.writeFileSync(
			path.join(tempDir, "app/templates/z-real.hbs"),
			"<div>\n  <Item @label='hi' />\n</div>\n",
		);

		const result = await registry.call("find_references", {
			tsconfigPath,
			targetFilePath: path.join(tempDir, "app/components/item.ts"),
			symbolName: "Item",
		});
		const text = textOf(result);
		expect(text).toContain("z-real.hbs");
		expect(text).toContain("<Item");
		// Nothing is hidden: the count of what was left out is stated.
		expect(text).toMatch(/showing \d+ of \d+\+? matches/);
	});

	it("rename_symbol states that it cannot update templates", async () => {
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

	it("safe_delete_symbol lets a caller override a text match, on the record", async () => {
		// Text matching cannot tell a real use from a coincidence, so a generic
		// name would otherwise be undeletable forever. The override is explicit and
		// the result says whose judgement it was.
		const result = await registry.call("safe_delete_symbol", {
			tsconfigPath,
			targetFilePath: componentPath,
			symbolName: "BasicTooltipComponent",
			ignoreTemplateMentions: true,
		});
		const text = textOf(result);
		expect(text).toContain("Deleted 'BasicTooltipComponent'");
		expect(text).toContain("ignoreTemplateMentions=true");
		expect(text).toContain("caller's");
		expect(fs.readFileSync(componentPath, "utf-8")).not.toContain(
			"BasicTooltipComponent",
		);
	});

	it("find_unused_exports warns that template-only exports look unused here", async () => {
		// The sharpest version of the blind spot: this tool's whole answer is
		// "nothing references these", and it is the list an agent sweeps before
		// deleting. BasicTooltipComponent has exactly one consumer, in an .hbs.
		const result = await registry.call("find_unused_exports", {
			tsconfigPath,
		});
		const text = textOf(result);
		expect(text).toContain("Glint (Ember)");
		// Named, not blanket-disclaimed: this candidate is the false positive.
		expect(text).toContain("BasicTooltipComponent");
		expect(text).toContain("LIKELY USED");
	});

	it("move_symbol_to_file flags the templates it cannot follow", async () => {
		// A named export, because move_symbol_to_file declines default ones.
		const panelPath = path.join(tempDir, "app/components/side-panel.ts");
		fs.writeFileSync(
			panelPath,
			"export class SidePanelComponent {\n  open = false;\n}\n",
		);
		fs.writeFileSync(
			path.join(tempDir, "app/templates/panel.hbs"),
			"<div>\n  <SidePanel />\n</div>\n",
		);

		const result = await registry.call("move_symbol_to_file", {
			tsconfigPath,
			originalFilePath: panelPath,
			targetFilePath: path.join(tempDir, "app/components/panel/side-panel.ts"),
			symbolToMove: "SidePanelComponent",
		});
		const text = textOf(result);
		expect(text).toContain("Incomplete edit");
		expect(text).toContain("panel.hbs");
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
