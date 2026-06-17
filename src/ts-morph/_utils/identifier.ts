const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Reserved words (plus strict-mode future-reserved words and `eval`/`arguments`)
// that cannot be used as a binding name in a module (modules are always strict).
const RESERVED_WORDS = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"implements",
	"interface",
	"let",
	"package",
	"private",
	"protected",
	"public",
	"static",
	"yield",
	"await",
	"eval",
	"arguments",
]);

/** True when `name` is a usable binding identifier (valid shape, not reserved). */
export function isValidIdentifier(name: string): boolean {
	return IDENTIFIER_RE.test(name) && !RESERVED_WORDS.has(name);
}

/** Throws when `name` is not a usable binding identifier. `label` names the field for the message. */
export function assertValidIdentifier(name: string, label = "name"): void {
	if (!isValidIdentifier(name)) {
		throw new Error(
			`Invalid ${label}: '${name}' is not a usable identifier (reserved words and non-identifier text are rejected).`,
		);
	}
}
