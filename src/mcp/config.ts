import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTsMorphTools } from "./tools/ts-morph-tools";
import { VERSION } from "../version";

/** Creates the MCP server */
export function createMcpServer(): McpServer {
	const server = new McpServer({
		name: "mcp-ts-morph",
		version: VERSION,
		description:
			"A collection of ts-morph-based refactoring tools for more precise agent operations",
	});
	registerTsMorphTools(server);
	return server;
}
