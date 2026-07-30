import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

/**
 * Template dialects whose references live OUTSIDE the TypeScript program.
 *
 * ts-morph answers from the type checker, and the type checker only sees files
 * in the program. In an Ember + Glint app a component is used as
 * `<BasicTooltip />` in an .hbs file that TypeScript never parses — so
 * find_references reports the Glint registry entry and nothing else, and says
 * "Success" (defect report, 2026-07-29: 865 .hbs against 973 .ts, and the one
 * real consumer was invisible). The same hole exists for Vue SFCs and Svelte
 * components — and, on a far larger installed base, for Angular, where it
 * reaches ordinary class members: a method bound by `(click)="onSave()"` in a
 * `templateUrl` file is invisible to the checker, so renaming it reports
 * success while breaking the template.
 *
 * The tool cannot resolve those references — that needs the framework's own
 * template compiler — but it can know it is in such a project, because the
 * marker sits in the tsconfig it already reads. Reporting an incomplete answer
 * as complete is the defect; the fix is to say so, and to hand back the text
 * matches that a human (or a follow-up grep) should look at.
 */

export interface TemplateEnvironment {
	/** Config key that identified the environment. */
	kind: "glint" | "vue" | "svelte" | "angular";
	/** How the environment is named in messages. */
	label: string;
	/** Extensions of template files outside the TypeScript program. */
	extensions: string[];
	/** Why references can be missing, in one clause. */
	resolution: string;
}

const ENVIRONMENTS: Array<{ key: string; env: TemplateEnvironment }> = [
	{
		key: "glint",
		env: {
			kind: "glint",
			label: "Glint (Ember)",
			// .gts/.gjs (template imports) are no more part of the TypeScript
			// program than .hbs is — glint compiles them, this tool cannot parse
			// them, so a symbol used only from one is equally invisible.
			extensions: [".hbs", ".gts", ".gjs"],
			resolution:
				"Ember resolves components, helpers, and modifiers from templates by filename convention, so no TypeScript reference edge exists for the type checker to follow",
		},
	},
	{
		key: "angularCompilerOptions",
		env: {
			kind: "angular",
			label: "Angular",
			// A component's markup lives in a separate .html reached by
			// `templateUrl`. Broader than the other dialects — a repo's other HTML
			// is scanned too — but a component template is not distinguishable by
			// path, and missing it is the failure that matters.
			extensions: [".html"],
			resolution:
				'a component\'s templateUrl markup is compiled by the Angular compiler, and its bindings ({{heroName}}, (click)="onSave()", *ngIf) resolve against the component class without producing any TypeScript reference edge',
		},
	},
	{
		key: "vueCompilerOptions",
		env: {
			kind: "vue",
			label: "Vue",
			extensions: [".vue"],
			resolution:
				"a Single File Component's <template> block is compiled by vue-tsc, not parsed by this tool",
		},
	},
	{
		key: "svelteOptions",
		env: {
			kind: "svelte",
			label: "Svelte",
			extensions: [".svelte"],
			resolution:
				"a .svelte component's markup is compiled by svelte-check, not parsed by this tool",
		},
	},
];

/**
 * Language-service plugins that mean the same thing as the top-level markers.
 * A Vue or Svelte project often carries no `vueCompilerOptions`/`svelteOptions`
 * block at all and is identified only by its plugin, so keying solely on the
 * top-level marker would leave this check with a blind spot of exactly the kind
 * it exists to report.
 */
const PLUGIN_MARKERS: Array<{
	match: RegExp;
	kind: TemplateEnvironment["kind"];
}> = [
	{ match: /^@glint\//, kind: "glint" },
	{ match: /^@angular\/language-ser(vice|ver)/, kind: "angular" },
	{ match: /vue.*typescript-plugin|typescript-vue-plugin/, kind: "vue" },
	{ match: /svelte/, kind: "svelte" },
];

/** Guards against a cyclic or pathological `extends` chain. */
const MAX_EXTENDS_DEPTH = 16;

/**
 * The raw tsconfig objects of a config and everything it extends, nearest
 * first. Unknown top-level keys (which is what every marker here is) are not
 * merged by the TypeScript config reader, so the chain is walked by hand.
 */
function readConfigChain(tsconfigPath: string): unknown[] {
	const chain: unknown[] = [];
	const seen = new Set<string>();
	let current: string | undefined = path.resolve(tsconfigPath);
	for (let depth = 0; current && depth < MAX_EXTENDS_DEPTH; depth++) {
		if (seen.has(current)) break;
		seen.add(current);
		const { config } = ts.readConfigFile(current, ts.sys.readFile);
		if (config === undefined) break;
		chain.push(config);
		const extendsValue = (config as { extends?: unknown }).extends;
		if (typeof extendsValue !== "string") break;
		current = resolveExtends(extendsValue, current);
	}
	return chain;
}

function resolveExtends(
	extendsValue: string,
	fromConfig: string,
): string | undefined {
	const base = path.dirname(fromConfig);
	const candidate = extendsValue.startsWith(".")
		? path.resolve(base, extendsValue)
		: // A package specifier (`@tsconfig/ember/tsconfig.json`) — resolvable only
			// through node_modules, and markers there are not this project's.
			path.resolve(base, "node_modules", extendsValue);
	for (const p of [
		candidate,
		`${candidate}.json`,
		path.join(candidate, "tsconfig.json"),
	]) {
		try {
			if (fs.statSync(p).isFile()) return p;
		} catch {
			// try the next spelling
		}
	}
	return undefined;
}

/** The environment implied by `compilerOptions.plugins`, if any. */
function environmentFromPlugins(
	config: Record<string, unknown>,
): TemplateEnvironment | undefined {
	const compilerOptions = config.compilerOptions as
		| { plugins?: unknown }
		| undefined;
	const plugins = compilerOptions?.plugins;
	if (!Array.isArray(plugins)) {
		return undefined;
	}
	for (const plugin of plugins) {
		const name = (plugin as { name?: unknown })?.name;
		if (typeof name !== "string") continue;
		for (const { match, kind } of PLUGIN_MARKERS) {
			if (match.test(name)) {
				return ENVIRONMENTS.find((e) => e.env.kind === kind)?.env;
			}
		}
	}
	return undefined;
}

/**
 * The template environment this tsconfig declares, or undefined for an ordinary
 * TypeScript project. Cheap: one (cached) config read per path.
 */
const detectionCache = new Map<string, TemplateEnvironment | undefined>();

export function detectTemplateEnvironment(
	tsconfigPath: string,
): TemplateEnvironment | undefined {
	const key = path.resolve(tsconfigPath);
	if (detectionCache.has(key)) {
		return detectionCache.get(key);
	}
	let found: TemplateEnvironment | undefined;
	try {
		for (const config of readConfigChain(key)) {
			if (config === null || typeof config !== "object") continue;
			for (const { key: marker, env } of ENVIRONMENTS) {
				if (marker in (config as Record<string, unknown>)) {
					found = env;
					break;
				}
			}
			found ??= environmentFromPlugins(config as Record<string, unknown>);
			if (found) break;
		}
	} catch {
		found = undefined;
	}
	detectionCache.set(key, found);
	return found;
}
