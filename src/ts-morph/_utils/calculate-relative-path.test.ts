import { describe, it, expect } from "vitest";
import { calculateRelativePath } from "./calculate-relative-path.js";

describe("calculateRelativePath", () => {
	it("returns '.' when referencing index.ts in the same directory", () => {
		const fromPath = "/src/components/Button.tsx";
		const toPath = "/src/components/index.ts";
		expect(calculateRelativePath(fromPath, toPath)).toBe(".");
	});

	it("returns '..' when referencing index.ts in the parent directory", () => {
		const fromPath = "/src/components/core/Icon.tsx";
		const toPath = "/src/components/index.ts";
		expect(calculateRelativePath(fromPath, toPath)).toBe("..");
	});

	it("returns '../..' when referencing index.ts two levels up", () => {
		const fromPath = "/src/components/core/primitive/Box.tsx";
		const toPath = "/src/components/index.ts";
		expect(calculateRelativePath(fromPath, toPath)).toBe("../.."); // expected value
	});

	it("returns '../../..' when referencing index.ts three levels up", () => {
		const fromPath = "/src/components/core/primitive/utils/helper.ts";
		const toPath = "/src/components/index.ts";
		expect(calculateRelativePath(fromPath, toPath)).toBe("../../.."); // expected value
	});

	it("returns './filename' when referencing a different file in the same directory", () => {
		const fromPath = "/src/utils/format.ts";
		const toPath = "/src/utils/parse.tsx";
		expect(calculateRelativePath(fromPath, toPath)).toBe("./parse");
	});

	it("returns './subdir/filename' when referencing a file in a subdirectory", () => {
		const fromPath = "/src/hooks/useCounter.ts";
		const toPath = "/src/hooks/internal/state.ts";
		expect(calculateRelativePath(fromPath, toPath)).toBe("./internal/state");
	});

	it("returns '../filename' when referencing a file in the parent directory", () => {
		const fromPath = "/src/components/Button.tsx";
		const toPath = "/src/utils/common.ts";
		expect(calculateRelativePath(fromPath, toPath)).toBe("../utils/common");
	});

	it("removes the extension even when the path contains one", () => {
		const fromPath = "/src/a.ts";
		const toPath = "/src/b.tsx";
		expect(calculateRelativePath(fromPath, toPath)).toBe("./b");
	});

	it("returns '../dir' when referencing a non-index file in a parent directory path", () => {
		const fromPath = "/src/components/core/Icon.tsx";
		const toPath = "/src/hooks/useFetch.ts";
		expect(calculateRelativePath(fromPath, toPath)).toBe(
			"../../hooks/useFetch",
		);
	});

	it("preserves the extension when removeExtensions is false", () => {
		const fromPath = "/src/a.ts";
		const toPath = "/src/b.jsx";
		expect(
			calculateRelativePath(fromPath, toPath, { removeExtensions: false }),
		).toBe("./b.jsx");
	});

	it("does not omit index even with simplifyIndex: true when removeExtensions is false", () => {
		const fromPath = "/src/components/core/Icon.tsx";
		const toPath = "/src/components/index.js"; // with .js extension
		expect(
			calculateRelativePath(fromPath, toPath, {
				removeExtensions: false,
				simplifyIndex: true,
			}),
		).toBe("../index.js");
		expect(
			calculateRelativePath(fromPath, toPath, {
				removeExtensions: false,
				simplifyIndex: false,
			}),
		).toBe("../index.js"); // same result with simplifyIndex: false
	});

	it("removes the extension but does not omit index when removeExtensions is true and simplifyIndex is false", () => {
		const fromPath = "/src/components/core/primitive/utils/helper.ts";
		const toPath = "/src/components/index.ts";
		expect(
			calculateRelativePath(fromPath, toPath, {
				removeExtensions: true,
				simplifyIndex: false,
			}),
		).toBe("../../../index");
	});

	it("removes only the specified extensions when removeExtensions is given a custom array", () => {
		const fromPath = "/src/dir/file.ts";
		const toPathTsx = "/src/dir/other.tsx";
		const toPathJson = "/src/dir/data.json";
		const toPathCss = "/src/dir/styles.css"; // should not be removed

		const options = { removeExtensions: [".ts", ".tsx"] }; // .json is not a removal target

		expect(calculateRelativePath(fromPath, toPathTsx, options)).toBe("./other");
		expect(calculateRelativePath(fromPath, toPathJson, options)).toBe(
			"./data.json",
		); // preserved
		expect(calculateRelativePath(fromPath, toPathCss, options)).toBe(
			"./styles.css",
		); // preserved
	});
});
