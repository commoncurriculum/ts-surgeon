import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectTemplateEnvironment } from "./template-environment.js";
import {
	invocationPatternFor,
	templateSpellings,
} from "./template-references.js";

/**
 * Detection is what decides whether a tool warns at all, so its own blind spots
 * are the same defect one level down: a Vue project identified only by its
 * language-service plugin would silently get no caveat.
 */
describe("detectTemplateEnvironment", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-surgeon-tplenv-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function writeConfig(name: string, config: unknown): string {
		const file = path.join(dir, name);
		fs.writeFileSync(file, JSON.stringify(config));
		return file;
	}

	it("finds each environment from its top-level marker", () => {
		expect(
			detectTemplateEnvironment(
				writeConfig("glint.json", { glint: { environment: "ember-loose" } }),
			)?.kind,
		).toBe("glint");
		expect(
			detectTemplateEnvironment(
				writeConfig("vue.json", { vueCompilerOptions: { target: 3 } }),
			)?.kind,
		).toBe("vue");
		expect(
			detectTemplateEnvironment(
				writeConfig("svelte.json", { svelteOptions: {} }),
			)?.kind,
		).toBe("svelte");
		expect(
			detectTemplateEnvironment(
				writeConfig("ng.json", {
					angularCompilerOptions: { strictTemplates: true },
				}),
			)?.kind,
		).toBe("angular");
	});

	it("finds Astro, which has no marker key of its own", () => {
		// A generated Astro tsconfig is essentially just this line.
		expect(
			detectTemplateEnvironment(
				writeConfig("astro.json", { extends: "astro/tsconfigs/strict" }),
			)?.kind,
		).toBe("astro");
		// TypeScript 5 allows an array of bases.
		expect(
			detectTemplateEnvironment(
				writeConfig("astro-array.json", {
					extends: ["./base.json", "astro/tsconfigs/base"],
				}),
			)?.kind,
		).toBe("astro");
		// Hand-rolled config that extends nothing.
		expect(
			detectTemplateEnvironment(
				writeConfig("astro-jsx.json", {
					compilerOptions: { jsx: "preserve", jsxImportSource: "astro" },
				}),
			)?.kind,
		).toBe("astro");
		expect(
			detectTemplateEnvironment(
				writeConfig("astro-plugin.json", {
					compilerOptions: { plugins: [{ name: "@astrojs/ts-plugin" }] },
				}),
			)?.kind,
		).toBe("astro");
	});

	it("scans .astro and .mdx, which both render components", () => {
		const env = detectTemplateEnvironment(
			writeConfig("astro-ext.json", { extends: "astro/tsconfigs/base" }),
		);
		expect(env?.extensions).toEqual([".astro", ".mdx"]);
	});

	it("does not mistake another package's tsconfig for Astro's", () => {
		expect(
			detectTemplateEnvironment(
				writeConfig("other.json", {
					extends: "@tsconfig/node20/tsconfig.json",
				}),
			),
		).toBeUndefined();
	});

	it("scans .html for Angular, where the component markup lives", () => {
		const env = detectTemplateEnvironment(
			writeConfig("ng-ext.json", { angularCompilerOptions: {} }),
		);
		expect(env?.extensions).toEqual([".html"]);
		expect(env?.label).toBe("Angular");
	});

	it("finds environments declared only through a language-service plugin", () => {
		expect(
			detectTemplateEnvironment(
				writeConfig("vue-plugin.json", {
					compilerOptions: { plugins: [{ name: "@vue/typescript-plugin" }] },
				}),
			)?.kind,
		).toBe("vue");
		expect(
			detectTemplateEnvironment(
				writeConfig("svelte-plugin.json", {
					compilerOptions: { plugins: [{ name: "typescript-svelte-plugin" }] },
				}),
			)?.kind,
		).toBe("svelte");
		expect(
			detectTemplateEnvironment(
				writeConfig("ng-plugin.json", {
					compilerOptions: {
						plugins: [{ name: "@angular/language-service" }],
					},
				}),
			)?.kind,
		).toBe("angular");
	});

	it("follows the extends chain, which does not merge unknown keys", () => {
		writeConfig("base.json", { glint: { environment: "ember-loose" } });
		const leaf = writeConfig("tsconfig.json", {
			extends: "./base.json",
			compilerOptions: { strict: true },
		});
		expect(detectTemplateEnvironment(leaf)?.kind).toBe("glint");
	});

	it("says nothing for an ordinary TypeScript project", () => {
		expect(
			detectTemplateEnvironment(
				writeConfig("plain.json", { compilerOptions: { strict: true } }),
			),
		).toBeUndefined();
	});

	it("covers .gts/.gjs, which the program does not contain either", () => {
		const env = detectTemplateEnvironment(
			writeConfig("gts.json", { glint: {} }),
		);
		expect(env?.extensions).toEqual([".hbs", ".gts", ".gjs"]);
	});

	it("survives a missing or malformed config instead of throwing", () => {
		expect(
			detectTemplateEnvironment(path.join(dir, "nope.json")),
		).toBeUndefined();
		const broken = path.join(dir, "broken.json");
		fs.writeFileSync(broken, "{ not json");
		expect(detectTemplateEnvironment(broken)).toBeUndefined();
	});
});

describe("invocationPatternFor", () => {
	// Decides which matches survive truncation, so a real invocation classified
	// as noise can be dropped entirely from a busy template tree.
	const pattern = invocationPatternFor("Item|item|ItemComponent");

	it("recognizes the shapes a template engine resolves from", () => {
		for (const line of [
			"<Item />",
			"  <Item @label='hi' />",
			"</Item>",
			// A contextual component: dotted, and still a real use of `Item`.
			"<Item.Sub @x={{1}} />",
			"{{Item}}",
			"{{#Item}}",
			'{{component "Item"}}',
			"{{yield (Item)}}",
			// Svelte interpolation.
			"{Item}",
			// An .astro frontmatter use is a plain call — no template punctuation
			// in front of it at all.
			"const rows = Item(props);",
			"export const x = Item ();",
		]) {
			expect(pattern.test(line), line).toBe(true);
		}
	});

	it("does not mistake a local path read or a block param for an invocation", () => {
		for (const line of [
			// `item` here is the block param below, not the component.
			"<span>{{item.name}}</span>",
			"{{item.id}}",
			"{{#each model.rows as |item|}}",
			"{{! Item is deprecated }}",
			"the Item component is described here",
		]) {
			expect(pattern.test(line), line).toBe(false);
		}
	});
});

describe("templateSpellings", () => {
	it("connects class names and file names in both directions", () => {
		// Ember resolves `<BasicTooltip />` to basic-tooltip.ts, so a lookup that
		// starts from either end has to reach the other.
		expect(templateSpellings("BasicTooltipComponent")).toEqual(
			expect.arrayContaining([
				"BasicTooltipComponent",
				"BasicTooltip",
				"basic-tooltip",
			]),
		);
		expect(templateSpellings("basic-tooltip")).toEqual(
			expect.arrayContaining(["basic-tooltip", "BasicTooltip"]),
		);
	});
});
