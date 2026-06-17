import {
	Node,
	type Project,
	type Symbol as TsMorphSymbol,
	type Type,
} from "ts-morph";

export interface Position {
	/** 1-based line number */
	line: number;
	/** 1-based column number */
	column: number;
}

export interface SymbolInfo {
	/** Symbol name */
	name: string;
	/** Node kind of the symbol's first declaration (e.g. VariableDeclaration, FunctionDeclaration) */
	kind: string;
}

export interface DeclarationLocation {
	filePath: string;
	line: number;
	column: number;
}

export interface GetTypeAtPositionResult {
	/** The input position */
	position: Position;
	/** SyntaxKind name of the node at the position */
	nodeKind: string;
	/** Source text of the node at the position (truncated to 80 code points) */
	nodeText: string;
	/** Text representation of the type from TypeChecker (signature form for functions) */
	type: string;
	/** Symbol associated with the node (identifier, declaration, etc.) */
	symbol?: SymbolInfo;
	/** Location of the symbol's first declaration (for aliases, recursively resolved to the original declaration) */
	declaration?: DeclarationLocation;
}

const NODE_TEXT_MAX_LENGTH = 80;
const ALIAS_RESOLUTION_DEPTH_LIMIT = 16;

/**
 * Returns the TypeChecker-inferred type of the expression or identifier at the given position.
 *
 * - Identifier pointing to a function/method declaration → signature built from the declaration text
 *   (e.g. `(name: string) => string`; overloads as `(...) & (...)`)
 * - Variable/property/literal → inferred type text (e.g. `{ id: string }`, `"hello"`)
 * - Whitespace/comment line or non-identifier position → `nodeKind` is SourceFile or
 *   EndOfFileToken, and `type` is whatever TS returns at that position (often
 *   `typeof import("...")`). This is not an error — callers should inspect
 *   `nodeKind` to determine whether the result is meaningful.
 *
 * Much faster than spawning `tsc` each time and more token-efficient,
 * designed for use by Claude to proactively answer "what is the actual type of this variable?".
 */
export function getTypeAtPosition(
	project: Project,
	filePath: string,
	position: Position,
): GetTypeAtPositionResult {
	if (
		!Number.isInteger(position.line) ||
		!Number.isInteger(position.column) ||
		position.line < 1 ||
		position.column < 1
	) {
		throw new Error(
			`Position must be specified as 1-based positive integers (received: line=${position.line}, column=${position.column})`,
		);
	}

	const sourceFile = project.getSourceFile(filePath);
	if (!sourceFile) {
		throw new Error(`File not found: ${filePath}`);
	}

	let offset: number;
	try {
		offset = sourceFile.compilerNode.getPositionOfLineAndCharacter(
			position.line - 1,
			position.column - 1,
		);
	} catch (_error) {
		throw new Error(
			`Specified position (${position.line}:${position.column}) is out of range or invalid for this file`,
		);
	}

	// Note: getDescendantAtPos returns SourceFile / EndOfFileToken even over whitespace,
	// so a "node not found" case practically never occurs. The undefined guard is kept for safety.
	const node = sourceFile.getDescendantAtPos(offset);
	if (!node) {
		throw new Error(
			`Cannot resolve a node from the specified position (${position.line}:${position.column})`,
		);
	}

	const symbol = node.getSymbol();
	const resolvedSymbol = resolveAliasChain(symbol);

	const type = resolvedSymbol
		? resolvedSymbol.getTypeAtLocation(node)
		: node.getType();

	const typeText = formatTypeText(type, node, resolvedSymbol);

	const result: GetTypeAtPositionResult = {
		position,
		nodeKind: node.getKindName(),
		nodeText: truncateByCodePoint(node.getText(), NODE_TEXT_MAX_LENGTH),
		type: typeText,
	};

	if (resolvedSymbol) {
		const declarations = resolvedSymbol.getDeclarations();
		const firstDeclaration = declarations[0];
		result.symbol = {
			name: resolvedSymbol.getName(),
			kind: firstDeclaration?.getKindName() ?? "Unknown",
		};
		if (firstDeclaration) {
			const declSourceFile = firstDeclaration.getSourceFile();
			const declStart = firstDeclaration.getStart();
			const { line, column } = declSourceFile.getLineAndColumnAtPos(declStart);
			result.declaration = {
				filePath: declSourceFile.getFilePath(),
				line,
				column,
			};
		}
	}

	return result;
}

