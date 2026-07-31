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
 *
 * The `open()` branch requires the mode as its own quoted argument after a
 * comma. Matching any quote-adjacent `w`/`a` inside the parens made the
 * FILENAME satisfy it — `open('Main.java').read()` and `open('schema.prisma')`
 * are read-mode opens whose names merely end in the right letter (caught in
 * review, 2026-07-31; the same false-positive class as the bare `.write(`).
 */
const WRITE_API_RE =
	/\b(?:write_text|write_bytes|writelines|writeFileSync|writeFile|writeTextFile|writeTextFileSync|outputFileSync|file_put_contents|fwrite|fputs)\b|\bFile\.(?:write|open)\b|\b(?:IO|Bun)\.write\b|\bopen\s*\([^)]*,\s*['"][wa][bt+]*['"]/;

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

/**
 * `p = Path('x')` / `p = pathlib.Path("x")` — the binding a later
 * `p.write_text(...)` resolves through. Only a string LITERAL argument counts;
 * `Path(sys.argv[1])` binds the name to nothing provable.
 */
const PATH_ASSIGNMENT_RE =
	/\b(\w+)\s*=\s*(?:pathlib\s*\.\s*)?Path\s*\(\s*(['"])([^'"]+)\2\s*\)/g;

/** `Path('x').write_text(...)` — the receiver names its destination inline. */
const INLINE_PATH_WRITE_RE =
	/\bPath\s*\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*(?:write_text|write_bytes|writelines)\s*\(/g;

/** `p.write_text(...)` — the destination lives on the receiver variable. */
const RECEIVER_WRITE_RE =
	/\b(\w+)\s*\.\s*(?:write_text|write_bytes|writelines)\s*\(/g;

/** True for a path whose extension is listed as outside the guard's remit. */
function isNonSourceTarget(target: string): boolean {
	if (SOURCE_EXT_RE.test(target)) {
		return false;
	}
	const ext = /\.([A-Za-z0-9]{1,10})$/.exec(target)?.[1]?.toLowerCase();
	return ext !== undefined && NON_SOURCE_EXTENSIONS.has(ext);
}

/**
 * Where the script's file WRITES land, judged per write target — never by
 * scanning the whole command for path-looking tokens. A whole-command scan
 * let `fs.writeFileSync(f, ...)` — destination a variable, provably nothing —
 * borrow innocence from a harmless `cfg.json` mentioned elsewhere in the same
 * command (caught in review, 2026-07-30).
 *
 * - "source":     some provable target is a TS/JS path.
 * - "non-source": EVERY write has a provable target and every one of them is
 *   a known non-source file. Extracting data out of TypeScript is not
 *   hand-editing it: `fs.writeFileSync('data.json',
 *   fs.readFileSync('src/a.ts','utf8').replace(...))` reads a source file,
 *   but the file it rewrites is a .json.
 * - "unknown":    anything less — a variable target, an unrecognized
 *   extension, more writes than provable destinations.
 *
 * Provable means the destination is a string literal: the first argument of
 * the literal-target API family, or a receiver traced through
 * `Path('literal')` (inline or via a simple assignment). Requiring every
 * write to be proven is what keeps this from being an escape hatch — with two
 * writes, `writeFileSync('a.json', x); writeFileSync(f, y)` would otherwise
 * present its harmless target and hide the real one.
 */
export function writeTargetScope(
	script: string,
): "source" | "non-source" | "unknown" {
	const writeCount = [...script.matchAll(WRITE_API_GLOBAL_RE)].length;
	const bindings = new Map<string, string>();
	for (const match of script.matchAll(PATH_ASSIGNMENT_RE)) {
		bindings.set(match[1], match[3]);
	}
	const targets = [...script.matchAll(LITERAL_WRITE_TARGET_RE)]
		.map((match) => match[2] ?? match[4] ?? match[6])
		.filter((target): target is string => target !== undefined);
	for (const match of script.matchAll(INLINE_PATH_WRITE_RE)) {
		targets.push(match[2]);
	}
	let unresolvedReceivers = 0;
	for (const match of script.matchAll(RECEIVER_WRITE_RE)) {
		const bound = bindings.get(match[1]);
		if (bound === undefined) {
			unresolvedReceivers += 1;
		} else {
			targets.push(bound);
		}
	}
	if (targets.some((target) => SOURCE_EXT_RE.test(target))) {
		return "source";
	}
	if (
		writeCount > 0 &&
		unresolvedReceivers === 0 &&
		targets.length === writeCount &&
		targets.every(isNonSourceTarget)
	) {
		return "non-source";
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
 * A heredoc feeding one of the recognized interpreters: `python3 <<'EOF'`.
 * Unlike a script file, the program IS in the command string — refusing to
 * look at it would concede an edit the guard can plainly see.
 */
const HEREDOC_INTERPRETER_RE =
	/\b(?:python3?|node|bun|deno|ruby|php|perl)\b[^\n|;&]*<<-?\s*/;

/**
 * The program text of an eval invocation, or undefined when the args carry
 * none. Handles the flag as its own token (`-c 'prog'`, after shell quote
 * removal `-c prog`) and ATTACHED to the program — `-c'prog'` tokenizes to
 * `-cprog`, and node accepts `--eval=prog` (caught in review, 2026-07-31:
 * exact-equality matching let both attached forms through). Attachment is
 * only recognized on single-dash flags and `--flag=`, so deno's bare `eval`
 * subcommand cannot false-positive on an argument like `evaluate.ts`.
 */
function evalScript(
	args: string[],
	evalFlags: ReadonlySet<string>,
): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (evalFlags.has(arg)) {
			const script = args.slice(i + 1).join(" ");
			return script === "" ? undefined : script;
		}
		for (const flag of evalFlags) {
			if (flag.startsWith("--")) {
				if (arg.startsWith(`${flag}=`)) {
					return [arg.slice(flag.length + 1), ...args.slice(i + 1)].join(" ");
				}
			} else if (
				flag.startsWith("-") &&
				arg.length > flag.length &&
				arg.startsWith(flag)
			) {
				return [arg.slice(flag.length), ...args.slice(i + 1)].join(" ");
			}
		}
	}
	return undefined;
}

/** The shared three-effect test: reads a file, substitutes, writes one back. */
function isRewriteScript(script: string): boolean {
	return (
		WRITE_API_RE.test(script) &&
		READ_API_RE.test(script) &&
		REPLACE_API_RE.test(script) &&
		// Only a write whose destination is PROVABLY non-source escapes. A
		// variable target proves nothing and stays blocked, no matter what
		// harmless paths appear elsewhere in the command.
		writeTargetScope(script) !== "non-source"
	);
}

/**
 * A read → substitute → write one-liner. Requires all three effects so that
 * generating a brand-new file (write only) and dumping one (read only) stay
 * allowed; the overwrite rule below covers writes over files that exist.
 */
function isInterpreterRewrite(command: string): boolean {
	// A heredoc-fed interpreter has no eval flag, but its program sits right in
	// the command string. The body is not delimited out; the whole command is
	// scanned, and the three-effect requirement plus per-target write scoping
	// still gate the verdict.
	if (HEREDOC_INTERPRETER_RE.test(command) && isRewriteScript(command)) {
		return true;
	}
	for (const tokens of splitSimpleCommands(command)) {
		const { name, args } = commandWord(tokens);
		let script: string | undefined;
		if (name === "perl") {
			// perl -e / -pe / -ne: any flag cluster containing `e` takes a program.
			const flagIndex = args.findIndex((a) => /^-[a-zA-Z]*e[a-zA-Z]*$/.test(a));
			if (flagIndex === -1) continue;
			script = args.slice(flagIndex + 1).join(" ");
		} else {
			const evalFlags = EVAL_FLAGS[name] as ReadonlySet<string> | undefined;
			if (!evalFlags) continue;
			script = evalScript(args, evalFlags);
		}
		if (script === undefined || script === "") continue;
		if (isRewriteScript(script)) {
			return true;
		}
	}
	return false;
}

// ── overwrites of files that already exist ──────────────────────────────────

/**
 * Where this command's redirects and `tee` invocations write. Harvested from
 * the quote-aware tokenizer, never from a raw-string regex: a regex saw the
 * arrow inside `git commit -m "moved foo -> src/index.ts"` — quoted prose, no
 * redirect anywhere — and hard-blocked the commit an agent writes right after
 * using this package's own rename tools (caught in review, 2026-07-31). Only
 * the tokenizer knows which `>` is shell syntax.
 */
function overwriteTargets(command: string): string[] {
	const targets: string[] = [];
	const commands = splitSimpleCommands(command, (target) =>
		targets.push(target),
	);
	for (const tokens of commands) {
		const { name, args } = commandWord(tokens);
		if (name !== "tee") {
			continue;
		}
		for (const arg of args) {
			// Every non-flag argument is a file tee writes (`-a` appends, but to
			// the same files).
			if (!arg.startsWith("-")) {
				targets.push(arg);
			}
		}
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
