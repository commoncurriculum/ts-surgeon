/** Friendly names for the supported "fix all in file" TypeScript code fixes. */
export type CodeFixName =
	| "remove_unused"
	| "implement_interface"
	| "implement_abstract_members"
	| "infer_types_from_usage";

export interface ApplyCodeFixParams {
	tsconfigPath: string;
	/** Which code fix to apply across the target files. */
	fix: CodeFixName;
	/**
	 * Absolute paths of files to fix. When omitted (or empty), every
	 * non-declaration source file in the project is processed.
	 */
	filePaths?: string[];
	/** When true, compute the changes without writing them to disk. */
	dryRun?: boolean;
}

export interface ApplyCodeFixResult {
	/** Absolute paths of files that were (or, in dryRun, would be) modified. */
	changedFiles: string[];
	/** Number of files examined. */
	processedFileCount: number;
}
