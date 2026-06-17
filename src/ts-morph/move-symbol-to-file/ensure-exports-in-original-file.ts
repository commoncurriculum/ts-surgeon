import { Node } from "ts-morph";
import type { DependencyClassification } from "../types";
import logger from "../../utils/logger";

/**
 * For `addExport`-type dependencies in classifiedDependencies,
 * adds the export keyword if the declaration is not yet exported in the original file.
 */
export function ensureExportsInOriginalFile(
	classifiedDependencies: DependencyClassification[],
	originalFilePath: string, // for logger
): void {
	logger.debug("Checking required exports in the original file...");
	for (const dep of classifiedDependencies) {
		if (dep.type !== "addExport") {
			continue;
		}
		if (Node.isExportable(dep.statement)) {
			if (!dep.statement.isExported()) {
				dep.statement.setIsExported(true);
				logger.debug(
					`Added export keyword to ${dep.name} in ${originalFilePath}`,
				);
			} else {
				logger.debug(
					`Export keyword for ${dep.name} already exists in ${originalFilePath}. No change needed.`,
				);
			}
		} else {
			logger.warn(
				`Attempted to add export to a non-exportable node (${dep.statement.getKindName()}) named ${dep.name} in ${originalFilePath}. Skipping.`,
			);
		}
	}
}
