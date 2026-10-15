/**
 * Registering the compiled plugin with Codex (D-bn, spine §5 readings 168 and 213; §7 row "Codex
 * plugin manifest fields"). Codex installs a plugin only from a marketplace, and `enabled = true`
 * in `config.toml` alone lists it as not installed, so `vtc install codex`:
 * 1. lays out a local marketplace under the VTC home, `<vtcHome>/plugins/codex-marketplace/`
 *    (inside `plugins/**` of `ROLE_DENIED_VTC.homeWriteDeny`, so no role can change what Codex
 *    installs from it): `.agents/plugins/marketplace.json` and the plugin itself in `./vtc`;
 * 2. runs `codex plugin marketplace add <dir> --json`, which writes `[marketplaces.vtc-local]`;
 * 3. runs `codex plugin add vtc@vtc-local --json`, which copies the plugin into Codex's cache
 *    (`$CODEX_HOME/plugins/cache/vtc-local/vtc/<version>/`) and writes
 *    `[plugins."vtc@vtc-local"] enabled = true`.
 * What codex-cli 0.162.1 does, checked offline in a temporary `CODEX_HOME` (D-cl, 2026-10-15,
 * `plugin-add.json` and the round-5 re-install check): adding the same marketplace again reports
 * `alreadyAdded: true`, and `plugin add` again refreshes the cached copy even at the same version,
 * so a re-install updates the plugin. The same name from another directory (a moved VTC home) is
 * refused ("already added from a different source"); `marketplace remove` then drops only the
 * `[marketplaces.vtc-local]` entry, and the add is retried once. It is removed only when the
 * `source` Codex recorded for it in `<codexHome>/config.toml` is VTC's own layout (a
 * `plugins/codex-marketplace` directory, an older VTC home); a `vtc-local` from anywhere else (or
 * one whose source cannot be read) is the user's, and the install refuses, naming it. With the plugin installed and
 * the installer's `[mcp_servers.vtc]` in `config.toml`, `codex mcp list` shows one `vtc` server,
 * the config's (the plugin's own `mcp.json` entry runs from the cache directory instead).
 *
 * Every command runs with `CODEX_HOME` set, so the registration lands in the Codex home the
 * adapter was told about and never in another one. A headless role run never loads the plugin
 * (`features.plugins=false`, `CODEX_ROLE_FEATURES_OFF`), so its hooks and MCP server stay out of
 * role runs.
 */
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HostCommand } from "@vtc/shared";
import type { CommandOutput } from "../common/command-output.js";
import { readTextOrNull, replaceDirectory, writeOwnFileAtomic } from "../common/files.js";
import { parseJsonObject, text } from "../common/json.js";
import { CODEX_BINARY } from "./command.js";

/** The marketplace `vtc install codex` registers (the same name as Claude's local one). */
export const CODEX_MARKETPLACE = "vtc-local";

/** Where the marketplace lives, under `plugins/**` of the VTC home, which no role may write. */
export const codexMarketplaceDir = (vtcHome: string): string =>
  join(vtcHome, "plugins", "codex-marketplace");

