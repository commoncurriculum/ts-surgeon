import {
	type CallExpression,
	Node,
	type OptionalKind,
	type ParameterDeclarationStructure,
} from "ts-morph";
import type { FunctionLikeWithParameters } from "./find-function-declaration";
import type { ChangeSignatureOperation } from "./types";

/**
 * Applies a sequence of operations to the argument text array of an existing call site,
 * returning the new argument array.
 *
 * - add: if argumentForCallers is specified, inserts it at the given index position.
 *   If the index exceeds the current argument count, the call is missing required arguments — error.
 *   If argumentForCallers is omitted, the call site is left unchanged (trailing add with
 *   optional/defaulted parameter assumed).
 * - remove: if the index is in range, removes that position. If out of range, no-op (omitted optional argument).
 * - reorder: if the argument count does not match the length of newOrder, error.
 */
export function computeNewArgumentTexts(
	currentArgTexts: readonly string[],
	operations: readonly ChangeSignatureOperation[],
): string[] {
	let args = [...currentArgTexts];
	for (const op of operations) {
		if (op.kind === "add") {
			if (op.argumentForCallers === undefined) continue;
			const insertAt = op.index ?? args.length;
			if (insertAt > args.length) {
				throw new Error(
					`add operation: tried to insert at index=${insertAt} but the call only passes ${args.length} argument(s). Some calls omit trailing optional arguments — if the insertion position is not the end, first fill in the missing arguments at those call sites and then retry.`,
				);
			}
			args.splice(insertAt, 0, op.argumentForCallers);
			continue;
		}
		if (op.kind === "remove") {
			if (op.index >= 0 && op.index < args.length) {
				args.splice(op.index, 1);
			}
			continue;
		}
		if (op.kind === "reorder") {
			if (args.length !== op.newOrder.length) {
				throw new Error(
					`Reorder requires call sites to pass all ${op.newOrder.length} arguments, but a call passes ${args.length}.`,
				);
			}
			args = op.newOrder.map((index) => args[index]);
		}
	}
	return args;
}

/**
 * Applies a sequence of operations to the parameter structure array of a function,
 * returning the new structure array.
 *
 * - If argumentForCallers is missing for a mid-list add, it is rejected here because
 *   it would break all call sites.
 * - Arrays that place a rest parameter at a non-last position are invalid in TypeScript
 *   and are rejected.
 */
export function computeNewParameterStructures(
	current: ReadonlyArray<OptionalKind<ParameterDeclarationStructure>>,
	operations: readonly ChangeSignatureOperation[],
): OptionalKind<ParameterDeclarationStructure>[] {
	let params: OptionalKind<ParameterDeclarationStructure>[] = current.map(
		(p) => ({ ...p }),
	);
	for (const op of operations) {
		if (op.kind === "add") {
			const insertAt = op.index ?? params.length;
			if (insertAt < 0 || insertAt > params.length) {
				throw new Error(
					`add operation: index=${insertAt} is out of parameter range [0, ${params.length}]`,
				);
			}
			const isTrailing = insertAt === params.length;
			const isSafelyOmittable =
				op.optional === true || op.defaultValue !== undefined;
			if (op.argumentForCallers === undefined) {
				if (!isTrailing) {
					throw new Error(
						`add operation: argumentForCallers is required when inserting at a mid-list index=${insertAt} (it would break the mapping between existing call-site arguments and the new parameter).`,
					);
				}
				if (!isSafelyOmittable) {
					throw new Error(
						"add operation: when omitting argumentForCallers even for a trailing add, the new parameter must be " +
							"optional or have a defaultValue (otherwise existing call sites would be missing an argument).",
					);
				}
			}
			params.splice(insertAt, 0, {
				name: op.name,
				type: op.typeText,
				hasQuestionToken: op.optional,
				initializer: op.defaultValue,
			});
			continue;
		}
		if (op.kind === "remove") {
			if (op.index < 0 || op.index >= params.length) {
				throw new Error(
					`remove operation: index=${op.index} is out of parameter range [0, ${params.length - 1}]`,
				);
			}
			params.splice(op.index, 1);
			continue;
		}
		if (op.kind === "reorder") {
			if (op.newOrder.length !== params.length) {
				throw new Error(
					`reorder: newOrder length (${op.newOrder.length}) does not match the current parameter count (${params.length})`,
				);
			}
			const seen = new Set<number>();
			for (const i of op.newOrder) {
				if (i < 0 || i >= params.length || seen.has(i)) {
					throw new Error(
						`reorder: newOrder=[${op.newOrder.join(",")}] is invalid (duplicate or out-of-range)`,
					);
				}
				seen.add(i);
			}
			params = op.newOrder.map((i) => params[i]);
		}
	}
	validateRestParameterIsLast(params);
	return params;
}

/**
 * A rest parameter (`...rest`) must be last (TS2369).
 */
export function validateRestParameterIsLast(
	params: ReadonlyArray<OptionalKind<ParameterDeclarationStructure>>,
): void {
	const restIndex = params.findIndex((p) => p.isRestParameter === true);
	if (restIndex !== -1 && restIndex !== params.length - 1) {
		throw new Error(
			`rest parameter (index=${restIndex}, name='${params[restIndex].name}') must be in the last position ` +
				`(current parameter count: ${params.length}).`,
		);
	}
}

/**
 * Replaces all arguments of a call expression with newArgTexts.
 */
export function rewriteCallArguments(
	call: CallExpression,
	newArgTexts: readonly string[],
): void {
	const existingCount = call.getArguments().length;
	for (let i = existingCount - 1; i >= 0; i--) {
		call.removeArgument(i);
	}
	if (newArgTexts.length > 0) {
		call.addArguments([...newArgTexts]);
	}
}

/**
 * Replaces all parameters of a function with newParams.
 */
export function rewriteParameters(
	fn: FunctionLikeWithParameters,
	newParams: ReadonlyArray<OptionalKind<ParameterDeclarationStructure>>,
): void {
	const existing = fn.getParameters();
	for (const p of [...existing].reverse()) {
		p.remove();
	}
	if (newParams.length > 0) {
		fn.addParameters([...newParams]);
	}
}

/**
 * Returns true if a call expression contains a SpreadElement in its arguments.
 * (Calls like `fn(...args)` cannot have their positions changed statically.)
 */
export function callHasSpreadArgument(call: CallExpression): boolean {
	return call.getArguments().some((a) => Node.isSpreadElement(a));
}
