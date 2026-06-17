import * as path from "node:path";
import {
	type ImportDeclaration,
	Node,
	type Project,
	type SourceFile,
} from "ts-morph";
import logger from "../../utils/logger";
import {
	collectPackageExportWarnings,
	type PackageExportWarning,
} from "./package-export-warnings";

export interface UnusedExport {
	/** Absolute path of the file that declares the export */
	filePath: string;
	/** 1-based line number of the identifier */
	line: number;
	/** 1-based column number of the identifier */
	column: number;
	/** Export name (for `export default` this is the original identifier name; anonymous cases like `export default 42` are excluded) */
	name: string;
	/** SyntaxKind name of the declaration node (FunctionDeclaration / ClassDeclaration / VariableDeclaration / EnumDeclaration / InterfaceDeclaration / TypeAliasDeclaration / ExportAssignment) */
	kind: string;
	/** Whether this is a `export default` (including `export = x`) */
	isDefaultExport: boolean;
	/**
	 * Number of text occurrences of the same identifier (**declaration file excluded**, `\bname\b` word-boundary match, synthetic imports excluded).
	 * - 0: The name does not appear anywhere outside the declaration file. However, same-file usage is tracked separately
	 *   in `sameFileReferenceCount` (this field alone is not enough to conclude "safe to delete the whole declaration").
	 * - 1+: The name may be referenced via JSX names / string literals / dynamic references (`import().then`) etc.
	 *   Confirm with `find_references_by_tsmorph`. Short names (`a`, `id`, etc.) are prone to coincidental matches.
	 */
	textOccurrences: number;
	/**
	 * Number of references to the export within the same file as the declaration (excluding the declaration identifier itself and re-export sites like `export { x }`).
	 *
	 * This export is by definition unreferenced outside its declaring file, so the safe deletion action is determined by this value:
	 * - `0`: Not used within the same file either = **truly dead**. Safe to delete the whole declaration
	 *   (also check `textOccurrences === 0` for highest confidence).
	 * - `1+`: Used within the same file = **over-exported**. The declaration is still live, so only
	 *   remove the `export` keyword (deleting the whole declaration would break the in-file references).
	 */
	sameFileReferenceCount: number;
}

export interface FindUnusedExportsOptions {
	/** Files at these absolute paths are treated as "public API" and their exports are not reported */
	entryPoints?: string[];
	/** Files whose filePath contains any of these substrings are excluded from scanning */
	excludeFilePatterns?: string[];
	/** Maximum number of results (default 100). Scanning stops when this limit is reached and `truncated=true` is returned */
	maxResults?: number;
	/**
	 * Inject synthetic named imports into files that consume `import * as ns from "./mod"`.
	 * Default true. Makes exports consumed only via namespace references register as "used", reducing false positives.
	 * Injected files are not saved, but the Project instance is mutated, so pass false if you reuse
	 * the same Project instance for other purposes after this call.
	 */
	expandNamespaceImports?: boolean;
}

export interface FindUnusedExportsResult {
	unusedExports: UnusedExport[];
	/** Whether scanning was stopped because maxResults was reached */
	truncated: boolean;
	/** Number of files actually scanned (after exclusions) */
	scannedFiles: number;
	/**
	 * Structural warnings about systematic false positives from packages that publish built dist.
	 * When a package's package.json entry points (`exports` etc.) point outside the scanned sources,
	 * cross-package imports of that package's symbols are invisible to this analysis.
	 * See {@link collectPackageExportWarnings} for details.
	 */
	packageWarnings: PackageExportWarning[];
}

const DEFAULT_MAX_RESULTS = 100;

interface ExportCandidate {
	name: string;
	identifier: Node;
	declarationKind: string;
	isDefaultExport: boolean;
}

/**
 * Scans the entire project and lists exports that have no references outside their declaring file.
 *
 * ## What is detected
 * - Inline exports: `export function/class/const/let/var/enum/interface/type`
 * - `export default <Identifier>` and `export default function/class`
 * - `export = <Identifier>` (CommonJS)
 *
 * ## Criteria for "unused"
 * From the `findReferencesAsNodes()` results for an identifier, the following are excluded before deciding "0 references = unused":
 * - References in the same file (internal usage is not counted)
 * - References under an `ExportDeclaration` (pure re-exports like `export { x } from "./y"`)
 * - References inside `node_modules`
 *
 * ## Namespace import expansion (default ON)
 * Patterns like `import * as ns from "./mod"` + `{ ...ns }` / `ns` escaping do not generate
 * per-identifier reference nodes, so exports that are actually used can be mis-classified as unused.
 * To mitigate this, at analysis start a synthetic
 * `import { a as __synthetic__, b as __synthetic__ } from "./mod"` is injected into namespace-consuming
 * files to force references for all named exports (`expandNamespaceImports: false` to disable).
 *
 * ## Known limitations
 * Due to the nature of static analysis, the following cannot be detected or may produce false positives:
 * - Exports called via dynamic `require` / `import()` from runtime strings
 * - Implicit references by file-based routing conventions (Next.js `page.tsx`, etc.)
 * - Exports referenced as strings in tests / build / config files
 * - Pure local re-exports (`export { x }` where `x` is declared as `const x` elsewhere in the same file)
 *   are treated as `ExportDeclaration` by the current implementation and excluded from candidates
 * - When a workspace package publishes built dist via `exports` (e.g. `exports: { ".": "./dist/index.js" }`),
 *   references from other packages resolve to the built output (or node_modules), not the scanned sources,
 *   causing all exports of that package to appear unused (systematic false positive). This shape is
 *   structurally detected and returned as `packageWarnings`
 *
 * Since perfect detection is not possible, use `entryPoints` to exclude public API and
 * `excludeFilePatterns` to exclude test / convention files to narrow the candidates.
 */
