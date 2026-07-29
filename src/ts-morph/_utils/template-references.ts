import * as fs from "node:fs";
import * as path from "node:path";
import {
	detectTemplateEnvironment,
	type TemplateEnvironment,
} from "./template-environment.js";

/**
 * Text matches for a symbol inside template files the TypeScript program does
 * not contain. See template-environment.ts for why these exist at all.
 *
 * These are deliberately TEXT matches, presented as such. Resolving them would
 * mean running Glint's / vue-tsc's template transform, which this tool does
 * not do. An honest "here is what I could not resolve" beats both a silent
 * omission and a guess dressed up as a reference.
 */

export interface TemplateMention {
	filePath: string;
	line: number;
	text: string;
}

/** Directories never worth scanning for project templates. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"tmp",
	"coverage",
	"vendor",
	".next",
	".cache",
]);

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_MENTIONS = 25;

/** Role suffixes Ember strips when a class becomes a template-resolvable name. */
const ROLE_SUFFIXES = ["Component", "Helper", "Modifier", "Service"];

function dasherize(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase();
}

function classify(name: string): string {
	return name
		.split(/[-_]/)
		.filter((part) => part !== "")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/**
 * Every spelling a template might use for a TypeScript name: the identifier
 * itself (template-imports, Vue and Svelte use it verbatim), the same name
 * with its role suffix dropped, and the dasherized/classified forms of both.
 * Both directions matter — a lookup can start from a class name
 * (`BasicTooltipComponent`) or from a file name (`basic-tooltip`), and classic
 * Ember resolution connects the two.
 */
export function templateSpellings(symbolName: string): string[] {
	const bases = new Set<string>([symbolName]);
	for (const suffix of ROLE_SUFFIXES) {
		if (symbolName.length > suffix.length && symbolName.endsWith(suffix)) {
			bases.add(symbolName.slice(0, -suffix.length));
		}
	}
	const spellings = new Set<string>();
	for (const base of bases) {
		if (base === "") continue;
		spellings.add(base);
		spellings.add(dasherize(base));
		spellings.add(classify(base));
	}
	return [...spellings];
}

function collectTemplateFiles(root: string, extensions: string[]): string[] {
	const files: string[] = [];
	const queue = [root];
	while (queue.length > 0 && files.length < MAX_FILES) {
		const dir = queue.shift() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
					queue.push(full);
				}
			} else if (extensions.some((ext) => entry.name.endsWith(ext))) {
				files.push(full);
				if (files.length >= MAX_FILES) break;
			}
		}
	}
	return files;
}

/**
 * Template lines mentioning any spelling of the given symbols. Word-ish
 * boundaries keep `<BasicTooltip />` and `{{basic-tooltip}}` in while keeping
 * `basic-tooltip-header` out.
 */
export function findTemplateMentions(
	env: TemplateEnvironment,
	projectRoot: string,
	symbolNames: string[],
): TemplateMention[] {
	const spellings = [
		...new Set(symbolNames.flatMap((name) => templateSpellings(name))),
	].filter((s) => s.length > 1);
	if (spellings.length === 0) {
		return [];
	}
	const pattern = new RegExp(
		`(?<![\\w-])(?:${spellings.map(escapeRegExp).join("|")})(?![\\w-])`,
	);
	const mentions: TemplateMention[] = [];
	for (const file of collectTemplateFiles(projectRoot, env.extensions)) {
		if (mentions.length >= MAX_MENTIONS) break;
		let contents: string;
		try {
			if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
			contents = fs.readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		if (!pattern.test(contents)) continue;
		const lines = contents.split(/\r?\n/);
		for (let i = 0; i < lines.length && mentions.length < MAX_MENTIONS; i++) {
			if (pattern.test(lines[i])) {
				mentions.push({ filePath: file, line: i + 1, text: lines[i].trim() });
			}
		}
	}
	return mentions;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatMentions(mentions: TemplateMention[]): string {
	const shown = mentions
		.map((m) => `- ${m.filePath}:${m.line}\n  ${m.text}`)
		.join("\n");
	const truncated =
		mentions.length >= MAX_MENTIONS
			? `\n(stopped at ${MAX_MENTIONS} matches)`
			: "";
	return `${shown}${truncated}`;
}

export interface TemplateCaveat {
	/** Prose to append to the tool's message. */
	text: string;
	/** Machine-readable payload for --json consumers. */
	data: {
		environment: TemplateEnvironment["kind"];
		templateExtensions: string[];
		unresolvedMentions: TemplateMention[];
	};
}

/**
 * The caveat a tool must print when it runs in a template-bearing project.
 * `mutating` switches the wording from "these were not searched" to "these were
 * not updated" — the difference between an incomplete answer and an incomplete
 * edit.
 */
export function templateCaveat({
	tsconfigPath,
	symbolNames,
	mutating,
}: {
	tsconfigPath: string;
	symbolNames: string[];
	mutating: boolean;
}): TemplateCaveat | undefined {
	const env = detectTemplateEnvironment(tsconfigPath);
	if (env === undefined) {
		return undefined;
	}
	const projectRoot = path.dirname(path.resolve(tsconfigPath));
	const mentions = findTemplateMentions(env, projectRoot, symbolNames);
	const extensions = env.extensions.join("/");
	// Stated as a capability ("cannot update"), never as an action ("did not
	// update"). The latter reads like an edit pass that skipped these files,
	// which is simply false under dryRun, where nothing was attempted at all —
	// and implying things about actions taken is the defect class this whole
	// change is about (caught in review, 2026-07-29).
	const headline = mutating
		? `Incomplete edit: this project declares ${env.label} in its tsconfig. ${extensions} templates are outside the TypeScript program, so this tool cannot update them — ${env.resolution}.`
		: `Incomplete result: this project declares ${env.label} in its tsconfig. ${extensions} templates are outside the TypeScript program, so references from them cannot appear above — ${env.resolution}.`;
	const body =
		mentions.length > 0
			? `\n\n${
					mutating
						? "Template text matches, not updated by this tool — review each by hand:"
						: "Template text matches (unresolved, matched as text — review by hand):"
				}\n${formatMentions(mentions)}`
			: `\n\nNo template text matched this symbol's known spellings, which is evidence but not proof: a template can reach a symbol through a name this tool cannot predict.`;
	return {
		text: `${headline}${body}`,
		data: {
			environment: env.kind,
			templateExtensions: env.extensions,
			unresolvedMentions: mentions,
		},
	};
}
