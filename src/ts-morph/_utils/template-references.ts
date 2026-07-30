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
	/**
	 * The spelling sits where a template engine RESOLVES a name (`<Foo`,
	 * `{{foo`, `{{#foo`, `(foo`, `"foo"`), rather than merely appearing on the
	 * line. A ranking signal, never a filter: see findTemplateMentions.
	 */
	invocation: boolean;
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
/** Mentions printed in a tool's message. */
const MAX_MENTIONS = 25;
/**
 * Mentions collected before ranking. Wider than what is printed so a generic
 * spelling cannot bury the one invocation that matters, but still bounded — a
 * name like `item` must not turn this into a full-project text index.
 */
const MAX_SCANNED_MENTIONS = 200;

/**
 * Role suffixes a framework strips when a class becomes a template-resolvable
 * name — Ember's resolver conventions, plus Angular's `Directive`/`Pipe`, whose
 * selectors and pipe names likewise drop the suffix.
 */
const ROLE_SUFFIXES = [
	"Component",
	"Helper",
	"Modifier",
	"Service",
	"Directive",
	"Pipe",
];

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
 * Matches a spelling sitting where a template engine RESOLVES a name, as
 * opposed to merely mentioning it. Two shapes, because a trailing `.` means
 * opposite things in each:
 *
 * - **angle** — `<Foo`, `</Foo`, and `<Foo.Bar`. A dotted angle-bracket name is
 *   a CONTEXTUAL COMPONENT (`<Item.Sub />`), which is a real invocation of
 *   `Item`, so the dot must not disqualify it.
 * - **curly** — `{{foo`, `{{#foo`, `{{/foo`, `{foo}`, `(foo`, `"foo"`. Here a
 *   dot is a path read off a local, nearly always a block param: `{{item.name}}`
 *   inside `{{#each rows as |item|}}` invokes nothing called `item`.
 *
 * Ranking only — never a filter. A shape this does not recognize still gets
 * reported, it just sorts lower.
 *
 * @param alternation escaped spellings already joined with `|`
 */
export function invocationPatternFor(alternation: string): RegExp {
	return new RegExp(
		[
			`<\\/?(?:${alternation})(?![\\w-])`,
			`(?:\\{\\{[#/]?|\\{|\\(|["'])(?:${alternation})(?![\\w-.])`,
		].join("|"),
	);
}

/**
 * Template lines mentioning any spelling of the given symbols. Word-ish
 * boundaries keep `<BasicTooltip />` and `{{basic-tooltip}}` in while keeping
 * `basic-tooltip-header` out.
 *
 * Matching stays deliberately BROAD — a false positive costs a human one glance,
 * a false negative silently orphans a template — but the presentation is ranked.
 * Taking the first 25 in directory-walk order could drop the one line that
 * mattered: a component called `Item` also matches every `{{item.name}}` and
 * `as |item|` in the app, and 25 block-param lines from `app/templates/a.hbs`
 * would bury the `<Item />` in `app/templates/z.hbs`. Invocation-shaped matches
 * are therefore collected across a wider budget and sorted to the front.
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
	const alternation = spellings.map(escapeRegExp).join("|");
	const pattern = new RegExp(`(?<![\\w-])(?:${alternation})(?![\\w-])`);
	const invocationPattern = invocationPatternFor(alternation);
	const mentions: TemplateMention[] = [];
	for (const file of collectTemplateFiles(projectRoot, env.extensions)) {
		if (mentions.length >= MAX_SCANNED_MENTIONS) break;
		let contents: string;
		try {
			if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
			contents = fs.readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		if (!pattern.test(contents)) continue;
		const lines = contents.split(/\r?\n/);
		for (
			let i = 0;
			i < lines.length && mentions.length < MAX_SCANNED_MENTIONS;
			i++
		) {
			if (pattern.test(lines[i])) {
				mentions.push({
					filePath: file,
					line: i + 1,
					text: lines[i].trim(),
					invocation: invocationPattern.test(lines[i]),
				});
			}
		}
	}
	return mentions;
}

/**
 * The mentions worth printing, invocation-shaped first. Ranking only — every
 * mention collected is still counted, and the caller reports the true total.
 */
