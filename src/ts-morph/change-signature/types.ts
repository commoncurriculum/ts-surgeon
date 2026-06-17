export type ChangeSignatureOperation =
	| {
			kind: "add";
			/** Insertion position (0-based). Defaults to end when omitted. */
			index?: number;
			/** Name of the parameter to add */
			name: string;
			/** Type annotation text for the parameter (e.g. "string", "{ id: number }"). No type annotation when omitted. */
			typeText?: string;
			/** Whether to make the parameter optional (`?`) */
			optional?: boolean;
			/** Default value text (e.g. "0", '"hello"') */
			defaultValue?: string;
			/**
			 * Argument expression text to insert at existing call sites.
			 * - When omitted, uses the default value if present; otherwise inserts nothing at call sites
			 *   (assumes trailing add with optional/default parameter).
			 * - Specify explicitly when existing calls need a new argument.
			 */
			argumentForCallers?: string;
	  }
	| {
			kind: "remove";
			/** Index of the parameter to remove (0-based) */
			index: number;
	  }
	| {
			kind: "reorder";
			/** New order. Example: [2, 0, 1] means newParams[0] = oldParams[2]. Length must match the current parameter count. */
			newOrder: number[];
	  };

export interface ChangeSignatureParams {
	tsconfigPath: string;
	targetFilePath: string;
	position: { line: number; column: number };
	functionName: string;
	changes: ChangeSignatureOperation[];
	dryRun?: boolean;
}

export interface ChangeSignatureResult {
	changedFiles: string[];
}
