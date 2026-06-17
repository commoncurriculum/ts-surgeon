import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTsMorphTools } from "../src/mcp/tools/ts-morph-tools";

export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

type ToolHandler = (args: unknown) => Promise<ToolResult>;

export interface ToolHarness {
	callTool: (name: string, args: unknown) => Promise<ToolResult>;
}

/**
 * Lightweight harness that calls registered MCP tools directly by name,
 * bypassing the real STDIO server. Intercepts the
 * server.tool(name, description, schema, handler) calls made by register*Tool.
 * Uses the same approach as src/mcp/tools/integration.test.ts.
 */
export function createToolHarness(): ToolHarness {
	const tools = new Map<string, ToolHandler>();

	const mockServer = {
		tool: (
			name: string,
			_description: string,
			_schema: unknown,
			handler: ToolHandler,
		) => {
			tools.set(name, handler);
		},
	};

	registerTsMorphTools(mockServer as unknown as McpServer);

	return {
		callTool: async (name, args) => {
			const handler = tools.get(name);
			if (!handler) {
				throw new Error(`[e2e] Tool '${name}' is not registered`);
			}
			return handler(args);
		},
	};
}
