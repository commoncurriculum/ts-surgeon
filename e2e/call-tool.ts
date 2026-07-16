import {
	type ToolResult as RegistryToolResult,
	createToolRegistry,
} from "../src/tools/registry";

export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

export interface ToolHarness {
	callTool: (name: string, args: unknown) => Promise<ToolResult>;
}

/**
 * Harness that calls the registered ts-morph tools by name through the real
 * tool registry — exactly the path the CLI's `call` command uses (schema
 * validation included).
 */
export function createToolHarness(): ToolHarness {
	const registry = createToolRegistry();
	return {
		callTool: async (name, args): Promise<RegistryToolResult> =>
			registry.call(name, args),
	};
}
