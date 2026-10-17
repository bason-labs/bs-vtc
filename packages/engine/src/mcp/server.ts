/**
 * The engine's MCP server (AD-4), on the pinned official TypeScript SDK
 * (`@modelcontextprotocol/sdk`, spine §5 reading 24): the Lead-facing tools of
 * `ENGINE_MCP_TOOLS`, each validated against its input contract before the engine sees it and
 * against its output contract before it leaves. The SDK owns JSON-RPC, `initialize` (protocol
 * version negotiation), `ping` and the method table; this module only registers `tools/list` and
 * `tools/call`. Transports are the socket's line framing (`socket.ts`) or any SDK transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CONTRACT_SCHEMAS,
  ENGINE_MCP_TOOLS,
  jsonSchemaFor,
  ROLE_MCP_TOOLS,
  type ContractName,
  type EngineMcpToolName,
  type RoleMcpToolName,
} from "@vtc/shared";
import { EngineError, type CallContext, type Engine, type RoleToolHandler } from "../core/index.js";

/** The newest MCP protocol revision this server speaks (the SDK's). */
export const MCP_PROTOCOL_VERSION: string = LATEST_PROTOCOL_VERSION;

/** Protocol versions this server negotiates (newest first), from the SDK. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;

/** The engine surface the tools call (the `Engine` class implements it). */
export type ToolHost = Pick<
  Engine,
  | "start"
  | "next"
  | "submit"
  | "status"
  | "escalations"
  | "answer"
  | "approve"
  | "changeRequest"
  | "consult"
  | "cancel"
  | "pause"
  | "resume"
  | "rejectMalformedSubmit"
> & {
  /** A connection closed: its session can no longer be the Lead's (see `CallContext.session`). */
  sessionClosed?(session: string): void;
  /**
   * The role-facing research tools (`ROLE_MCP_TOOLS`, AD-4 rule 3, AD-22), served on the same
   * server next to the Lead's when the engine has a handler for them (the daemon wires the
   * research module's); absent: they are not listed.
   */
  roleTools?(): RoleToolHandler | null;
};

export type { RoleToolHandler };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** MCP wants an object root; a contract whose root is a union becomes `type: object` + `anyOf`. */
const objectSchema = (name: ContractName): Record<string, unknown> => {
  const schema = jsonSchemaFor(name);
  return schema.type === "object" ? schema : { type: "object", ...schema };
};

export interface ToolDefinition {
  readonly name: EngineMcpToolName | RoleMcpToolName;
  readonly description: string;
  readonly inputSchema: { type: "object" } & Record<string, unknown>;
  readonly outputSchema: { type: "object" } & Record<string, unknown>;
}

/** The tools `tools/list` names: the Lead's, and the role-facing ones when `roles` is set. */
export const toolDefinitions = (roles = false): ToolDefinition[] =>
  [...ENGINE_MCP_TOOLS, ...(roles ? ROLE_MCP_TOOLS : [])].map((tool) => ({
    name: tool.name,
    description: tool.purpose,
    inputSchema: objectSchema(tool.input) as ToolDefinition["inputSchema"],
    outputSchema: objectSchema(tool.output) as ToolDefinition["outputSchema"],
  }));

const toolText = (value: unknown): { content: { type: "text"; text: string }[] } => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const toolError = (message: string): CallToolResult => ({
  ...toolText({ error: message }),
  isError: true,
});

