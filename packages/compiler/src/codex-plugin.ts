/**
 * The Codex plugin in the portable Agent Plugins 1.0 format (developers.openai.com/plugins/build/
 * plugins; schemas at agent-plugins.org/schemas/1.0.0/): a root `plugin.json` whose `$schema` and
 * `name` are required, skills discovered from the root `skills/`, hooks from `hooks/hooks.json`,
 * and the bundled MCP servers in a root `mcp.json`. The page says the portable format needs a
 * transport `type` on every server, so a Claude Code `.mcp.json` is not just renamed: a local
 * server is `{ "type": "stdio", "command", "args" }` and the file names its own `$schema`.
 */
import { engineMcpServer } from "@vtc/shared";
import { PLUGIN_NAME } from "./hosts.js";

export const AGENT_PLUGINS_SCHEMAS = {
  plugin: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  mcp: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
} as const;

/** The bundled MCP config at the Codex plugin root. */
export const CODEX_MCP_FILE = "mcp.json";

/** The hand-written Codex plugin manifest, relative to the repo root (AD-16 rule 1). */
export const CODEX_PLUGIN_MANIFEST = "plugins/codex/plugin.json";

/** `mcp.json`: the engine bridge `engineMcpServer("codex")` as a stdio server. */
export const codexMcpJson = (): string => {
  const entry = engineMcpServer("codex");
  const config = {
    $schema: AGENT_PLUGINS_SCHEMAS.mcp,
    mcpServers: { [entry.name]: { type: "stdio", command: entry.command, args: entry.args } },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
};

/** Errors in the hand-written portable manifest: valid JSON, its `$schema`, the plugin name. */
export const codexManifestErrors = (text: string): string[] => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text) as unknown;
  } catch {
    return ["not valid JSON"];
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return ["must be a JSON object"];
  }
  const record = manifest as Record<string, unknown>;
  const errors: string[] = [];
  if (record.$schema !== AGENT_PLUGINS_SCHEMAS.plugin) {
    errors.push(`$schema must be ${AGENT_PLUGINS_SCHEMAS.plugin}`);
  }
  if (record.name !== PLUGIN_NAME) errors.push(`name must be the plugin name ${PLUGIN_NAME}`);
  return errors;
};