function rankMentions(mentions: TemplateMention[]): TemplateMention[] {
	return [...mentions]
		.sort((a, b) => Number(b.invocation) - Number(a.invocation))
		.slice(0, MAX_MENTIONS);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatMentions(mentions: TemplateMention[]): string {
	const ranked = rankMentions(mentions);
	const shown = ranked
		.map((m) => `- ${m.filePath}:${m.line}\n  ${m.text}`)
		.join("\n");
	if (ranked.length === mentions.length) {
		return shown;
	}
	// Say what was dropped and on what basis: a silent cut here reads as "these
	// are all the matches", which is the claim this module exists to avoid.
	const total =
		mentions.length >= MAX_SCANNED_MENTIONS
			? `${MAX_SCANNED_MENTIONS}+`
			: `${mentions.length}`;
	return `${shown}\n(showing ${ranked.length} of ${total} matches, invocation-shaped first)`;
}

/**
 * Names searched for in one pass. Every name contributes ~3 spellings to a
 * single alternation, and `find_unused_exports` in summary mode can hold tens of
 * thousands of candidates: 100k names compiles to a ~7MB pattern that costs over
 * a second before a single template is read. Bounded, and the caller reports the
 * bound rather than quietly answering for a subset.
 */
const MAX_ATTRIBUTED_NAMES = 500;

/**
 * Which of `symbolNames` a template mentions anywhere in the project.
 *
 * For callers holding MANY names at once — `find_unused_exports` reports up to
 * a hundred candidates by default — where per-line detail would drown the output
 * and a per-name scan would re-read the whole template tree once per candidate.
 * One pass collects every matched spelling and maps it back to the name that
 * owns it.
 *
 * `scannedNames` is how many of the input names were actually searched; anything
 * past MAX_ATTRIBUTED_NAMES was not, and saying so is the caller's job.
 */
export function findTemplateMentionedNames(
	tsconfigPath: string,
	candidates: Array<{ name: string; filePath?: string }>,
):
	| {
			environment: TemplateEnvironment;
			mentioned: string[];
			scannedNames: number;
	  }
	| undefined {
	const environment = detectTemplateEnvironment(tsconfigPath);
	if (environment === undefined || candidates.length === 0) {
		return undefined;
	}
	const byName = new Map<string, string | undefined>();
	for (const candidate of candidates) {
		if (!byName.has(candidate.name)) {
			byName.set(candidate.name, candidate.filePath);
		}
	}
	const searched = [...byName].slice(0, MAX_ATTRIBUTED_NAMES);
	// One spelling can belong to several names (two symbols can dasherize alike),
	// so a hit credits every owner rather than an arbitrary one.
	const owners = new Map<string, Set<string>>();
	for (const [name, filePath] of searched) {
		// The declaring file's name counts as a spelling of the symbol: Ember
		// resolves `<SidePanel />` to side-panel.ts whatever the class inside is
		// called, so a name-only search misses the component's only real use.
		const spellings = [
			...templateSpellings(name),
			...(filePath
				? templateSpellings(path.basename(filePath, path.extname(filePath)))
				: []),
		];
		for (const spelling of spellings) {
			if (spelling.length <= 1) continue;
			const existing = owners.get(spelling);
			if (existing) {
				existing.add(name);
			} else {
				owners.set(spelling, new Set([name]));
			}
		}
	}
	if (owners.size === 0) {
		return undefined;
	}
	const pattern = new RegExp(
		`(?<![\\w-])(?:${[...owners.keys()].map(escapeRegExp).join("|")})(?![\\w-])`,
		"g",
	);
	const projectRoot = path.dirname(path.resolve(tsconfigPath));
	const mentioned = new Set<string>();
	for (const file of collectTemplateFiles(
		projectRoot,
		environment.extensions,
	)) {
		if (mentioned.size === searched.length) break;
		let contents: string;
		try {
			if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
			contents = fs.readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		for (const match of contents.matchAll(pattern)) {
			for (const name of owners.get(match[0]) ?? []) {
				mentioned.add(name);
			}
		}
	}
	return {
		environment,
		mentioned: [...mentioned],
		scannedNames: searched.length,
	};
}

/**
 * Folds a caveat into a tool result: prose appended, mention count logged,
 * `templateBlindSpot` added to the payload.
 *
 * Three mutating tools wired this identically by hand, which is three chances
 * for the next one to log a different key or forget the payload. The result is
 * returned unchanged when there is no caveat, so a non-template project pays
 * nothing and reads exactly as before.
 */
export function withTemplateCaveat<T extends object>(
	result: { message: string; log?: Record<string, unknown>; data: T },
	caveat: TemplateCaveat | undefined,
): {
	message: string;
	log?: Record<string, unknown>;
	data: T | (T & { templateBlindSpot: TemplateCaveat["data"] });
} {
	if (caveat === undefined) {
		return result;
	}
	return {
		message: `${result.message}\n\n${caveat.text}`,
		log: {
			...result.log,
			templateMentions: caveat.data.unresolvedMentions.length,
		},
		data: { ...result.data, templateBlindSpot: caveat.data },
	};
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
 * `mutating` switches the wording between an incomplete ANSWER ("references from
 * them cannot appear above") and an incomplete EDIT ("this tool cannot update
 * them"). Both are capability statements; see the note on `headline` for why
 * neither may describe an action.
 *
 * `data.unresolvedMentions` carries every mention collected, not the ranked
 * subset the message prints — a --json consumer should get the whole set.
 */
export function templateCaveat({
	tsconfigPath,
	symbolNames,
	filePaths = [],
	mutating,
}: {
	tsconfigPath: string;
	symbolNames: string[];
	/**
	 * Files declaring those symbols. Classic Ember resolves a component from its
	 * FILE NAME, not its class name, so a `class Tooltip` living in
	 * `app/components/basic-tooltip.ts` is invoked as `<BasicTooltip />` — a
	 * spelling nothing about the symbol name can predict. Searching the symbol
	 * alone made the blind-spot detector blind in exactly the case it exists for.
	 */
	filePaths?: string[];
	mutating: boolean;
}): TemplateCaveat | undefined {
	const env = detectTemplateEnvironment(tsconfigPath);
	if (env === undefined) {
		return undefined;
	}
	const projectRoot = path.dirname(path.resolve(tsconfigPath));
	const names = [
		...new Set([
			...symbolNames,
			...filePaths.map((file) => path.basename(file, path.extname(file))),
		]),
	];
	const mentions = findTemplateMentions(env, projectRoot, names);
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
