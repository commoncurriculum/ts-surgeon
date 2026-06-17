import type {
	CallExpression,
	OptionalKind,
	ParameterDeclarationStructure,
	Project,
} from "ts-morph";
import logger from "../../utils/logger";
import {
	getChangedFiles,
	initializeProject,
	saveProjectChanges,
} from "../_utils/ts-morph-project";
import {
	findIdentifierNode,
	validateSymbol,
} from "../rename-symbol/rename-symbol";
import {
	callHasSpreadArgument,
	computeNewArgumentTexts,
	computeNewParameterStructures,
	rewriteCallArguments,
	rewriteParameters,
} from "./apply-changes";
import { filterCallSites } from "./find-call-sites";
import {
	findFunctionLikeDeclaration,
	type FunctionLikeWithParameters,
	getAllRelatedFunctionDeclarations,
} from "./find-function-declaration";
import type {
	ChangeSignatureOperation,
	ChangeSignatureParams,
	ChangeSignatureResult,
} from "./types";

interface CallSitePlan {
	call: CallExpression;
	newArgTexts: string[];
}

/**
 * Changes a function's signature (add/remove/reorder parameters) and
 * synchronously updates all call sites across the project.
 *
 * Initializes a project from tsconfigPath and delegates to `changeSignatureOnProject`.
 * Use `changeSignatureOnProject` directly when you already have an existing Project
 * (e.g. in tests).
 */
export async function changeSignature(
	params: ChangeSignatureParams,
): Promise<ChangeSignatureResult> {
	const project = initializeProject(params.tsconfigPath);
	return changeSignatureOnProject(project, params);
}

/**
 * Internal API that applies a signature change to an existing Project.
 */
export async function changeSignatureOnProject(
	project: Project,
	{
		targetFilePath,
		position,
		functionName,
		changes,
		dryRun = false,
	}: Omit<ChangeSignatureParams, "tsconfigPath">,
): Promise<ChangeSignatureResult> {
	logger.debug(
		{
			targetFilePath,
			position,
			functionName,
			changeCount: changes.length,
			dryRun,
		},
		"changeSignature start",
	);

	if (changes.length === 0) {
		throw new Error("changes array is empty");
	}

	const identifier = findIdentifierNode(project, targetFilePath, position);
	validateSymbol(identifier, functionName);

	const primary = findFunctionLikeDeclaration(identifier);
	const allDeclarations = getAllRelatedFunctionDeclarations(primary);
	logger.debug(
		{ declarationCount: allDeclarations.length },
		"resolved target function declarations",
	);

	// Extract call sites
	const references = identifier.findReferencesAsNodes();
	const callSites = filterCallSites(references);
	logger.debug({ callSiteCount: callSites.length }, "extracted call sites");

	// Detect calls containing SpreadElement — they cannot be rewritten statically.
	// (Only matters when an operation changes arguments.)
	const operationsTouchCallers = changes.some((op) => {
		if (op.kind === "add") return op.argumentForCallers !== undefined;
		return true; // remove / reorder always affects arguments
	});
	if (operationsTouchCallers) {
		const spreadCalls = callSites.filter(callHasSpreadArgument);
		if (spreadCalls.length > 0) {
			const samples = spreadCalls
				.slice(0, 3)
				.map((c) => {
					const sf = c.getSourceFile();
					const { line, column } = sf.getLineAndColumnAtPos(c.getStart());
					return `  - ${sf.getFilePath()}:${line}:${column}`;
				})
				.join("\n");
			throw new Error(
				`spread arguments (...args) found in calls — cannot safely rewrite:\n${samples}`,
			);
		}
	}

	// --- Phase 1: Planning phase (compute new argument and parameter lists without mutation) ---
	// Any exception thrown here is safe because the in-memory project has not been touched yet.
	// Type annotations differ per overload signature, so each declaration is computed individually.
	const declarationPlans = allDeclarations.map((decl) => ({
		decl,
		newParameterStructures: buildNewParameterStructures(decl, changes),
	}));
	const callSitePlans = planCallSiteRewrites(callSites, changes);

	logger.debug(
		{
			declarationCount: declarationPlans.length,
			callSitePlanCount: callSitePlans.length,
		},
		"planning phase complete",
	);

	// --- Phase 2: Apply phase (expected to not throw) ---
	for (const plan of callSitePlans) {
		rewriteCallArguments(plan.call, plan.newArgTexts);
	}
	for (const { decl, newParameterStructures } of declarationPlans) {
		rewriteParameters(decl, newParameterStructures);
	}

	const changedFiles = getChangedFiles(project).map((sf) => sf.getFilePath());
	logger.debug(
		{ changedFileCount: changedFiles.length },
		"apply phase complete",
	);

	if (!dryRun) {
		await saveProjectChanges(project);
		logger.info(
			{ functionName, changedFileCount: changedFiles.length },
			"changeSignature saved",
		);
	}
	return { changedFiles };
}

function buildNewParameterStructures(
	fn: FunctionLikeWithParameters,
	operations: readonly ChangeSignatureOperation[],
): OptionalKind<ParameterDeclarationStructure>[] {
	const currentStructures: OptionalKind<ParameterDeclarationStructure>[] = fn
		.getParameters()
		.map((p) => {
			const structure = p.getStructure();
			return {
				name: typeof structure.name === "string" ? structure.name : p.getName(),
				type: typeof structure.type === "string" ? structure.type : undefined,
				hasQuestionToken: structure.hasQuestionToken,
				initializer:
					typeof structure.initializer === "string"
						? structure.initializer
						: undefined,
				isRestParameter: structure.isRestParameter,
				isReadonly: structure.isReadonly,
				scope: structure.scope,
				decorators: structure.decorators,
			};
		});
	return computeNewParameterStructures(currentStructures, operations);
}

function planCallSiteRewrites(
	callSites: readonly CallExpression[],
	operations: readonly ChangeSignatureOperation[],
): CallSitePlan[] {
	const plans: CallSitePlan[] = [];
	for (const call of callSites) {
		const argTexts = call.getArguments().map((a) => a.getText());
		try {
			const newArgTexts = computeNewArgumentTexts(argTexts, operations);
			plans.push({ call, newArgTexts });
		} catch (error) {
			const sf = call.getSourceFile();
			const { line, column } = sf.getLineAndColumnAtPos(call.getStart());
			const baseMessage =
				error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to apply operation at call site ${sf.getFilePath()}:${line}:${column}: ${baseMessage}`,
			);
		}
	}
	return plans;
}
