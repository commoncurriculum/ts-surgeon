import * as fs from "node:fs";
import * as path from "node:path";
import { hasGeneratedOrVendoredSegment, SOURCE_EXT_RE } from "./scope.js";
import { splitSimpleCommands } from "./shell.js";

/**
 * Hand-edits of TS/JS sources — the one thing the guard always hard blocks.
 * Text replacement misses imports, re-exports, and same-name collisions;
 * rename_symbol / change_signature / rewrite_pattern exist for exactly this.
 *
 * Detection is by WRITE EFFECT, not by binary name. Blocking `sed -i` while
 * `python3 -c "p.write_text(p.read_text().replace(a, b))"` sails through does
 * not stop the edit — it selects for the nearest undetected interpreter
 * (observed 2026-07-29: the identical edit succeeded via python3 on the first
 * attempt after the sed denial). Three effects are recognized:
 *
 * - `stream-editor`: sed -i / perl -pi over source paths.
 * - `interpreter`:   a one-liner (`python3 -c`, `node -e`, `ruby -e`, `php -r`)
 *                    that reads a file, substitutes text, and writes it back.
 * - `overwrite`:     a redirect or `tee` onto a source file that ALREADY
 *                    exists — `cat > f.ts <<'EOF'`, `... >> f.ts`.
 *
 * Coverage is still partial by construction (a script file, an interpreter not
 * listed here, or a compiled program all write files without saying so), which
 * is why the block message no longer claims otherwise. See messages.ts.
 */

export type SourceRewriteKind = "stream-editor" | "interpreter" | "overwrite";

/** Filesystem access, injected so the policy stays testable. */
export interface EditEnvironment {
	cwd: string;
	/** True when the path names a file that already exists. */
	exists: (absolutePath: string) => boolean;
}

export function realEditEnvironment(
	cwd: string = process.cwd(),
): EditEnvironment {
	return {
		cwd,
		exists: (target) => {
			try {
				return fs.statSync(target).isFile();
			} catch {
				return false;
			}
		},
	};
}

// ── stream editors ──────────────────────────────────────────────────────────

const IN_PLACE_SED_RE = /\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*\b|--in-place\b)/;
const IN_PLACE_PERL_RE = /\bperl\s+-[a-zA-Z]*i/;

// ── interpreter one-liners ──────────────────────────────────────────────────

/** Eval flags per interpreter: the forms that take a program on the command line. */
const EVAL_FLAGS: Record<string, ReadonlySet<string>> = {
	python: new Set(["-c"]),
	python3: new Set(["-c"]),
	node: new Set(["-e", "-p", "--eval", "--print"]),
	bun: new Set(["-e", "--eval"]),
	deno: new Set(["eval"]),
	ruby: new Set(["-e"]),
	php: new Set(["-r"]),
};

/**
 * FILE writes only. A bare `.write(` used to be listed here, which made
 * `process.stdout.write(fs.readFileSync('x.ts','utf8').replace(a,b))` — a
 * read-only transform printed to the terminal — look like a rewrite and get
 * blocked (caught in review, 2026-07-29). Every alternative below names a
 * file API or an `open()` in a writing mode; a python file handle's `.write()`
 * is reached through that `open(..., 'w')` instead of a generic method name.
 */
const WRITE_API_RE =
	/\b(?:write_text|write_bytes|writelines|writeFileSync|writeFile|writeTextFile|writeTextFileSync|outputFileSync|file_put_contents|fwrite|fputs)\b|\bFile\.(?:write|open)\b|\b(?:IO|Bun)\.write\b|\bopen\s*\([^)]*['"][^'"]*[wa]\+?['"]/;

/**
 * A generic `.read(` is kept: on its own it cannot trigger anything, because a
 * block also requires a real file WRITE. `.text(` was dropped as redundant —
 * `Bun.file(...)` already identifies that read.
 */
