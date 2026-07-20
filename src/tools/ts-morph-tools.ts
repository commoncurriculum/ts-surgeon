import type { ToolRegistry } from "./registry.js";

import { registerAddMissingImportsTool } from "./register-add-missing-imports-tool.js";
import { registerApplyCodeFixTool } from "./register-apply-code-fix-tool.js";
import { registerChangeSignatureTool } from "./register-change-signature-tool.js";
import { registerConvertDefaultExportTool } from "./register-convert-default-export-tool.js";
import { registerConvertNamedToDefaultTool } from "./register-convert-named-to-default-tool.js";
import { registerFindReferencesTool } from "./register-find-references-tool.js";
import { registerFindUnusedExportsTool } from "./register-find-unused-exports-tool.js";
import { registerGetDiagnosticsTool } from "./register-get-diagnostics-tool.js";
import { registerGetTypeAtPositionTool } from "./register-get-type-at-position-tool.js";
import { registerMoveSymbolToFileTool } from "./register-move-symbol-to-file-tool.js";
import { registerOrganizeImportsTool } from "./register-organize-imports-tool.js";
import { registerRemovePathAliasTool } from "./register-remove-path-alias-tool.js";
import { registerRenameFileSystemEntryTool } from "./register-rename-file-system-entry-tool.js";
import { registerRenameSymbolTool } from "./register-rename-symbol-tool.js";
import { registerRewritePatternTool } from "./register-rewrite-pattern-tool.js";
import { registerRewriteWhereTool } from "./register-rewrite-where-tool.js";
import { registerSearchPatternTool } from "./register-search-pattern-tool.js";
import { registerSafeDeleteSymbolTool } from "./register-safe-delete-symbol-tool.js";

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
	registerSearchPatternTool(registry);
	registerRewritePatternTool(registry);
	registerRewriteWhereTool(registry);
}