/**
 * Recursively resolves an alias such as `import { x } from './a'` back to the original
 * declaration symbol by following re-export chains including `export * from './b'`.
 */
function resolveAliasChain(
	symbol: TsMorphSymbol | undefined,
): TsMorphSymbol | undefined {
	if (!symbol) return undefined;
	let current = symbol;
	for (let depth = 0; depth < ALIAS_RESOLUTION_DEPTH_LIMIT; depth++) {
		const aliased = current.getAliasedSymbol();
		if (!aliased) return current;
		if (aliased === current) return current;
		current = aliased;
	}
	return current;
}

/**
 * Assembles the text representation of a type.
 *
 * - If all of the symbol's declarations are signature-bearing (FunctionDeclaration /
 *   MethodDeclaration / MethodSignature / ArrowFunction / FunctionExpression /
 *   CallSignature), builds the signature from those declaration texts.
 *   This preserves rest `...` / optional `?` / destructuring parameters intact,
 *   and joins overloads with `&`.
 * - For mixed declarations such as function + namespace merges, returns the raw type
 *   to preserve the property side.
 * - For everything else (variables, type aliases, literals, etc.) returns the raw
 *   TypeChecker text as-is.
 */
function formatTypeText(
	type: Type,
	node: Node,
	symbol: TsMorphSymbol | undefined,
): string {
	const raw = type.getText(node);
	if (!symbol) return raw;
	const declarations = symbol.getDeclarations();
	if (declarations.length === 0) return raw;

	const signatureDecls = declarations.filter(isSignatureBearingDeclaration);
	if (
		signatureDecls.length === 0 ||
		signatureDecls.length !== declarations.length
	) {
		// Mixed (namespace merge, etc.) or no signature-bearing declarations → return raw to preserve members
		return raw;
	}

	// When there are overloads, hide the implementation signature (matches standard TS hover behavior)
	const hasOverload = signatureDecls.some(
		(decl) =>
			(Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) &&
			decl.isOverload(),
	);
	const displayDecls = hasOverload
		? signatureDecls.filter(
				(decl) =>
					!(
						(Node.isFunctionDeclaration(decl) ||
							Node.isMethodDeclaration(decl)) &&
						decl.isImplementation()
					),
			)
		: signatureDecls;

	const sigTexts = displayDecls.map(renderSignatureFromDeclaration);
	return sigTexts.length === 1
		? sigTexts[0]
		: sigTexts.map((s) => `(${s})`).join(" & ");
}

function isSignatureBearingDeclaration(decl: Node): boolean {
	return (
		Node.isFunctionDeclaration(decl) ||
		Node.isMethodDeclaration(decl) ||
		Node.isMethodSignature(decl) ||
		Node.isCallSignatureDeclaration(decl) ||
		Node.isArrowFunction(decl) ||
		Node.isFunctionExpression(decl) ||
		Node.isFunctionTypeNode(decl) ||
		Node.isGetAccessorDeclaration(decl) ||
		Node.isSetAccessorDeclaration(decl) ||
		Node.isConstructSignatureDeclaration(decl)
	);
}

/**
 * Builds a `(params) => returnType` text from a function-like declaration.
 * Parameters and return type are taken verbatim from the original source text,
 * so modifiers such as rest / optional / destructuring / readonly are preserved.
 */
function renderSignatureFromDeclaration(decl: Node): string {
	if (!isSignatureBearingDeclaration(decl)) {
		// Unexpected: should have been filtered by the caller
		return decl.getText();
	}
	const node = decl as Node & {
		getParameters: () => Node[];
		getReturnTypeNode?: () => Node | undefined;
		getReturnType?: () => { getText: (n?: Node) => string };
	};

	const paramTexts = node.getParameters().map((p) => p.getText());
	const returnTypeNode = node.getReturnTypeNode?.();
	const returnTypeText = returnTypeNode
		? returnTypeNode.getText()
		: (node.getReturnType?.().getText(decl) ?? "any");
	return `(${paramTexts.join(", ")}) => ${returnTypeText}`;
}

/**
 * Truncates a string by Unicode code point count.
 * Never splits UTF-16 surrogate pairs (e.g. emoji or supplementary-plane characters) mid-pair.
 */
function truncateByCodePoint(text: string, maxLength: number): string {
	const codePoints = Array.from(text);
	if (codePoints.length <= maxLength) return text;
	return `${codePoints.slice(0, maxLength).join("")}…`;
}
