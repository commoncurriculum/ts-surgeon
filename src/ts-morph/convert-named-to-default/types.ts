export interface ConvertNamedExportToDefaultParams {
	tsconfigPath: string;
	/** Absolute path of the file whose named export should become the default export. */
	targetFilePath: string;
	/** The named export to convert into the file's default export. */
	exportName: string;
	/** When true, compute the changes without writing them to disk. */
	dryRun?: boolean;
}

export interface ConvertNamedExportToDefaultResult {
	/** Absolute paths of files that were (or, in dryRun, would be) modified. */
	changedFiles: string[];
	/** Number of named-import sites rewritten to default imports. */
	updatedImportSites: number;
	/** Number of re-export sites (`export { name } from`) rewritten. */
	updatedReExportSites: number;
}
