export interface AddMissingImportsParams {
	tsconfigPath: string;
	/**
	 * Absolute paths of files to fix. When omitted (or empty), every
	 * non-declaration source file in the project is processed.
	 */
	filePaths?: string[];
	/** When true, compute the changes without writing them to disk. */
	dryRun?: boolean;
}

export interface AddMissingImportsResult {
	/** Absolute paths of files that were (or, in dryRun, would be) modified. */
	changedFiles: string[];
	/** Number of files examined. */
	processedFileCount: number;
}
