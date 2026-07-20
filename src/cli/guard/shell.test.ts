import { describe, expect, it } from "vitest";
import { splitSimpleCommands } from "./shell";

describe("splitSimpleCommands", () => {
	it("splits on pipes, chains, and newlines", () => {
		expect(splitSimpleCommands("ls | grep foo && echo done")).toEqual([
			["ls"],
			["grep", "foo"],
			["echo", "done"],
		]);
	});

	it("keeps backslashes intact inside double quotes (POSIX semantics)", () => {
		// In double quotes, backslash escapes only $ ` " \ — otherwise BOTH
		// characters survive. BRE alternation (\|) depends on this.
		expect(
			splitSimpleCommands('grep -rn "standardNode\\|cardNode" src/'),
		).toEqual([["grep", "-rn", "standardNode\\|cardNode", "src/"]]);
		expect(splitSimpleCommands('echo "a\\$b \\"c\\" d\\\\e"')).toEqual([
			["echo", 'a$b "c" d\\e'],
		]);
	});

	it("preserves single-quoted content verbatim", () => {
		expect(splitSimpleCommands("rg 'calculateSum\\(' src/")).toEqual([
			["rg", "calculateSum\\(", "src/"],
		]);
	});

	it("recurses into command substitutions and keeps the literal token", () => {
		const commands = splitSimpleCommands(
			'hits=$(grep -rn "$name" src/ | wc -l)',
		);
		expect(commands).toContainEqual(["grep", "-rn", "$name", "src/"]);
		expect(commands).toContainEqual(["wc", "-l"]);
	});

	it("drops redirects and their targets", () => {
		expect(splitSimpleCommands("grep foo file.txt > /tmp/out 2>&1")).toEqual([
			["grep", "foo", "file.txt"],
		]);
	});
});