const READ_API_RE =
	/\b(?:read_text|read_bytes|readlines|readFileSync|readFile|readTextFile|readTextFileSync|file_get_contents|fread)\b|\bFile\.read\b|\bIO\.read\b|\bBun\.file\b|\.read\s*\(/;

const REPLACE_API_RE =
	/\.replace(?:All)?\s*\(|\bre\.sub\b|\bgsub\b|\bstr_replace\b|\bpreg_replace\b|\bs\/[^/]*\/[^/]*\//;

/**
 * File extensions that place a command's target outside the guard's remit.
 * Anything not listed here and not a source extension (`.replace`, `.sub`, a
 * bare variable) leaves the target UNKNOWN — and an unknown target is treated
 * as source, because that is the case the guard exists for.
 */
const NON_SOURCE_EXTENSIONS = new Set([
	"json",
	"jsonc",
	"json5",
	"md",
	"mdx",
	"txt",
	"csv",
	"tsv",
	"yml",
	"yaml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"lock",
	"log",
	"snap",
	"html",
	"htm",
	"xml",
	"svg",
	"css",
	"scss",
	"sass",
	"less",
	"sh",
	"bash",
	"zsh",
	"fish",
	"py",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"swift",
	"ex",
	"exs",
	"erl",
	"php",
	"sql",
	"graphql",
	"gql",
	"proto",
	"tf",
	"dockerfile",
	"gitignore",
	"npmrc",
]);

const PATH_TOKEN_RE = /[\w./@~-]*\.([A-Za-z0-9]{1,10})\b/g;

/**
 * Write calls whose FIRST argument is the destination path, with that path
 * written as a literal. Only this family can be read back out of a command
 * string with any confidence — `p.write_text(...)` names its destination on the
 * receiver and `fwrite($h, ...)` on a handle opened earlier, so neither is here.
 */
// Built from strings, not regex literals: the backreferences are numbered
// across the COMBINED pattern, so each branch's quote-matching group only
// resolves once they are joined.
const LITERAL_WRITE_TARGET_RE = new RegExp(
	[
		String.raw`\b(?:writeFileSync|writeFile|writeTextFileSync|writeTextFile|outputFileSync|file_put_contents)\s*\(\s*(['"])([^'"]+)\1`,
		String.raw`\b(?:IO|Bun|File)\.write\s*\(\s*(['"])([^'"]+)\3`,
		String.raw`\bopen\s*\(\s*(['"])([^'"]+)\5\s*,\s*['"][wa]`,
	].join("|"),
	"g",
);

/** Every write-API occurrence, to tell "one write" from "several". */
const WRITE_API_GLOBAL_RE = new RegExp(WRITE_API_RE.source, "g");

/** True for a path whose extension is listed as outside the guard's remit. */
function isNonSourceTarget(target: string): boolean {
	if (SOURCE_EXT_RE.test(target)) {
		return false;
	}
	const ext = /\.([A-Za-z0-9]{1,10})$/.exec(target)?.[1]?.toLowerCase();
	return ext !== undefined && NON_SOURCE_EXTENSIONS.has(ext);
}

/**
 * True when the script performs exactly ONE file write and that write provably
 * targets a non-source file.
 *
 * Extracting data out of TypeScript is not hand-editing it:
 * `node -e "fs.writeFileSync('data.json', fs.readFileSync('src/a.ts','utf8').replace(...))"`
 * reads a source file, but the file it rewrites is a .json. Scanning the whole
 * command for a source extension called that a source rewrite, which is the same
 * over-block as the `process.stdout.write` case — an agent denied for extracting
 * data learns to distrust the guard exactly as fast as one denied for printing.
 *
 * The single-write requirement is what keeps this from being an escape hatch:
 * with two writes, `writeFileSync('a.json', x); writeFileSync('src/x.ts', y)`
 * would otherwise present its harmless target and hide the real one.
 */
function writesOnlyNonSourceFile(script: string): boolean {
	if ([...script.matchAll(WRITE_API_GLOBAL_RE)].length !== 1) {
		return false;
	}
	const targets = [...script.matchAll(LITERAL_WRITE_TARGET_RE)]
		.map((match) => match[2] ?? match[4] ?? match[6])
		.filter((target): target is string => target !== undefined);
	return targets.length === 1 && isNonSourceTarget(targets[0]);
}

/**
 * Does the command name a file it is plainly not the guard's business to
 * protect? "source" when a TS/JS path appears, "non-source" when every named
 * file is something else, "unknown" when the target is a variable
 * (`fs.writeFileSync(f, ...)`) — the common shape of a computed edit.
 */
export function namedTargetScope(
	command: string,
): "source" | "non-source" | "unknown" {
	if (SOURCE_EXT_RE.test(command)) {
		return "source";
	}
	for (const match of command.matchAll(PATH_TOKEN_RE)) {
		if (NON_SOURCE_EXTENSIONS.has(match[1].toLowerCase())) {
			return "non-source";
		}
	}
	return "unknown";
}

/** Leading `FOO=bar` assignments and `env`/`command` wrappers precede the binary. */
function commandWord(tokens: string[]): { name: string; args: string[] } {
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	while (
		i < tokens.length &&
		(tokens[i] === "env" || tokens[i] === "command" || tokens[i] === "exec")
	) {
		i++;
		while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	}
	const name = path.basename(tokens[i] ?? "");
	return { name, args: tokens.slice(i + 1) };
}

/**
 * A read → substitute → write one-liner. Requires all three effects so that
 * generating a brand-new file (write only) and dumping one (read only) stay
 * allowed; the overwrite rule below covers writes over files that exist.
 */
function isInterpreterRewrite(command: string): boolean {
	for (const tokens of splitSimpleCommands(command)) {
		const { name, args } = commandWord(tokens);
		const evalFlags =
			name === "perl" ? undefined : (EVAL_FLAGS[name] as ReadonlySet<string>);
		let script: string | undefined;
		if (name === "perl") {
			// perl -e / -pe / -ne: any flag cluster containing `e` takes a program.
			const flagIndex = args.findIndex((a) => /^-[a-zA-Z]*e[a-zA-Z]*$/.test(a));
			if (flagIndex === -1) continue;
			script = args.slice(flagIndex + 1).join(" ");
		} else if (evalFlags) {
			const flagIndex = args.findIndex((a) => evalFlags.has(a));
			if (flagIndex === -1) continue;
			script = args.slice(flagIndex + 1).join(" ");
		} else {
			continue;
		}
		if (script === undefined || script === "") continue;
		if (
			WRITE_API_RE.test(script) &&
			READ_API_RE.test(script) &&
			REPLACE_API_RE.test(script) &&
			// A provably non-source write target beats the whole-command scan: the
			// command mentions a .ts because it READS one.
			!writesOnlyNonSourceFile(script) &&
			namedTargetScope(command) !== "non-source"
		) {
			return true;
		}
	}
	return false;
}

// ── overwrites of files that already exist ──────────────────────────────────

/** `> file`, `>> file` — an fd prefix (`2>`) or `>&2` is not a file target. */
const REDIRECT_RE = /(?:^|[^0-9<>&|])>{1,2}\s*(['"]?)([^\s'"<>|;&()]+)\1/g;
const TEE_RE = /\btee\b((?:\s+-[a-zA-Z-]+)*)\s+(['"]?)([^\s'"<>|;&()]+)\2/g;

function overwriteTargets(command: string): string[] {
	const targets: string[] = [];
	for (const match of command.matchAll(REDIRECT_RE)) {
		targets.push(match[2]);
	}
	for (const match of command.matchAll(TEE_RE)) {
		targets.push(match[3]);
	}
	return targets;
}

/**
 * True when the command replaces the contents of a source file that already
 * exists. Creating a NEW file this way stays allowed: the objection is to
 * hand-rewriting code the project already has, not to writing code at all.
 */
function overwritesExistingSource(
	command: string,
	env: EditEnvironment,
): boolean {
	return overwriteTargets(command).some((target) => {
		if (!SOURCE_EXT_RE.test(target) || hasGeneratedOrVendoredSegment(target)) {
			return false;
		}
		return env.exists(path.resolve(env.cwd, target));
	});
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * The write effect this command has on project TS/JS sources, or undefined
 * when it has none the guard recognizes.
 */
export function detectSourceRewrite(
	command: string,
	env: EditEnvironment = realEditEnvironment(),
): SourceRewriteKind | undefined {
	if (
		SOURCE_EXT_RE.test(command) &&
		(IN_PLACE_SED_RE.test(command) || IN_PLACE_PERL_RE.test(command))
	) {
		return "stream-editor";
	}
	if (isInterpreterRewrite(command)) {
		return "interpreter";
	}
	if (overwritesExistingSource(command, env)) {
		return "overwrite";
	}
	return undefined;
}
