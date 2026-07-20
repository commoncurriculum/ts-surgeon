/**
 * Operator-only escape hatch: the guard is bypassed when TS_SURGEON_ALLOW=1 is
 * set in the hook process's own environment (i.e. by the human who launched
 * the agent session). It used to also work as an inline command prefix, but a
 * real transcript (2026-07-19) showed agents cargo-culting the prefix onto
 * every search, so the inline form is now deliberately inert.
 */
export const ALLOW_MARKER = "TS_SURGEON_ALLOW=1";

/** True when a human enabled the escape hatch in the hook's environment. */
export function isOperatorAllowed(env: NodeJS.ProcessEnv = process.env) {
	return env.TS_SURGEON_ALLOW === "1";
}

/**
 * Appended to every block message. Deliberately names no typeable bypass: a
 * real transcript (2026-07-19) showed that advertising the prefix trains
 * agents to cargo-cult it instead of using the tools. Reading the identifier
 * out of specific files stays open (non-recursive greps on named files are
 * always allowed), so a blocked agent is never stuck.
 */
const NO_BYPASS_FOOTER =
	"This guard has no in-session bypass; do not try to work around it. If this exact search is truly required (e.g. the ts-surgeon CLI itself fails in this project), grep the specific files by name — that is always allowed — or ask the user; the operator escape hatch is documented in the ts-surgeon README.";

/**
 * Prepended when a blocked command carries the old inline escape-hatch prefix.
 */
export const INERT_PREFIX_NOTE = `ts-surgeon: the ${ALLOW_MARKER} command prefix is ignored — the escape hatch is operator-only, read from the hook's own environment, which your commands cannot set.`;

/**
 * A cargo-culted TS_SURGEON_ALLOW=1 prefix gets an explicit "that does
 * nothing" preface so the agent stops reaching for it.
 */
export function withInertPrefixNote(command: string, text: string): string {
	return command.includes("TS_SURGEON_ALLOW")
		? `${INERT_PREFIX_NOTE}\n${text}`
		: text;
}

export const EDIT_BLOCK_MESSAGE = `ts-surgeon: this command hand-edits TypeScript/JavaScript sources with text replacement (sed/perl -i).
Text replacement misses imports, re-exports, and same-name collisions. Use the AST-accurate CLI instead:
  npx -y @commoncurriculum/ts-surgeon guide     # when to use which tool
  e.g. call rename_symbol / change_signature for symbol changes, or
  call rewrite_pattern --pattern 'console.log($$$A)' --rewrite 'logger.debug($$$A)'
  for sed-style codemods (all support --dry-run)
${NO_BYPASS_FOOTER}`;

export const DYNAMIC_SEARCH_BLOCK_MESSAGE = `ts-surgeon: this command loops a recursive text search over TS/JS sources with a runtime-computed pattern.
Text search misses aliased imports/re-exports and matches unrelated same-name tokens. Use the AST-aware lookups instead — no need to know the declaring file:
  npx -y @commoncurriculum/ts-surgeon call find_references --symbol-name <name>   # per symbol; tsconfig is auto-discovered
Auditing which exports are unused? One call replaces the whole loop:
  npx -y @commoncurriculum/ts-surgeon call find_unused_exports --tsconfig-path <path/to/tsconfig.json>
${NO_BYPASS_FOOTER}`;