export function findUnusedExports(
	project: Project,
	options: FindUnusedExportsOptions = {},
): FindUnusedExportsResult {
	const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
	if (!Number.isInteger(maxResults) || maxResults < 1) {
		throw new Error(
			`maxResults must be an integer of 1 or greater (received: ${maxResults})`,
		);
	}

	const entryPointSet = new Set(
		(options.entryPoints ?? []).map((p) => path.resolve(p)),
	);
	const excludePatterns = options.excludeFilePatterns ?? [];

	const cleanup =
		(options.expandNamespaceImports ?? true)
			? expandNamespaceImports(project)
			: () => {};

	try {
		const sourceFiles = project.getSourceFiles().filter((sf) => {
			if (sf.isInNodeModules()) return false;
			if (sf.isDeclarationFile()) return false;
			const fp = sf.getFilePath();
			if (entryPointSet.has(fp)) return false;
			if (excludePatterns.some((p) => fp.includes(p))) return false;
			return true;
		});

		const unusedExports: UnusedExport[] = [];
		let truncated = false;

		outer: for (const sourceFile of sourceFiles) {
			for (const candidate of collectExportCandidates(sourceFile)) {
				const usage = analyzeExportUsage(candidate.identifier, sourceFile);
				if (!usage || !usage.externallyUnused) continue;

				const startPos = candidate.identifier.getStart();
				const { line, column } = sourceFile.getLineAndColumnAtPos(startPos);
				unusedExports.push({
					filePath: sourceFile.getFilePath(),
					line,
					column,
					name: candidate.name,
					kind: candidate.declarationKind,
					isDefaultExport: candidate.isDefaultExport,
					textOccurrences: countTextOccurrences(
						candidate.name,
						sourceFile,
						project,
					),
					sameFileReferenceCount: usage.sameFileReferenceCount,
				});

				if (unusedExports.length >= maxResults) {
					truncated = true;
					break outer;
				}
			}
		}

		return {
			unusedExports,
			truncated,
			scannedFiles: sourceFiles.length,
			packageWarnings: collectPackageExportWarnings(
				project,
				sourceFiles.map((sf) => sf.getFilePath()),
				unusedExports.map((e) => e.filePath),
			),
		};
	} finally {
		cleanup();
	}
}

function collectExportCandidates(sf: SourceFile): ExportCandidate[] {
	const result: ExportCandidate[] = [];

	for (const stmt of sf.getStatements()) {
		if (Node.isFunctionDeclaration(stmt) && stmt.isExported()) {
			const nameNode = stmt.getNameNode();
			if (nameNode) {
				result.push({
					name: nameNode.getText(),
					identifier: nameNode,
					declarationKind: "FunctionDeclaration",
					isDefaultExport: stmt.hasDefaultKeyword(),
				});
			}
			continue;
		}

		if (Node.isClassDeclaration(stmt) && stmt.isExported()) {
			const nameNode = stmt.getNameNode();
			if (nameNode) {
				result.push({
					name: nameNode.getText(),
					identifier: nameNode,
					declarationKind: "ClassDeclaration",
					isDefaultExport: stmt.hasDefaultKeyword(),
				});
			}
			continue;
		}

		if (Node.isVariableStatement(stmt) && stmt.isExported()) {
			for (const decl of stmt.getDeclarations()) {
				const nameNode = decl.getNameNode();
				// Destructuring patterns are excluded (BindingPattern → individual Identifier could be handled recursively, but excluded in this MVP)
				if (Node.isIdentifier(nameNode)) {
					result.push({
						name: nameNode.getText(),
						identifier: nameNode,
						declarationKind: "VariableDeclaration",
						isDefaultExport: false,
					});
				}
			}
			continue;
		}

		if (Node.isEnumDeclaration(stmt) && stmt.isExported()) {
			const nameNode = stmt.getNameNode();
			result.push({
				name: nameNode.getText(),
				identifier: nameNode,
				declarationKind: "EnumDeclaration",
				isDefaultExport: false,
			});
			continue;
		}

		if (Node.isInterfaceDeclaration(stmt) && stmt.isExported()) {
			const nameNode = stmt.getNameNode();
			result.push({
				name: nameNode.getText(),
				identifier: nameNode,
				declarationKind: "InterfaceDeclaration",
				isDefaultExport: false,
			});
			continue;
		}

		if (Node.isTypeAliasDeclaration(stmt) && stmt.isExported()) {
			const nameNode = stmt.getNameNode();
			result.push({
				name: nameNode.getText(),
				identifier: nameNode,
				declarationKind: "TypeAliasDeclaration",
				isDefaultExport: false,
			});
			continue;
		}

		if (Node.isExportAssignment(stmt)) {
			// Only target identifiers in `export default <expr>` / `export = <expr>` that can be referenced
			const expr = stmt.getExpression();
			if (Node.isIdentifier(expr)) {
				result.push({
					name: expr.getText(),
					identifier: expr,
					declarationKind: "ExportAssignment",
					isDefaultExport: !stmt.isExportEquals(),
				});
			}
		}
	}

	return result;
}

