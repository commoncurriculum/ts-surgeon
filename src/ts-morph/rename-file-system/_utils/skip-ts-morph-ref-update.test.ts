import { describe, it, expect, vi } from "vitest";
import { createInMemoryProject } from "../../_test-utils/create-in-memory-project";
import { withSkippedTsMorphReferenceUpdates } from "./skip-ts-morph-ref-update";

vi.mock("../../../utils/logger");

describe("withSkippedTsMorphReferenceUpdates", () => {
	it("fn is executed and the prototype is restored after patching in a normal Project", () => {
		const project = createInMemoryProject();
		const sf = project.createSourceFile("/src/a.ts", "export const a = 1;");
		const proto = Object.getPrototypeOf(sf) as Record<string, unknown>;
		const originalGet = proto._getReferencesForMoveInternal;
		const originalUpdate = proto._updateReferencesForMoveInternal;

		const result = withSkippedTsMorphReferenceUpdates(project, () => {
			expect(proto._getReferencesForMoveInternal).not.toBe(originalGet);
			expect(proto._updateReferencesForMoveInternal).not.toBe(originalUpdate);
			return 42;
		});

		expect(result).toBe(42);
		expect(proto._getReferencesForMoveInternal).toBe(originalGet);
		expect(proto._updateReferencesForMoveInternal).toBe(originalUpdate);
	});

	it("prototype is restored even when fn throws", () => {
		const project = createInMemoryProject();
		const sf = project.createSourceFile("/src/a.ts", "export const a = 1;");
		const proto = Object.getPrototypeOf(sf) as Record<string, unknown>;
		const originalGet = proto._getReferencesForMoveInternal;
		const originalUpdate = proto._updateReferencesForMoveInternal;

		expect(() =>
			withSkippedTsMorphReferenceUpdates(project, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");

		expect(proto._getReferencesForMoveInternal).toBe(originalGet);
		expect(proto._updateReferencesForMoveInternal).toBe(originalUpdate);
	});

	it("fn is executed as-is when the Project has no SourceFiles (fallback)", () => {
		const project = createInMemoryProject();
		const result = withSkippedTsMorphReferenceUpdates(project, () => "ok");
		expect(result).toBe("ok");
	});

	it("fn is executed as-is when the private API is not found on the prototype (fallback)", () => {
		const project = createInMemoryProject();
		const sf = project.createSourceFile("/src/a.ts", "export const a = 1;");
		const proto = Object.getPrototypeOf(sf) as Record<string, unknown>;
		const originalGet = proto._getReferencesForMoveInternal;
		const originalUpdate = proto._updateReferencesForMoveInternal;

		// Temporarily replace the private API with a non-function
		proto._getReferencesForMoveInternal = undefined;
		proto._updateReferencesForMoveInternal = undefined;

		try {
			const result = withSkippedTsMorphReferenceUpdates(project, () => "ok");
			expect(result).toBe("ok");
		} finally {
			proto._getReferencesForMoveInternal = originalGet;
			proto._updateReferencesForMoveInternal = originalUpdate;
		}
	});
});
