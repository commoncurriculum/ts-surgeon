import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tools/registry";
import { isPathKey } from "./paths";

describe("isPathKey", () => {
	it("matches the path-field convention", () => {
		for (const key of [
			"tsconfigPath",
			"targetFilePath",
			"filePaths",
			"oldPath",
			"newPath",
			"targetPath",
			"entryPoints",
		]) {
			expect(isPathKey(key), key).toBe(true);
		}
		for (const key of ["symbolName", "excludeFilePatterns", "position"]) {
			expect(isPathKey(key), key).toBe(false);
		}
	});
});

interface SchemaProp {
	type?: string;
	description?: string;
	items?: SchemaProp;
	properties?: Record<string, SchemaProp>;
}

function isStringy(prop: SchemaProp): boolean {
	return (
		prop.type === "string" ||
		(prop.type === "array" && prop.items?.type === "string")
	);
}

// Fields whose description reads like a filesystem path...
const PATH_DESC_RE =
	/\b(absolute )?(file )?paths? (to|of|for)\b|absolute path/i;
// ...unless they are pattern/substring matchers, not paths.
const NON_PATH_RE = /pattern|substring/i;

/**
 * Drift guard for the path-resolution convention: every schema field that
 * documents itself as a filesystem path must be picked up by isPathKey, or
 * the CLI would silently skip resolving it against the cwd. Fails loudly
 * when a new tool introduces a path field the heuristic misses.
 */
describe("path-resolution drift guard", () => {
	it("every path-described schema field satisfies isPathKey", () => {
		const registry = createToolRegistry();
		const offenders: string[] = [];

		const walk = (
			props: Record<string, SchemaProp> | undefined,
			prefix: string,
		) => {
			for (const [key, prop] of Object.entries(props ?? {})) {
				const description = prop.description ?? "";
				if (
					isStringy(prop) &&
					PATH_DESC_RE.test(description) &&
					!NON_PATH_RE.test(`${key} ${description}`) &&
					!isPathKey(key)
				) {
					offenders.push(`${prefix}${key}: ${description}`);
				}
				walk(prop.items?.properties, `${prefix}${key}[].`);
				walk(prop.properties, `${prefix}${key}.`);
			}
		};

		for (const tool of registry.list()) {
			const schema = registry.inputSchema(tool.name) as {
				properties?: Record<string, SchemaProp>;
			};
			walk(schema.properties, `${tool.name}.`);
		}

		expect(offenders).toEqual([]);
	});
});
