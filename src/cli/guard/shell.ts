/**
 * Stage 1 of the guard pipeline: shell-level tokenization.
 *
 * Splits a shell command string into simple commands (token lists), cutting at
 * pipes, `;`, `&&`/`||`, newlines, subshells, and loops, and recursing into
 * `$(...)` / backtick substitutions so nested invocations are inspected too.
 * Quoting is honored with POSIX semantics — in double quotes a backslash
 * escapes only `$`, backquote, `"`, `\`, and newline; before anything else
 * both characters survive (BRE patterns like `\|` depend on this). Redirects
 * and their targets are dropped. This is deliberately an approximation — it
 * only has to be good enough to find every search invocation, never to
 * execute.
 */
export function splitSimpleCommands(command: string): string[][] {
	const commands: string[][] = [];
	const collect = (input: string): void => {
		let current: string[] = [];
		let tok = "";
		let hasTok = false;
		const pushTok = () => {
			if (hasTok) {
				current.push(tok);
			}
			tok = "";
			hasTok = false;
		};
		const pushCmd = () => {
			pushTok();
			if (current.length > 0) {
				commands.push(current);
			}
			current = [];
		};
		let i = 0;
		while (i < input.length) {
			const c = input[i];
			if (c === "'") {
				const end = input.indexOf("'", i + 1);
				tok += end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
				hasTok = true;
				i = end === -1 ? input.length : end + 1;
			} else if (c === '"') {
				let j = i + 1;
				while (j < input.length && input[j] !== '"') {
					if (input[j] === "\\" && j + 1 < input.length) {
						const next = input[j + 1];
						if (next === "$" || next === "`" || next === '"' || next === "\\") {
							tok += next;
						} else if (next === "\n") {
							// line continuation: both characters vanish
						} else {
							tok += `\\${next}`;
						}
						j += 2;
					} else {
						tok += input[j];
						j++;
					}
				}
				hasTok = true;
				i = j + 1;
			} else if (c === "\\") {
				if (i + 1 < input.length) {
					tok += input[i + 1];
					hasTok = true;
				}
				i += 2;
			} else if (c === "$" && input[i + 1] === "(") {
				// Command substitution: inspect the inner commands too, and keep the
				// literal `$(...)` so a substitution used as a pattern reads as dynamic.
				let depth = 1;
				let j = i + 2;
				while (j < input.length && depth > 0) {
					if (input[j] === "(") depth++;
					else if (input[j] === ")") depth--;
					if (depth > 0) j++;
				}
				collect(input.slice(i + 2, j));
				tok += input.slice(i, Math.min(j + 1, input.length));
				hasTok = true;
				i = j + 1;
			} else if (c === "`") {
				const end = input.indexOf("`", i + 1);
				const inner = end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
				collect(inner);
				tok += `$(${inner})`;
				hasTok = true;
				i = end === -1 ? input.length : end + 1;
			} else if (c === "#" && !hasTok) {
				const nl = input.indexOf("\n", i);
				i = nl === -1 ? input.length : nl;
			} else if (c === "\n") {
				pushCmd();
				i++;
			} else if (/\s/.test(c)) {
				pushTok();
				i++;
			} else if (
				c === "|" ||
				c === ";" ||
				c === "&" ||
				c === "(" ||
				c === ")"
			) {
				pushCmd();
				i++;
			} else if (c === "<" || c === ">") {
				// Redirect: drop an fd prefix ("2>"), the operator run, and its target.
				if (/^\d+$/.test(tok)) {
					tok = "";
					hasTok = false;
				} else {
					pushTok();
				}
				while (i < input.length && /[<>&]/.test(input[i])) i++;
				while (i < input.length && /\s/.test(input[i])) i++;
				while (i < input.length && !/[\s|;&()<>]/.test(input[i])) i++;
			} else {
				tok += c;
				hasTok = true;
				i++;
			}
		}
		pushCmd();
	};
	collect(command);
	return commands;
}
