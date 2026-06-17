/**
 * Strictly determines whether a module specifier matches an alias defined in tsconfig paths.
 *
 * - For wildcard aliases (`@/*`): prefix match against the prefix with `*` removed
 * - For non-wildcard aliases (`@app`): exact match only
 *
 * The loose `startsWith(aliasKey.replace("*", ""))` approach would cause an alias
 * defined as `@foo` to incorrectly match `@foobar/baz`, so strict matching is used here.
 */
export function isPathAlias(
	moduleSpecifier: string,
	aliasKeys: readonly string[],
): boolean {
	return aliasKeys.some((alias) => {
		if (moduleSpecifier === alias) {
			return true;
		}
		if (!alias.endsWith("/*")) {
			return false;
		}
		const prefix = alias.slice(0, -1);
		return moduleSpecifier.startsWith(prefix);
	});
}