/** The marketplace index Codex reads (`<root>/.agents/plugins/marketplace.json`). */
export const codexMarketplaceIndex = (plugin: string) => ({
  name: CODEX_MARKETPLACE,
  interface: { displayName: "VTC (local)" },
  plugins: [
    {
      name: plugin,
      source: { source: "local", path: `./${plugin}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    },
  ],
});

/** Copies the compiled plugin into the marketplace and writes its index; returns the index path. */
export const writeCodexMarketplace = (pluginDir: string, root: string, plugin: string): string => {
  replaceDirectory(pluginDir, join(root, plugin));
  const index = join(root, ".agents", "plugins", "marketplace.json");
  // a file only VTC writes (under `plugins/**`): never through a link, whoever put one there
  mkdirSync(dirname(index), { recursive: true });
  writeOwnFileAtomic(index, `${JSON.stringify(codexMarketplaceIndex(plugin), null, 2)}\n`);
  return index;
};

const codex = (codexHome: string, args: readonly string[]): HostCommand => ({
  command: CODEX_BINARY,
  args: [...args],
  env: { CODEX_HOME: codexHome },
});

/** Pure: the registration commands, in the order they run. */
export const codexPluginCommands = (root: string, codexHome: string, plugin: string) => ({
  addMarketplace: codex(codexHome, ["plugin", "marketplace", "add", root, "--json"]),
  removeMarketplace: codex(codexHome, ["plugin", "marketplace", "remove", CODEX_MARKETPLACE]),
  addPlugin: codex(codexHome, ["plugin", "add", `${plugin}@${CODEX_MARKETPLACE}`, "--json"]),
});

/** Runs one short host command in `cwd` and reports what it left behind. */
export type RunCommand = (command: HostCommand, cwd: string) => Promise<CommandOutput>;

const MOVED_SOURCE = /already added from a different source/iu;

const describe = (command: HostCommand, output: CommandOutput): string => {
  const line = `codex ${command.args.join(" ")}`;
  if (output.kind === "failed") {
    return output.timedOut === true
      ? `${line} did not finish in time and was stopped (is codex waiting on something?)`
      : `${line} could not run (is codex on PATH?)`;
  }
  const said = (output.stderr.trim() || output.stdout.trim()).slice(-400);
  return `${line} exited ${output.code}${said === "" ? "" : `: ${said}`}`;
};

/** The JSON object a `--json` command printed, or a thrown error naming the command. */
const jsonOf = (command: HostCommand, output: CommandOutput): Record<string, unknown> => {
  if (output.kind !== "exited" || output.code !== 0) throw new Error(describe(command, output));
  const value = parseJsonObject(output.stdout);
  if (value === null) {
    throw new Error(`codex ${command.args.join(" ")} printed no JSON object`);
  }
  return value;
};

export interface CodexPluginRegistration {
  /** Codex's cached copy of the plugin (`installedPath`). */
  readonly installedPath: string;
  readonly pluginId: string;
  readonly version: string | null;
  /** The source of the older VTC marketplace this install replaced, if it replaced one. */
  readonly replacedSource: string | null;
}

/** A TOML table header's dotted name without quotes or spaces, or null for a non-header line. */
const tomlHeader = (line: string): string | null => {
  const match = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/u.exec(line);
  return match?.[1] === undefined ? null : match[1].replace(/["'\s]/gu, "");
};

/** A one-line TOML string value (`"..."` or `'...'`), or null for anything else. */
const tomlString = (raw: string): string | null => {
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1);
  if (!raw.startsWith('"')) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

/**
 * Pure: the `source` of `[marketplaces.<name>]` in a Codex `config.toml` (where codex-cli
 * 0.162.1 records an added marketplace, `plugin-reinstall.json`), or null when there is none or
 * it is not a one-line string. Approximate: a line reader, not a TOML parser; anything it cannot
 * read is null, which refuses the removal.
 */
export const codexMarketplaceSource = (config: string, name: string): string | null => {
  let inTable = false;
  for (const line of config.split("\n")) {
    const header = tomlHeader(line);
    if (header !== null) {
      inTable = header === `marketplaces.${name}`;
      continue;
    }
    const value = inTable ? /^\s*source\s*=\s*(\S.*?)\s*(#[^"']*)?$/u.exec(line)?.[1] : undefined;
    if (value !== undefined) return tomlString(value);
  }
  return null;
};

/** Whether a marketplace source is VTC's own layout (`<vtcHome>/plugins/codex-marketplace`). */
const isVtcMarketplace = (source: string): boolean => {
  const dir = source.replace(/\/+$/u, "");
  return basename(dir) === "codex-marketplace" && basename(dirname(dir)) === "plugins";
};

/**
 * Registers the marketplace at `root` and installs `plugin` from it into `codexHome`. Throws,
 * naming the failed command, when Codex refuses or reports another marketplace or plugin.
 */
export const registerCodexPlugin = async (
  run: RunCommand,
  options: { readonly root: string; readonly codexHome: string; readonly plugin: string },
): Promise<CodexPluginRegistration> => {
  const commands = codexPluginCommands(options.root, options.codexHome, options.plugin);
  let added = await run(commands.addMarketplace, options.root);
  let replacedSource: string | null = null;
  if (added.kind === "exited" && added.code !== 0 && MOVED_SOURCE.test(added.stderr)) {
    // VTC's own marketplace name from an older VTC home: drop that entry, then add this one;
    // never a `vtc-local` that is not VTC's layout (the user's own), nor one whose source is unknown
    const config = join(options.codexHome, "config.toml");
    const source = codexMarketplaceSource(readTextOrNull(config) ?? "", CODEX_MARKETPLACE);
    if (source === null || !isVtcMarketplace(source)) {
      throw new Error(
        `a Codex marketplace named ${CODEX_MARKETPLACE} is already added from ${source === null ? `a source VTC cannot read in ${config}` : source}, which is not a VTC marketplace; VTC leaves it alone. Remove it (codex plugin marketplace remove ${CODEX_MARKETPLACE}) if it is no longer wanted`,
      );
    }
    replacedSource = source;
    const removed = await run(commands.removeMarketplace, options.root);
    if (removed.kind !== "exited" || removed.code !== 0) {
      throw new Error(describe(commands.removeMarketplace, removed));
    }
    added = await run(commands.addMarketplace, options.root);
  }
  const marketplace = jsonOf(commands.addMarketplace, added);
  if (marketplace.marketplaceName !== CODEX_MARKETPLACE) {
    throw new Error(
      `codex registered the marketplace as ${JSON.stringify(marketplace.marketplaceName)}, not ${CODEX_MARKETPLACE}`,
    );
  }
  const installed = jsonOf(commands.addPlugin, await run(commands.addPlugin, options.root));
  const pluginId = `${options.plugin}@${CODEX_MARKETPLACE}`;
  const installedPath = text(installed.installedPath);
  if (installed.pluginId !== pluginId || installedPath === null) {
    throw new Error(
      `codex plugin add reported ${JSON.stringify(installed.pluginId)} at ${JSON.stringify(installed.installedPath)}, expected ${pluginId} with its installed path`,
    );
  }
  return { installedPath, pluginId, version: text(installed.version), replacedSource };
};
