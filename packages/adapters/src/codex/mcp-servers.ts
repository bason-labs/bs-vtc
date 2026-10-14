/**
 * Keeping MCP servers other than the engine bridge out of Codex role runs (D-cf, AD-25 rule 1;
 * the §7 H-3 row "Host web search in role runs", and the spike row "Codex project config in a
 * linked worktree"). An MCP server runs outside the role sandbox, with the network, so a fetch or
 * browser server would hand a role that can read the user's credentials (D-ad) a way to send
 * them anywhere. Claude Code runs drop them with `--strict-mcp-config`; `codex exec` 0.162.1 has
 * no such flag, `--ignore-user-config` would drop the rest of the user's config with them (the
 * model, the provider, the login store), and a server can only be turned off by its name. So
 * before every headless start or resume the adapter asks Codex itself which servers the run would
 * load: `codex mcp list --json` with the run's own `--config` overrides, in the role's cwd, so it
 * resolves the user's `config.toml`, a trusted project's `.codex/config.toml` (a linked worktree
 * inside a trusted repo counts as trusted, and loads its own) and the plugins exactly as the run
 * will. Every server but the bridge is then turned off in the command, and a second listing with
 * the final overrides must show none of them left on; otherwise the run is refused (fail closed).
 *
 * What codex-cli 0.162.1 does (offline, a temporary `CODEX_HOME`, `scripts/dcl-check.ts
 * codex-mcp`, recorded as `test/fixtures/codex/mcp-isolation.json`):
 * - a `-c` dotted key splits on every `.`, quoted or not, so `mcp_servers."a.b".enabled=false`
 *   fails to load ("invalid transport"); an inline table value takes any name as a TOML string
 *   key: `-c 'mcp_servers={"a.b"={enabled=false}}'`, which merges into the configured servers;
 * - overrides apply in order, and a whole-table `mcp_servers=` replaces what earlier overrides
 *   set under it, so the table goes first and the bridge's dotted keys after it (the command
 *   builder refuses a profile that sets the whole table);
 * - turning off a name with no configured entry fails to load, and a plugin's own MCP servers
 *   (from its `.mcp.json`) have none, so role runs turn plugins off (`features.plugins=false`,
 *   `CODEX_ROLE_FEATURES_OFF`), which drops them; role runs load no plugin otherwise.
 *
 * `codex mcp list --json` prints each server's `env` and `http_headers` values, which can hold the
 * user's tokens. Only each entry's `name` and `enabled` are read; the output is never logged,
 * kept or quoted in an error.
 */
import type { HostCommand } from "@vtc/shared";
import { createCommandOutputRunner } from "../common/command-output.js";
import type { Spawner } from "../common/process.js";

const CODEX_BINARY = "codex";

/** One server as `codex mcp list --json` reports it, reduced to what the check needs. */
export interface CodexMcpServer {
  readonly name: string;
  readonly enabled: boolean;
}

/** `codex mcp list --json` with the run's `--config` overrides (pairs of flag and value). */
export const codexMcpListCommand = (configArgs: readonly string[]): HostCommand => ({
  command: CODEX_BINARY,
  args: ["mcp", "list", "--json", ...configArgs],
  env: {},
});

/** The `--config` / `-c` pairs of an argv, in order (flag and value each). */
export const codexConfigArgs = (args: readonly string[]): string[] =>
  args.flatMap((arg, i) => {
    const value = args[i + 1];
    return (arg === "--config" || arg === "-c") && value !== undefined ? [arg, value] : [];
  });

/**
 * Pure: each server's name and enabled flag, or `null` unless the output is exactly a JSON array
 * of entries that each carry a non-empty string `name` and a boolean `enabled`.
 */
export const parseCodexMcpList = (stdout: string): CodexMcpServer[] | null => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const servers: CodexMcpServer[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const { name, enabled } = entry as { name?: unknown; enabled?: unknown };
    if (typeof name !== "string" || name === "" || typeof enabled !== "boolean") return null;
    servers.push({ name, enabled });
  }
  return servers;
};

/** Whether a TOML basic string can carry `name`: no control character and no lone surrogate. */
const tomlSafe = (name: string): boolean => {
  for (let i = 0; i < name.length; i += 1) {
    const unit = name.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = name.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

/**
 * The one `--config` value that turns every named server off, as an inline table (see the
 * header for why not dotted keys). JSON string escapes are valid TOML basic-string escapes.
 */
export const codexMcpServersOffOverride = (names: readonly string[]): string => {
  if (names.length === 0) throw new Error("no server to turn off");
  const bad = names.find((name) => !tomlSafe(name));
  if (bad !== undefined) {
    throw new Error(
      `refusing a headless Codex run: an MCP server name holds a character a config override cannot carry (${JSON.stringify(bad)}), so it cannot be turned off`,
    );
  }
  return `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(", ")}}`;
};

export interface CodexMcpGuardOptions {
  readonly spawner: Spawner;
  /** The engine bridge's server name, which stays on. */
  readonly bridge: string;
  /** How long one listing may run before it is killed. Default 20 s. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** The most output read from a listing; a longer one is refused, never half-read. */
const MAX_OUTPUT_CHARS = 1_000_000;

const refusal = (cwd: string, why: string): Error =>
  new Error(
    `refusing a headless Codex run in ${cwd}: ${why}, so the MCP servers outside the engine bridge (the user's, a trusted project's, a plugin's) cannot be kept out of the role run (D-cf, AD-25 rule 1)`,
  );

/** Lists the servers a Codex role run would load, and stops any listing still running. */
export const createCodexMcpGuard = (options: CodexMcpGuardOptions) => {
  const runner = createCommandOutputRunner({
    spawner: options.spawner,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxChars: MAX_OUTPUT_CHARS,
  });
  const list = async (cwd: string, configArgs: readonly string[]): Promise<CodexMcpServer[]> => {
    const output = await runner.run(codexMcpListCommand(configArgs), cwd);
    if (output.kind === "failed") {
      throw refusal(
        cwd,
        "could not list the MCP servers Codex would load (`codex mcp list` did not finish)",
      );
    }
    if (output.code !== 0) {
      throw refusal(
        cwd,
        `could not list the MCP servers Codex would load (\`codex mcp list\` exited ${output.code})`,
      );
    }
    const servers = output.truncated ? null : parseCodexMcpList(output.stdout);
    if (servers === null) {
      throw refusal(cwd, "could not read the MCP server list `codex mcp list --json` printed");
    }
    return servers;
  };
  return {
    /** Every server but the bridge the run would load, by name (on or off: turning off is idempotent). */
    async serversToTurnOff(cwd: string, configArgs: readonly string[]): Promise<string[]> {
      const servers = await list(cwd, configArgs);
      return [
        ...new Set(servers.map((s) => s.name).filter((name) => name !== options.bridge)),
      ].sort();
    },
    /** Throws unless, with the final overrides, no server but the bridge is on. */
    async confirmOff(cwd: string, configArgs: readonly string[]): Promise<void> {
      const left = (await list(cwd, configArgs))
        .filter((s) => s.enabled && s.name !== options.bridge)
        .map((s) => s.name);
      if (left.length > 0) {
        throw refusal(
          cwd,
          `Codex would still start MCP servers ${left.join(", ")} beside the engine bridge`,
        );
      }
    },
    dispose(): void {
      runner.dispose();
    },
  };
};
