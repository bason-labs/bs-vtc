/**
 * MCP server (AD-4; owner: engine-core team, sub-project 1; tools frozen in
 * `ENGINE_MCP_TOOLS`). The daemon serves MCP on its local socket; `vtc engine --mcp` is a
 * stdio bridge to it (AD-12). A transport: it calls engine core, never the reverse.
 */
export {};
