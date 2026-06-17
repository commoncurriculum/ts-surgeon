export interface ConvertDefaultExportToNamedParams {
	tsconfigPath: string;
	/** Absolute path of the file whose default export should become a named export. */
	targetFilePath: string;
	/**
	 * Name for the resulting named export.
	 * - REQUIRED when the default export is anonymous (e.g. `export default () => {}`,
	 *   `export default { ... }`, `export default function () {}`).
	 * - OPTIONAL when the default export already has a name; omit it to keep that name.
	 */
	newName?: string;
	/** When true, compute the changes without writing them to disk. */
	dryRun?: boolean;
}

export interface ConvertDefaultExportToNamedResult {
	/** Absolute paths of files that were (or, in dryRun, would be) modified. */
	changedFiles: string[];
	/** The resulting named export identifier. */
	exportName: string;
	/** Number of default-import sites rewritten to named imports. */
	updatedImportSites: number;
	/** Number of re-export sites (`export { default ... } from`) rewritten. */
	updatedReExportSites: number;
}
