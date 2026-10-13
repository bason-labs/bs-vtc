/**
 * The engine's MCP server (AD-4): the Lead-facing tools of `ENGINE_MCP_TOOLS`, each validated
 * against its input contract before the engine sees it and against its output contract before it
 * leaves. JSON-RPC 2.0, MCP methods `initialize`, `ping`, `tools/list`, `tools/call`. The official
 * MCP SDK can replace this module once the engine package may declare it (AD-15 rule 2); the wire
 * format is the same.
 */
import {
  CONTRACT_SCHEMAS,
  ENGINE_MCP_TOOLS,
  jsonSchemaFor,
  type ContractName,
  type EngineMcpToolName,
  type HostId,
} from "@vtc/shared";
import { EngineError, type CallContext, type Engine } from "../core/index.js";

/** MCP protocol revision this server speaks (it echoes a client's supported revision). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

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
  | "pause"
  | "resume"
  | "rejectMalformedSubmit"
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** MCP wants an object root; a contract whose root is a union becomes `type: object` + `anyOf`. */
const objectSchema = (name: ContractName): Record<string, unknown> => {
  const schema = jsonSchemaFor(name);
  return schema.type === "object" ? schema : { type: "object", ...schema };
};

export const toolDefinitions = (): Record<string, unknown>[] =>
  ENGINE_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.purpose,
    inputSchema: objectSchema(tool.input),
    outputSchema: objectSchema(tool.output),
  }));

const toolText = (value: unknown): { content: { type: "text"; text: string }[] } => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const toolError = (message: string): Record<string, unknown> => ({
  ...toolText({ error: message }),
  isError: true,
});

type ToolInput<N extends EngineMcpToolName> = Parameters<
  ToolHost[N extends "change_request" ? "changeRequest" : N]
>[0];

const invoke = async (
  host: ToolHost,
  name: EngineMcpToolName,
  input: unknown,
  call: CallContext,
): Promise<unknown> => {
  switch (name) {
    case "start":
      return host.start(input as ToolInput<"start">, call);
    case "next":
      return host.next(input as ToolInput<"next">, call);
    case "submit":
      return host.submit(input as ToolInput<"submit">, call);
    case "status":
      return host.status(input as ToolInput<"status">);
    case "escalations":
      return host.escalations(input as ToolInput<"escalations">);
    case "answer":
      return host.answer(input as ToolInput<"answer">, call);
    case "approve":
      return host.approve(input as ToolInput<"approve">, call);
    case "change_request":
      return host.changeRequest(input as ToolInput<"change_request">);
    case "pause":
      return host.pause(input as ToolInput<"pause">);
    case "resume":
      return host.resume(input as ToolInput<"resume">);
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
): Promise<Record<string, unknown>> => {
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
    return { ...toolText(output), structuredContent: output };
  } catch (error) {
    if (error instanceof EngineError) return toolError(`${error.code}: ${error.message}`);
    return toolError(`internal: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export interface McpSession {
  /** Handles one parsed message; resolves with the response, or `null` for a notification. */
  handle(message: unknown): Promise<JsonRpcResponse | null>;
}

export const createMcpSession = (
  host: ToolHost,
  options: { readonly host: HostId | null; readonly serverVersion: string },
): McpSession => {
  const call: CallContext = { host: options.host };
  return {
    handle: async (message) => {
      if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        const id =
          isRecord(message) && (typeof message.id === "string" || typeof message.id === "number")
            ? message.id
            : null;
        return {
          jsonrpc: "2.0",
          id,
          error: { code: RPC_ERRORS.invalidRequest, message: "invalid JSON-RPC request" },
        };
      }
      const id = (message.id ?? null) as JsonRpcId;
      const notification = !("id" in message);
      const reply = (result: unknown): JsonRpcResponse | null =>
        notification ? null : { jsonrpc: "2.0", id, result };
      const params = isRecord(message.params) ? message.params : {};
      switch (message.method) {
        case "initialize":
          return reply({
            protocolVersion:
              typeof params.protocolVersion === "string"
                ? params.protocolVersion
                : MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "vtc", version: options.serverVersion },
          });
        case "notifications/initialized":
        case "notifications/cancelled":
          return null;
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: toolDefinitions() });
        case "tools/call": {
          if (typeof params.name !== "string") {
            return notification
              ? null
              : {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: RPC_ERRORS.invalidParams,
                    message: "tools/call needs a tool name",
                  },
                };
          }
          return reply(await callTool(host, params.name, params.arguments, call));
        }
        default:
          return notification
            ? null
            : {
                jsonrpc: "2.0",
                id,
                error: {
                  code: RPC_ERRORS.methodNotFound,
                  message: `unknown method ${message.method}`,
                },
              };
      }
    },
  };
};