const invoke = async (
  host: ToolHost,
  name: EngineMcpToolName,
  input: unknown,
  call: CallContext,
): Promise<unknown> => {
  switch (name) {
    case "start":
      return host.start(input as Parameters<ToolHost["start"]>[0], call);
    case "next":
      return host.next(input as Parameters<ToolHost["next"]>[0], call);
    case "submit":
      return host.submit(input as Parameters<ToolHost["submit"]>[0], call);
    case "status":
      return host.status(input as Parameters<ToolHost["status"]>[0]);
    case "escalations":
      return host.escalations(input as Parameters<ToolHost["escalations"]>[0]);
    case "answer":
      return host.answer(input as Parameters<ToolHost["answer"]>[0], call);
    case "approve":
      return host.approve(input as Parameters<ToolHost["approve"]>[0], call);
    case "change_request":
      return host.changeRequest(input as Parameters<ToolHost["changeRequest"]>[0], call);
    case "consult":
      return host.consult(input as Parameters<ToolHost["consult"]>[0], call);
    case "cancel":
      return host.cancel(input as Parameters<ToolHost["cancel"]>[0], call);
    case "pause":
      return host.pause(input as Parameters<ToolHost["pause"]>[0]);
    case "resume":
      return host.resume(input as Parameters<ToolHost["resume"]>[0], call);
  }
};

const issuesOf = (error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string[] =>
  error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);

/** One tool call: input contract, engine, output contract (AD-4, AD-3 rule 2). */
export const callTool = async (
  host: ToolHost,
  name: string,
  args: unknown,
  call: CallContext,
): Promise<CallToolResult> => {
  const roleTool = ROLE_MCP_TOOLS.find((t) => t.name === name);
  const handler = host.roleTools?.() ?? null;
  if (roleTool !== undefined && handler !== null) {
    const input = CONTRACT_SCHEMAS[roleTool.input].safeParse(args ?? {});
    if (!input.success)
      return toolError(`invalid ${roleTool.input}: ${issuesOf(input.error).join("; ")}`);
    try {
      const output = await handler(roleTool.name, input.data, call);
      const checked = CONTRACT_SCHEMAS[roleTool.output].safeParse(output);
      if (!checked.success)
        return toolError(
          `internal: ${roleTool.output} did not validate: ${issuesOf(checked.error).join("; ")}`,
        );
      return { ...toolText(output), structuredContent: output as Record<string, unknown> };
    } catch (error) {
      if (error instanceof EngineError) return toolError(`${error.code}: ${error.message}`);
      return toolError(`internal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const tool = ENGINE_MCP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) return toolError(`unknown tool ${name}`);
  const parsed = CONTRACT_SCHEMAS[tool.input].safeParse(args ?? {});
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    if (tool.name === "submit" && isRecord(args) && typeof args.action_id === "string") {
      const rejected = await host.rejectMalformedSubmit(
        typeof args.run === "string" ? args.run : undefined,
        args.action_id,
        issues,
        call,
      );
      if (rejected !== null) return { ...toolText(rejected), structuredContent: rejected };
    }
    return toolError(`invalid ${tool.input}: ${issues.join("; ")}`);
  }
  try {
    const output = await invoke(host, tool.name, parsed.data, call);
    const checked = CONTRACT_SCHEMAS[tool.output].safeParse(output);
    if (!checked.success)
      return toolError(
        `internal: ${tool.output} did not validate: ${issuesOf(checked.error).join("; ")}`,
      );
    return { ...toolText(output), structuredContent: output as Record<string, unknown> };
  } catch (error) {
    if (error instanceof EngineError) return toolError(`${error.code}: ${error.message}`);
    return toolError(`internal: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * One MCP server per connection (the SDK binds a server to one transport). `call` says who is
 * calling: the bridge's host and the connection's session id (AD-12 rule 3). The tools' schemas
 * are the frozen JSON Schemas of `@vtc/shared` (`jsonSchemaFor`), so `tools/list` and
 * `tools/call` are registered on the SDK server's request handlers directly rather than through
 * `registerTool`, which would derive its own schemas.
 */
export const createMcpServer = (
  host: ToolHost,
  options: { readonly call: CallContext; readonly serverVersion: string },
): McpServer => {
  const mcp = new McpServer(
    { name: "vtc", version: options.serverVersion },
    { capabilities: { tools: { listChanged: false } } },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolDefinitions((host.roleTools?.() ?? null) !== null),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, (request) =>
    callTool(host, request.params.name, request.params.arguments, options.call),
  );
  return mcp;
};
