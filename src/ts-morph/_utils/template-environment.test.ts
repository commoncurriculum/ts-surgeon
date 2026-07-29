import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectTemplateEnvironment } from "./template-environment.js";
import { templateSpellings } from "./template-references.js";

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
