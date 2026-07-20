import { SOURCE_EXT_RE } from "./scope.js";

/**
 * In-place text edits of TS/JS sources — the one thing the guard always hard
 * blocks. Text replacement misses imports, re-exports, and same-name
 * collisions; rename_symbol / change_signature / rewrite_pattern exist for
 * exactly this.
 */
const IN_PLACE_SED_RE = /\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*\b|--in-place\b)/;
const IN_PLACE_PERL_RE = /\bperl\s+-[a-zA-Z]*i/;

export function isInPlaceSourceEdit(command: string): boolean {
	return (
		SOURCE_EXT_RE.test(command) &&
		(IN_PLACE_SED_RE.test(command) || IN_PLACE_PERL_RE.test(command))
	);
}