interface ExportUsage {
	/** Whether the export has no references outside the declaring file (i.e. externally unused) */
	externallyUnused: boolean;
	/** Number of references within the same file as the declaration (excluding the declaration identifier itself and re-export sites) */
	sameFileReferenceCount: number;
}

/**
 * Analyzes the references of an identifier and returns the "externally unused" verdict and same-file reference count.
 *
 * Common exclusion rules (applied to both external and same-file references):
 * - References inside `node_modules` are ignored.
 * - Re-export sites (`export { x } from "./y"` or same-file `export { x }`) are not
 *   considered actual usage and are ignored.
 *
 * Then:
 * - If at least one reference outside the declaring file remains after exclusions, `externallyUnused = false`.
 * - References within the declaring file (excluding the declaration identifier node itself) are counted in `sameFileReferenceCount`.
 *
 * Returns `null` when findReferences cannot / fails for the node (`export = <arbitrary expr>` etc., TypeChecker
 * resolution failure), treating it as indeterminate and excluding it from candidates (logged as possible false negative).
 */
function analyzeExportUsage(
	identifier: Node,
	declSourceFile: SourceFile,
): ExportUsage | null {
	const findable = identifier as Node & {
		findReferencesAsNodes?: () => Node[];
	};
	if (typeof findable.findReferencesAsNodes !== "function") {
		return null;
	}

	let refs: Node[];
	try {
		refs = findable.findReferencesAsNodes();
	} catch (error) {
		// TypeChecker resolution failure is treated as indeterminate and the candidate is excluded.
		// Returning "not unused" would hide true positives, so the degradation is logged instead.
		logger.warn(
			{
				err: error,
				name: identifier.getText(),
				filePath: declSourceFile.getFilePath(),
			},
			"findReferencesAsNodes threw an error; excluding candidate from results (possible false negative)",
		);
		return null;
	}

	// findReferencesAsNodes includes the declaration's own identifier node in its results,
	// so we exclude it from the same-file reference count. The position is unique within the file,
	// so we identify it by (file, start).
	const declStart = identifier.getStart();

	let externallyUnused = true;
	let sameFileReferenceCount = 0;
	for (const ref of refs) {
		const refFile = ref.getSourceFile();
		if (refFile.isInNodeModules()) continue;
		if (ref.getFirstAncestor(Node.isExportDeclaration)) continue;
		if (refFile === declSourceFile) {
			if (ref.getStart() === declStart) continue; // the declaration itself
			sameFileReferenceCount++;
			continue;
		}
		externallyUnused = false;
	}
	return { externallyUnused, sameFileReferenceCount };
}

const SYNTHETIC_ALIAS_PREFIX = "__find_unused_exports_ns_ref__";

/**
 * Counts text occurrences of a candidate name in all source files other than the declaring file,
 * using word-boundary matching.
 *
 * Purpose: supplementary information for agents about "name-based reference potential" that
 * findReferences cannot capture (dynamic references, JSX names, string literals, config files, etc.).
 * A count of 0 is a strong signal that the export is dead.
 *
 * - A negative look-ahead `(?! as <SYNTHETIC_ALIAS_PREFIX>)` excludes the `name` part of synthetic imports
 *   like `import { name as __find_unused_exports_ns_ref__name }` injected during namespace expansion.
 * - node_modules, declaration files, and the declaring file itself are excluded from scanning.
 */
