/**
 * MCP server (AD-4; owner: engine-core team, sub-project 1; tools frozen in
 * `ENGINE_MCP_TOOLS`). The daemon serves MCP on its local socket; `vtc engine --mcp` is a
 * stdio bridge to it (AD-12). A transport: it calls engine core, never the reverse.
 */
export {
  callTool,
  createMcpSession,
  MCP_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  RPC_ERRORS,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  toolDefinitions,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpSession,
  type ToolHost,
} from "./server.js";
export {
  serveEngineSocket,
  SocketPathTooLongError,
  type EngineSocketOptions,
  type EngineSocketServer,
} from "./socket.js";
export { connectEngineClient, EngineConnectError, handshake, runStdioBridge } from "./client.js";
export { createLineReader, type LineReader } from "./lines.js";
