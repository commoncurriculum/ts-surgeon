import { type Statement, Node, type Identifier } from "ts-morph";
import type { DependencyClassification } from "../types";
import logger from "../../utils/logger";
import { getDeclarationIdentifier } from "./get-declaration-identifier";

/**
 * Searches for references to the specified Identifier node and checks whether it is
 * referenced outside of targetDeclaration (but within the same source file).
 *
 * @param targetDeclaration The declaration of the move target, used as the reference context.
 * @param dependencyIdentifier The Identifier of the dependency whose references to search.
 * @returns true if referenced from outside, false otherwise.
 */
function checkIfReferencedOutsideTarget(
	targetDeclaration: Statement,
	dependencyIdentifier: Identifier,
): boolean {
	const sourceFile = targetDeclaration.getSourceFile();
	const references =
		dependencyIdentifier.findReferencesAsNodes() as Identifier[];
	for (const refNode of references) {
		if (refNode.getSourceFile() !== sourceFile) continue;

		const isInsideTarget = refNode.getAncestors().includes(targetDeclaration);
		if (!isInsideTarget) {
			return true;
		}
	}
	return false;
}

/**
 * Classifies the internal symbols (internalDependencies) that the move-target symbol (targetDeclaration) depends on.
 *
 * @param targetDeclaration The declaration statement of the move-target symbol
 * @param internalDependencies Array of statements for internal symbols that targetDeclaration depends on
 * @returns Array of classification results
 */
export function classifyDependencies(
	targetDeclaration: Statement,
	internalDependencies: Statement[],
): DependencyClassification[] {
	const sourceFile = targetDeclaration.getSourceFile();
	const classifications: DependencyClassification[] = [];

	for (const dep of internalDependencies) {
		const nameNode = getDeclarationIdentifier(dep);
		const depName = nameNode?.getText();

		if (!nameNode || !depName) {
			logger.warn(
				`Could not find identifier node or name for dependency: ${dep.getKindName()} starting with '${dep.getText().substring(0, 20)}...'. This dependency will be ignored and left in the original file.`,
			);
			continue;
		}

		const isExported = Node.isExportable(dep) && dep.isExported();

		if (isExported) {
			classifications.push({
				type: "importFromOriginal",
				statement: dep,
				name: depName,
			});
			logger.debug(
				`Classified ${depName} as importFromOriginal (already exported)`,
			);
			continue;
		}

		const isReferencedOutside = checkIfReferencedOutsideTarget(
			targetDeclaration,
			nameNode,
		);

		if (isReferencedOutside) {
			if (Node.isExportable(dep)) {
				classifications.push({
					type: "addExport",
					statement: dep,
					name: depName,
				});
				logger.debug(
					`Classified ${depName} as addExport (shared, needs export)`,
				);
			} else {
				// When a non-exportable type is referenced from outside (unlikely to occur normally)
				logger.warn(
					`Non-exportable dependency ${depName} (${dep.getKindName()}) seems referenced from outside the target symbol. Classifying as moveToNewFile.`,
				);
				// Emit a warning and fall back to treating it as a move target
				classifications.push({ type: "moveToNewFile", statement: dep });
			}
		} else {
			classifications.push({ type: "moveToNewFile", statement: dep });
			logger.debug(`Classified ${depName} as moveToNewFile (private)`);
		}
	}

	return classifications;
}
