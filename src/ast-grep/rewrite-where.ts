import type { SgNode } from "@ast-grep/napi";
import type { Node, Project, SourceFile, Type } from "ts-morph";
import {
	applyPatternRewrite,
	type PatternRewriteResult,
} from "./pattern-tools";

/**
 * Type-constrained structural rewrite: the rewrite_pattern engine plus a type
 * predicate on one of the pattern's captures. Example: rewrite `$X.close()`
 * -> `shutdown($X)` only where `$X`'s checker type is/extends DbConnection.
 *
 * ast-grep supplies the syntax matches; ts-morph's type checker decides,
 * per match, whether the capture's type satisfies the predicate. Offsets are
 * directly comparable because ast-grep parses the exact string the ts-morph
 * SourceFile holds (and @ast-grep/napi positions are UTF-16 indices, pinned
 * by a non-ASCII test).
 */

export type TypePredicateMode = "is" | "extends" | "assignable";

export interface RewriteWhereParams {
	pattern: string;
	rewrite: string;
	where: {
		capture: string;
		type: string;
		mode?: TypePredicateMode;
		typeDeclarationPath?: string;
	};
	filePaths?: string[];
	dryRun?: boolean;
	fixImports?: boolean;
}

export type RewriteWhereResult = PatternRewriteResult;

/**
 * Names a type can be referred to by: its symbol, its alias symbol, or (for
 * primitives/anonymous types) its printed text. Deliberately NOT
 * type.getText() alone — that renders qualified forms like
 * `import("/abs/path").DbConnection` depending on context.
 */
function matchesTypeName(type: Type, wanted: string): boolean {
	if (type.getSymbol()?.getName() === wanted) {
		return true;
	}
	if (type.getAliasSymbol()?.getName() === wanted) {
		return true;
	}
	return type.getText() === wanted;
}

/** "is or inherits from": the type itself, or anything in its base-type chain. */
function extendsTypeName(type: Type, wanted: string, depth = 0): boolean {
	if (depth > 32) {
		return false;
	}
	if (matchesTypeName(type, wanted)) {
		return true;
	}
	return type
		.getBaseTypes()
		.some((base) => extendsTypeName(base, wanted, depth + 1));
}

/**
 * Resolves the predicate's target type from its declaring file. A bare name
 * is ambiguous across a project (two packages can both declare DbConnection),
 * so assignability checks anchor the type to a declaration.
 */
function resolveTargetType(
	project: Project,
	typeName: string,
	typeDeclarationPath: string,
): Type {
	const sourceFile =
		project.getSourceFile(typeDeclarationPath) ??
		project.addSourceFileAtPath(typeDeclarationPath);
	const declaration =
		sourceFile.getClass(typeName) ??
		sourceFile.getInterface(typeName) ??
		sourceFile.getTypeAlias(typeName) ??
		sourceFile.getEnum(typeName);
	if (!declaration) {
		throw new Error(
			`No class/interface/type-alias/enum named '${typeName}' is declared in ${typeDeclarationPath}.`,
		);
	}
	return declaration.getType();
}

/**
 * Maps an ast-grep capture span onto the ts-morph node with exactly the same
 * span. getDescendantAtPos returns the deepest node at the start position
 * (e.g. the `db` identifier inside `db.close()` — where the property access
 * and call expression share the same start), so ascend until start AND end
 * match. No same-span node -> undefined; the caller skips the match rather
 * than type-checking a nearby-but-different node.
 */
function nodeForSpan(
	sourceFile: SourceFile,
	start: number,
	end: number,
): Node | undefined {
	let node: Node | undefined = sourceFile.getDescendantAtPos(start);
	while (node) {
		if (node.getStart() === start && node.getEnd() === end) {
			return node;
		}
		const parent: Node | undefined = node.getParent();
		if (!parent || parent.getStart() < start || parent.getEnd() > end) {
			return undefined;
		}
		node = parent;
	}
	return undefined;
}

function capturePredicate(
	project: Project,
	where: RewriteWhereParams["where"],
): (sourceFile: SourceFile, match: SgNode) => boolean {
	const mode = where.mode ?? "is";
	let targetType: Type | undefined;
	if (mode === "assignable") {
		if (!where.typeDeclarationPath) {
			throw new Error(
				"where.mode 'assignable' requires where.typeDeclarationPath (the file declaring the target type) so the name resolves unambiguously.",
			);
		}
		targetType = resolveTargetType(
			project,
			where.type,
			where.typeDeclarationPath,
		);
	}
	const checker = project.getTypeChecker().compilerObject;

	return (sourceFile, match) => {
		const captureNode = match.getMatch(where.capture);
		if (!captureNode) {
			throw new Error(
				`The pattern has no capture $${where.capture} — where.capture must name a metavariable used in the pattern (without the $).`,
			);
		}
		const { start, end } = captureNode.range();
		const tsNode = nodeForSpan(sourceFile, start.index, end.index);
		if (!tsNode) {
			return false;
		}
		const nodeType = tsNode.getType();
		switch (mode) {
			case "is":
				// A union (e.g. DbConnection | undefined) is not "DbConnection";
				// use mode 'assignable' for narrowing-style checks.
				return matchesTypeName(nodeType, where.type);
			case "extends":
				return extendsTypeName(nodeType, where.type);
			case "assignable":
				return checker.isTypeAssignableTo(
					nodeType.compilerType,
					(targetType as Type).compilerType,
				);
		}
	};
}

/**
 * Rewrites only the pattern matches whose capture satisfies the type
 * predicate — the shared engine does the matching/editing; this module owns
 * only the predicate.
 */
export async function rewriteWhere(
	project: Project,
	{ where, ...options }: RewriteWhereParams,
): Promise<RewriteWhereResult> {
	return applyPatternRewrite(project, {
		...options,
		shouldRewrite: capturePredicate(project, where),
	});
}
