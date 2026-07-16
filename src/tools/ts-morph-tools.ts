import type { ToolRegistry } from "./registry";

import { registerAddMissingImportsTool } from "./register-add-missing-imports-tool";
import { registerApplyCodeFixTool } from "./register-apply-code-fix-tool";
import { registerChangeSignatureTool } from "./register-change-signature-tool";
import { registerConvertDefaultExportTool } from "./register-convert-default-export-tool";
import { registerConvertNamedToDefaultTool } from "./register-convert-named-to-default-tool";
import { registerFindReferencesTool } from "./register-find-references-tool";
import { registerFindUnusedExportsTool } from "./register-find-unused-exports-tool";
import { registerGetDiagnosticsTool } from "./register-get-diagnostics-tool";
import { registerGetTypeAtPositionTool } from "./register-get-type-at-position-tool";
import { registerMoveSymbolToFileTool } from "./register-move-symbol-to-file-tool";
import { registerOrganizeImportsTool } from "./register-organize-imports-tool";
import { registerRemovePathAliasTool } from "./register-remove-path-alias-tool";
import { registerRenameFileSystemEntryTool } from "./register-rename-file-system-entry-tool";
import { registerRenameSymbolTool } from "./register-rename-symbol-tool";
import { registerSafeDeleteSymbolTool } from "./register-safe-delete-symbol-tool";

/**
 * Registers the ts-morph refactoring tool suite with the tool registry
 */
export function registerTsMorphTools(registry: ToolRegistry): void {
	registerRenameSymbolTool(registry);
	registerRenameFileSystemEntryTool(registry);
	registerFindReferencesTool(registry);
	registerRemovePathAliasTool(registry);
	registerMoveSymbolToFileTool(registry);
	registerChangeSignatureTool(registry);
	registerGetTypeAtPositionTool(registry);
	registerFindUnusedExportsTool(registry);
	registerConvertDefaultExportTool(registry);
	registerOrganizeImportsTool(registry);
	registerGetDiagnosticsTool(registry);
	registerConvertNamedToDefaultTool(registry);
	registerAddMissingImportsTool(registry);
	registerApplyCodeFixTool(registry);
	registerSafeDeleteSymbolTool(registry);
}