// Character class equivalent to TS IdentifierPart. `\b` is ASCII-only, so for Unicode identifiers
// (e.g. a Japanese word like `shuukei`, `λ`) we use lookbehind/lookahead instead.
const TS_IDENT_PART_CLASS = "[\\p{L}\\p{N}_$]";

function countTextOccurrences(
	name: string,
	declSourceFile: SourceFile,
	project: Project,
): number {
	if (name.length === 0) return 0;
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Exclude occurrences of the form `name as __find_unused_exports_ns_ref__N_name` from synthetic imports.
	// `\s+` absorbs whitespace variation (e.g. newlines inserted by ts-morph). The `\d+_` suffix matches
	// the counter-prefixed alias format used by expandNamespaceImports.
	const re = new RegExp(
		`(?<!${TS_IDENT_PART_CLASS})${escaped}(?!${TS_IDENT_PART_CLASS})(?!\\s+as\\s+${SYNTHETIC_ALIAS_PREFIX}\\d+_)`,
		"gu",
	);
	let count = 0;
	for (const sf of project.getSourceFiles()) {
		if (sf === declSourceFile) continue;
		if (sf.isInNodeModules()) continue;
		if (sf.isDeclarationFile()) continue;
		const matches = sf.getFullText().match(re);
		if (matches) count += matches.length;
	}
	return count;
}

/**
 * Injects all named exports of a target module as aliased named imports into files
 * that consume it via `import * as ns from "./mod"`.
 *
 * This causes exports that are only accessed via `{ ...ns }` spread or `ns.X` dynamic access
 * to register as referenced by `findReferencesAsNodes()` (reducing false positives).
 *
 * The injected imports are not referenced elsewhere in the same file, but TS does not error
 * on them for ES module interop reasons (unused import warnings may appear, but no errors).
 * Files are not saved, so the injections are not persisted.
 */
function expandNamespaceImports(project: Project): () => void {
	const addedImports: ImportDeclaration[] = [];
	// To avoid alias collisions: when the same name is synthesized from different modules,
	// a monotonically increasing per-process counter prevents duplicate binding names.
	// The lookahead in textOccurrences allows the counter-prefixed alias format.
	let aliasCounter = 0;

	for (const sourceFile of project.getSourceFiles()) {
		if (sourceFile.isInNodeModules()) continue;
		if (sourceFile.isDeclarationFile()) continue;

		const targets: { moduleSpecifier: string; names: string[] }[] = [];
		// Deduplicate by resolved module source path to avoid generating duplicate synthetic imports
		// when the same module is imported multiple times as `import * as a from "./m"; import * as b from "./m";`
		const seenModuleSources = new Set<SourceFile>();

		for (const importDecl of sourceFile.getImportDeclarations()) {
			const ns = importDecl.getNamespaceImport();
			if (!ns) continue;

			let targetSource: SourceFile | undefined;
			try {
				targetSource = importDecl.getModuleSpecifierSourceFile();
			} catch {
				continue;
			}
			if (!targetSource) continue;
			if (targetSource === sourceFile) continue;
			if (seenModuleSources.has(targetSource)) continue;
			seenModuleSources.add(targetSource);

			const names: string[] = [];
			for (const [name, decls] of targetSource.getExportedDeclarations()) {
				// `default` is rarely accessed via namespace and `import { default as ... }` synthesis
				// is an edge case through ts-morph's Structure API, so skip it.
				if (name === "default") continue;
				// Injecting type-only exports as value imports would make the synthetic ImportSpecifier
				// appear "used" and suppress reporting of truly unused type exports (false negative).
				// Types have no runtime value and cannot appear in `{ ...ns }` spreads, so skip them.
				if (decls.length === 0) continue;
				const allTypeOnly = decls.every(
					(d) =>
						Node.isInterfaceDeclaration(d) || Node.isTypeAliasDeclaration(d),
				);
				if (allTypeOnly) continue;
				names.push(name);
			}
			if (names.length === 0) continue;

			targets.push({
				moduleSpecifier: importDecl.getModuleSpecifierValue(),
				names,
			});
		}

		if (targets.length === 0) continue;

		// Append as new ImportDeclarations at the end of the file to minimize impact on existing code
		for (const target of targets) {
			const decl = sourceFile.addImportDeclaration({
				moduleSpecifier: target.moduleSpecifier,
				namedImports: target.names.map((name) => ({
					name,
					alias: `${SYNTHETIC_ALIAS_PREFIX}${aliasCounter++}_${name}`,
				})),
			});
			addedImports.push(decl);
		}
	}

	return () => {
		for (const decl of addedImports) {
			try {
				if (!decl.wasForgotten()) decl.remove();
			} catch (error) {
				logger.warn(
					{ err: error },
					"Failed to remove synthetic ImportDeclaration (Project is left in a dirty state)",
				);
			}
		}
	};
}
