import * as path from "node:path";

const DEFAULT_EXTENSIONS_TO_REMOVE = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".json",
	".mjs",
	".cjs",
];

/**
 * Calculates the relative path for a module specifier
 * fromPath: absolute path of the referencing file
 * toPath: absolute path of the referenced file
 * @param options.simplifyIndex whether to simplify paths ending with /index (default: true)
 * @param options.removeExtensions list of extensions to remove; true uses the default list, false keeps extensions (default: DEFAULT_EXTENSIONS_TO_REMOVE)
 * @returns POSIX-style relative path (starts with ./ or ../)
 */
export function calculateRelativePath(
	fromPath: string,
	toPath: string,
	options: {
		simplifyIndex?: boolean;
		removeExtensions?: boolean | string[];
	} = {},
): string {
	const defaultOptions = {
		simplifyIndex: true,
		removeExtensions: DEFAULT_EXTENSIONS_TO_REMOVE as string[] | boolean,
	};
	const mergedOptions = { ...defaultOptions, ...options };

	const fromDir = path.dirname(fromPath);
	const relative = path.relative(fromDir, toPath);

	// Convert to POSIX format and ensure it starts with ./
	let formatted = relative.replace(/\\/g, "/");
	if (!formatted.startsWith(".") && !formatted.startsWith("/")) {
		formatted = `./${formatted}`;
	}

	// index simplification
	// runs when simplifyIndex is true and removeExtensions is not false
	if (mergedOptions.simplifyIndex && mergedOptions.removeExtensions !== false) {
		const indexMatch = formatted.match(
			/^(\.\.?(\/\.\.)*)\/index(\.(ts|tsx|js|jsx|json))?$/,
		);
		if (indexMatch) {
			return indexMatch[1] === "." ? "." : indexMatch[1];
		}
	}

	const originalExt = path.extname(formatted);

	// Remove extension if specified
	if (mergedOptions.removeExtensions) {
		const extensionsToRemove =
			mergedOptions.removeExtensions === true
				? DEFAULT_EXTENSIONS_TO_REMOVE
				: (mergedOptions.removeExtensions as string[]);
		if (extensionsToRemove.includes(originalExt)) {
			formatted = formatted.slice(0, -originalExt.length);
		}
	}

	return formatted;
}
