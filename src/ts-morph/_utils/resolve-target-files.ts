import type { Project, SourceFile } from "ts-morph";

/**
 * Resolves the files a project-wide tool should operate on: the explicit
 * `filePaths` (throwing if any is missing), or — when none are given — every
 * non-declaration source file in the project (excluding node_modules).
 */
export function resolveTargetFiles(
	project: Project,
	filePaths: string[] | undefined,
): SourceFile[] {
	if (filePaths && filePaths.length > 0) {
		return filePaths.map((filePath) => {
			const sourceFile = project.getSourceFile(filePath);
			if (!sourceFile) throw new Error(`File not found: ${filePath}`);
			return sourceFile;
		});
	}
	return project
		.getSourceFiles()
		.filter(
			(sourceFile) =>
				!sourceFile.isDeclarationFile() && !sourceFile.isInNodeModules(),
		);
}
