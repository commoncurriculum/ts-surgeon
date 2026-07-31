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

	it("keeps collecting invocations after generic noise exhausts its budget", async () => {
		// 250 block-param lines in a walk-order-earlier file exceed the whole
		// 200-mention generic budget. With one shared budget the scan stopped
		// before ever reading z-real.hbs, so the one real `<Item />` was absent
		// from message AND payload — nothing left for ranking to rank.
		fs.writeFileSync(
			path.join(tempDir, "app/components/item.ts"),
			"export default class Item {\n  label = 'x';\n}\n",
		);
		const noise = Array.from(
			{ length: 250 },
			(_, i) => `  <span>{{item.name}} row ${i}</span>`,
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
	});

	it("safe_delete_symbol does not claim a deletion under dryRun + override", async () => {
		// "Deleted over N template text matches" describes an action; under
		// dryRun no action happened, and implying one is the defect class this
		// change set exists to fix.
		const result = await registry.call("safe_delete_symbol", {
			tsconfigPath,
			targetFilePath: componentPath,
			symbolName: "BasicTooltipComponent",
			ignoreTemplateMentions: true,
			dryRun: true,
		});
		const text = textOf(result);
		expect(text).toContain("Dry run complete");
		expect(text).toContain("Would delete despite");
		expect(text).not.toContain("Deleted over");
		expect(fs.readFileSync(componentPath, "utf-8")).toContain(
			"BasicTooltipComponent",
		);
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

	it("finds a template that addresses the component by file name", async () => {
		// Ember resolves `<BasicTooltip />` to app/components/basic-tooltip.ts by
		// convention — the class inside need not share the name. Deriving spellings
		// from the symbol alone made the blind-spot detector blind in its own
		// primary case.
		const oddPath = path.join(tempDir, "app/components/side-panel.ts");
		fs.writeFileSync(oddPath, "export class Panel {\n  open = false;\n}\n");
		fs.writeFileSync(
			path.join(tempDir, "app/templates/panel.hbs"),
			"<div>\n  <SidePanel />\n</div>\n",
		);

		const result = await registry.call("safe_delete_symbol", {
			tsconfigPath,
			targetFilePath: oddPath,
			symbolName: "Panel",
		});
		const text = textOf(result);
		expect(text).toContain("Not deleted");
		expect(text).toContain("panel.hbs");
		expect(fs.readFileSync(oddPath, "utf-8")).toContain("class Panel");
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
		// A class whose name the template never spells: Ember reaches it through
		// the file name, so this is the candidate most likely to be deleted.
		fs.writeFileSync(
			path.join(tempDir, "app/components/side-panel.ts"),
			"export class Panel {\n  open = false;\n}\n",
		);
		fs.writeFileSync(
			path.join(tempDir, "app/templates/panel.hbs"),
			"<div>\n  <SidePanel />\n</div>\n",
		);

		const result = await registry.call("find_unused_exports", {
			tsconfigPath,
		});
		const text = textOf(result);
		expect(text).toContain("Glint (Ember)");
		expect(text).toMatch(/LIKELY USED[^\n]*\bPanel\b/);
		// Named, not blanket-disclaimed: this candidate is the false positive.
		expect(text).toContain("BasicTooltipComponent");
		expect(text).toContain("LIKELY USED");
	});

	it("find_unused_exports searches every declaring file of a shared name", async () => {
		// Two same-named exports in different files: each resolves from its OWN
		// file name. Keeping only the first file's spellings made the second
		// invisible in exactly the file-name-resolution case this scan exists for.
		fs.writeFileSync(
			path.join(tempDir, "app/components/button.ts"),
			"export class Button {}\n",
		);
		fs.writeFileSync(
			path.join(tempDir, "app/components/legacy-button.ts"),
			"export class Button {}\n",
		);
		fs.writeFileSync(
			path.join(tempDir, "app/templates/legacy.hbs"),
			"<div>\n  <LegacyButton />\n</div>\n",
		);

		const result = await registry.call("find_unused_exports", {
			tsconfigPath,
		});
		const text = textOf(result);
		expect(text).toMatch(/LIKELY USED[^\n]*\bButton\b/);
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

/**
 * Astro's version of the hole is the sharpest of the lot, because the invisible
 * code is not markup at all: an `.astro` file's frontmatter is ordinary
 * TypeScript — imports, calls, whatever you like — that the Astro toolchain
 * compiles and ts-morph never parses. A plain utility function used only from a
 * page's frontmatter looks completely unreferenced.
 */
describe("Astro projects (frontmatter TypeScript outside the program)", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let modulePath: string;
	let registry: ToolRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-astro-"));
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				// What `npm create astro` actually writes.
				extends: "astro/tsconfigs/strict",
				compilerOptions: {
					target: "es2022",
					module: "esnext",
					strict: true,
					moduleResolution: "bundler",
				},
				include: ["src/**/*"],
			}),
		);
		fs.mkdirSync(path.join(tempDir, "src", "components"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "src", "pages"), { recursive: true });
		modulePath = path.join(tempDir, "src/components/money.ts");
		fs.writeFileSync(
			modulePath,
			"export function formatPrice(n: number) {\n  return n.toFixed(2);\n}\n",
		);
		fs.writeFileSync(
			path.join(tempDir, "src/pages/index.astro"),
			[
				"---",
				'import { formatPrice } from "../components/money";',
				"const total = formatPrice(9.5);",
				"---",
				"<p>{total}</p>",
				"",
			].join("\n"),
		);
		registry = createToolRegistry();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("find_references reports the frontmatter use it cannot resolve", async () => {
		const result = await registry.call("find_references", {
			tsconfigPath,
			targetFilePath: modulePath,
			symbolName: "formatPrice",
		});
		const text = textOf(result);
		expect(text).toContain("Incomplete result");
		expect(text).toContain("Astro");
		expect(text).toContain("index.astro:3");
	});

	it("ranks the frontmatter call above the bare import", async () => {
		const result = await registry.call("find_references", {
			tsconfigPath,
			targetFilePath: modulePath,
			symbolName: "formatPrice",
		});
		const text = textOf(result);
		// A call is the use that breaks; the import line is bookkeeping.
		expect(text.indexOf("index.astro:3")).toBeLessThan(
			text.indexOf("index.astro:2"),
		);
	});

	it("safe_delete_symbol refuses a helper only the frontmatter calls", async () => {
		const result = await registry.call("safe_delete_symbol", {
			tsconfigPath,
			targetFilePath: modulePath,
			symbolName: "formatPrice",
		});
		expect(textOf(result)).toContain("Not deleted");
		expect(fs.readFileSync(modulePath, "utf-8")).toContain("formatPrice");
	});
});

/**
 * Angular has the same hole and a far larger installed base: a component's
 * markup lives in a separate `.html` reached by `templateUrl`, and its bindings
 * resolve against the class with no TypeScript reference edge. Before this was
 * detected, `find_references` on a method bound by `(click)="onSave()"` answered
 * "References not found. Status: Success."
 */
describe("Angular projects (templateUrl markup outside the TS program)", () => {
	let tempDir: string;
	let tsconfigPath: string;
	let componentPath: string;
	let registry: ToolRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-ng-"));
		tsconfigPath = path.join(tempDir, "tsconfig.json");
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: {
					target: "es2022",
					module: "esnext",
					strict: true,
					experimentalDecorators: true,
				},
				include: ["src/**/*"],
				angularCompilerOptions: { strictTemplates: true },
			}),
		);
		fs.mkdirSync(path.join(tempDir, "src", "app"), { recursive: true });
		componentPath = path.join(tempDir, "src/app/hero.component.ts");
		fs.writeFileSync(
			componentPath,
			[
				"export class HeroComponent {",
				"  heroName = 'Ada';",
				"  onSave() {",
				"    return 1;",
				"  }",
				"}",
				"",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(tempDir, "src/app/hero.component.html"),
			'<div>\n  <h1>{{ heroName }}</h1>\n  <button (click)="onSave()">Save</button>\n</div>\n',
		);
		registry = createToolRegistry();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("find_references reports the binding the checker cannot see", async () => {
		const result = await registry.call("find_references", {
			tsconfigPath,
			targetFilePath: componentPath,
			symbolName: "onSave",
		});
		const text = textOf(result);
		expect(text).toContain("Incomplete result");
		expect(text).toContain("Angular");
		expect(text).toContain("hero.component.html:3");
	});

	it("rename_symbol says it cannot update the template it just orphaned", async () => {
		const result = await registry.call("rename_symbol", {
			tsconfigPath,
			targetFilePath: componentPath,
			symbolName: "heroName",
			newName: "displayName",
		});
		const text = textOf(result);
		expect(text).toContain("Rename successful");
		expect(text).toContain("Incomplete edit");
		// `{{ heroName }}` still says heroName, and nothing else will tell you.
		expect(text).toContain("hero.component.html:2");
	});

	it("safe_delete_symbol reads the decorator's selector — no spelling of the class name predicts it", async () => {
		// The Angular CLI's DEFAULT output: `ng generate component hero-detail`
		// yields HeroDetailComponent invoked as <app-hero-detail>, where `app-`
		// comes from angular.json. Guessed spellings never produce it; the
		// authoritative string sits in the @Component decorator itself.
		const detailPath = path.join(tempDir, "src/app/hero-detail.component.ts");
		fs.writeFileSync(
			detailPath,
			[
				"const Component = (o: object) => (t: unknown) => t;",
				"@Component({",
				"  selector: 'app-hero-detail',",
				"  templateUrl: './hero-detail.component.html',",
				"})",
				"export class HeroDetailComponent {}",
				"",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(tempDir, "src/app/app.component.html"),
			"<main>\n  <app-hero-detail></app-hero-detail>\n</main>\n",
		);

		const result = await registry.call("safe_delete_symbol", {
			tsconfigPath,
			targetFilePath: detailPath,
			symbolName: "HeroDetailComponent",
		});
		const text = textOf(result);
		expect(text).toContain("Not deleted");
		expect(text).toContain("app.component.html:2");
		expect(fs.readFileSync(detailPath, "utf-8")).toContain(
			"HeroDetailComponent",
		);
	});

	it("find_unused_exports flags a component used only through its selector", async () => {
		const detailPath = path.join(tempDir, "src/app/hero-detail.component.ts");
		fs.writeFileSync(
			detailPath,
			[
				"const Component = (o: object) => (t: unknown) => t;",
				"@Component({ selector: 'app-hero-detail' })",
				"export class HeroDetailComponent {}",
				"",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(tempDir, "src/app/app.component.html"),
			"<main>\n  <app-hero-detail></app-hero-detail>\n</main>\n",
		);

		const result = await registry.call("find_unused_exports", {
			tsconfigPath,
		});
		const text = textOf(result);
		expect(text).toMatch(/LIKELY USED[^\n]*HeroDetailComponent/);
	});
});
