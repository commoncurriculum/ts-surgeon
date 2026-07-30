import { describe, expect, it } from "vitest";
import { detectSourceRewrite, type EditEnvironment } from "./edits.js";

/**
 * The write-effect corpus. Every entry that BLOCKS must perform a real edit of
 * project TS/JS; every entry that ALLOWS must be something an agent legitimately
 * does. Over-blocking is as much a bug as under-blocking: an agent that cannot
 * write a new file learns to distrust the guard wholesale.
 */

/** No file exists — the default for command shapes that do not depend on disk. */
const emptyDisk: EditEnvironment = { cwd: "/repo", exists: () => false };

function diskWith(...files: string[]): EditEnvironment {
	const present = new Set(files);
	return { cwd: "/repo", exists: (p) => present.has(p) };
}

describe("detectSourceRewrite", () => {
	it("blocks in-place stream editors over sources", () => {
		for (const command of [
			"sed -i 's/oldName/newName/g' src/utils.ts",
			"sed -i '' 's/a/b/' lib/component.tsx",
			"perl -pi -e 's/foo/bar/' src/index.js",
		]) {
			expect(detectSourceRewrite(command, emptyDisk), command).toBe(
				"stream-editor",
			);
		}
	});

	// Defect report, 2026-07-29: after the sed denial, the identical edit
	// succeeded via python3 on the FIRST attempt. Blocking binaries selects for
	// the nearest undetected interpreter, so the rule is the effect instead.
	it("blocks read-substitute-write one-liners in any interpreter", () => {
		for (const command of [
			`python3 -c "import pathlib; p=pathlib.Path('f.ts'); p.write_text(p.read_text().replace('a','b'))"`,
			`node -e "fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(/a/g,'b'))"`,
			`node --eval "const s=fs.readFileSync('src/x.ts','utf8'); fs.writeFileSync('src/x.ts', s.replace('a','b'))"`,
			`ruby -e "File.write('a.ts', File.read('a.ts').gsub('x','y'))"`,
			`php -r "file_put_contents('a.ts', str_replace('x','y', file_get_contents('a.ts')));"`,
			`bun -e "await Bun.write(p, (await Bun.file(p).text()).replace(a,b))"`,
		]) {
			expect(detectSourceRewrite(command, emptyDisk), command).toBe(
				"interpreter",
			);
		}
	});

	it("leaves interpreter one-liners that are not source rewrites alone", () => {
		for (const command of [
			// Read-only.
			`python3 -c "import pathlib; print(pathlib.Path('f.ts').read_text())"`,
			// Rewrites a file that is plainly not TS/JS.
			`python3 -c "import pathlib; p=pathlib.Path('package.json'); p.write_text(p.read_text().replace('a','b'))"`,
			`node -e "fs.writeFileSync('notes.md', fs.readFileSync('notes.md','utf8').replace('a','b'))"`,
			// Generating a file, not rewriting one.
			`node -e "fs.writeFileSync('src/generated.ts', template)"`,
			// Transforms and PRINTS — nothing is written back. Caught in review
			// (2026-07-29): a bare `.write(` in the write-API pattern made
			// process.stdout.write look like a file write.
			`node -e "process.stdout.write(fs.readFileSync('x.ts','utf8').replace(/a/g,'b'))"`,
			`python3 -c "import pathlib; print(pathlib.Path('f.ts').read_text().replace('a','b'))"`,
			// Not an eval at all.
			"node scripts/codemod.js",
			"python3 -m pytest",
			// Extracts FROM a source file INTO a non-source one. The command names
			// a .ts because it reads one; the file it rewrites is a .json.
			`node -e "fs.writeFileSync('data.json', fs.readFileSync('src/a.ts','utf8').replace(/x/g,'y'))"`,
			`python3 -c "open('out.json','w').write(open('src/a.ts').read().replace('x','y'))"`,
		]) {
			expect(detectSourceRewrite(command, emptyDisk), command).toBeUndefined();
		}
	});

	// The narrowing above presents its harmless target; these make sure it cannot
	// be used to smuggle a second write past the check.
	it("still blocks when a non-source write is not the only write", () => {
		for (const command of [
			// The .json write is real, and would be the only literal target found —
			// but it is not the only write, and the other one rewrites a source file.
			`node -e "fs.writeFileSync('a.json', x); fs.writeFileSync('src/x.ts', fs.readFileSync('src/x.ts','utf8').replace('a','b'))"`,
			`node -e "fs.writeFileSync('src/x.ts', fs.readFileSync('src/x.ts','utf8').replace('a','b')); fs.writeFileSync('log.json', y)"`,
			// One write, but its target is a variable: nothing is proven about it,
			// so the whole-command scan still has the last word.
			`node -e "fs.writeFileSync(out, fs.readFileSync('src/a.ts','utf8').replace('a','b'))"`,
		]) {
			expect(detectSourceRewrite(command, emptyDisk), command).toBe(
				"interpreter",
			);
		}
	});

	it("blocks redirects and tee that replace a source file which already exists", () => {
		const disk = diskWith("/repo/src/app.ts", "/repo/lib/util.js");
		for (const command of [
			"cat > src/app.ts <<'EOF'\nexport const a = 1;\nEOF",
			"echo 'export const a = 1' > src/app.ts",
			"printf '%s' \"$body\" >> src/app.ts",
			"cat template.ts | tee lib/util.js",
			"cat template.ts | tee -a lib/util.js",
		]) {
			expect(detectSourceRewrite(command, disk), command).toBe("overwrite");
		}
	});

	// The block message says this check is a policy decision, not a sandbox.
	// These are the shapes that prove it: a command string cannot reveal what an
	// arbitrary program writes. They are pinned so nobody reads the corpus above
	// as a coverage claim — if one of them ever becomes detectable, this test
	// should fail and be rewritten, not deleted.
	it("does not pretend to catch writes it cannot see from a command string", () => {
		const disk = diskWith("/repo/src/app.ts");
		for (const command of [
			"python3 scripts/codemod.py", // the same edit, one file away
			"bash scripts/rename.sh",
			"make refactor",
			"git apply rename.patch",
			"patch -p1 < rename.diff",
			"./bin/my-compiled-codemod",
		]) {
			expect(detectSourceRewrite(command, disk), command).toBeUndefined();
		}
	});

	it("allows writes that create something new or target generated output", () => {
		const disk = diskWith("/repo/src/app.ts");
		for (const command of [
			// The file does not exist yet: writing new code is not hand-editing code.
			"cat > src/brand-new.ts <<'EOF'\nexport const a = 1;\nEOF",
			// Build output, not project source.
			"esbuild src/app.ts > dist/bundle.js",
			"cp x.ts node_modules/pkg/index.js",
			// Redirects that are not file targets, or not source files.
			"pnpm test > /tmp/out.txt 2>&1",
			"sed 's/foo/bar/' src/app.ts > /tmp/out.txt",
			"grep -rn foo src/ 2>/dev/null",
			"node dist/index.js list >&2",
		]) {
			expect(detectSourceRewrite(command, disk), command).toBeUndefined();
		}
	});
});
