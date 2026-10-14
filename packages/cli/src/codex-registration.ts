/**
 * `vtc install codex` registers the compiled plugin the way Codex's plugin docs lay it out
 * (developers.openai.com/codex/plugins/build; spine §7 row "Codex plugin manifest fields"; owner:
 * cli+binary team). `HostAdapter.install` (adapters team) keeps placing the agent TOML, the skills
 * and the engine's `[mcp_servers.vtc]` entry; this adds the plugin itself:
 *
 * 1. a copy of the plugin at `<root>/.agents/plugins/vtc/` (marked `.vtc-generated`; a directory
 *    there VTC did not write is never replaced). The copy leaves out the plugin's MCP file: the
 *    engine entry is already in `config.toml` (AD-16 rule 3), and a second one would start a
 *    second bridge;
 * 2. the marketplace `<root>/.agents/plugins/marketplace.json` listing it as a local plugin
 *    (`source.path` relative to the marketplace root), merged into one that already exists;
 * 3. `[plugins."vtc@<marketplace>"] enabled = true` in `<root>/.codex/config.toml`.
 *
 * `<root>` is the repo for the project scope and the user's home for the user scope. Codex reads a
 * project's `.codex/config.toml` only once the project is trusted.
 */
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const CODEX_PLUGIN_NAME = "vtc";
/** The marketplace VTC creates when the root has none. */
export const CODEX_MARKETPLACE_NAME = "vtc-local";
/** Where the copy goes, relative to the marketplace root. */
export const CODEX_PLUGIN_PATH = ".agents/plugins/vtc";
export const CODEX_MARKETPLACE_FILE = ".agents/plugins/marketplace.json";

const MARK = ".vtc-generated";
/** The plugin's MCP files, left out of the copy (the engine entry is in config.toml). */
const MCP_FILES = new Set(["mcp.json", ".mcp.json"]);
const MANAGED = "# Managed by `vtc install`: enables the vtc plugin (rewritten on install).";

export interface CodexRegistration {
  readonly written: readonly string[];
  readonly notes: readonly string[];
}

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const writeAtomic = (path: string, text: string): void => {
  if (isLink(path)) throw new Error(`${path} is a symbolic link: refusing to write through it`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.vtc-tmp`);
  writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
  renameSync(temp, path);
};

const copyPlugin = (pluginDir: string, target: string): void => {
  if (isLink(target)) throw new Error(`${target} is a symbolic link: refusing to replace it`);
  if (existsSync(target) && !existsSync(join(target, MARK)))
    throw new Error(
      `${target} exists and was not written by vtc install: move it away, then install again`,
    );
  const staging = `${target}.${randomBytes(4).toString("hex")}.vtc-tmp`;
  try {
    cpSync(pluginDir, staging, {
      recursive: true,
      dereference: false,
      filter: (src) => !(dirname(src) === pluginDir && MCP_FILES.has(basename(src))),
    });
    writeFileSync(join(staging, MARK), "");
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The plugin's marketplace entry (a local source inside the marketplace root). */
export const codexMarketplaceEntry = (): Record<string, unknown> => ({
  name: CODEX_PLUGIN_NAME,
  source: { source: "local", path: `./${CODEX_PLUGIN_PATH}` },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Coding",
});

/**
 * Pure: `existing` marketplace JSON (or `null`) with the vtc entry upserted, and the
 * marketplace's name. Other plugins and keys stay as they were.
 */
export const upsertMarketplace = (
  existing: string | null,
): { readonly text: string; readonly name: string } => {
  let market: Record<string, unknown>;
  if (existing === null) {
    market = {
      name: CODEX_MARKETPLACE_NAME,
      interface: { displayName: "VTC (local)" },
      plugins: [],
    };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed) || (parsed.plugins !== undefined && !Array.isArray(parsed.plugins)))
      throw new Error(`${CODEX_MARKETPLACE_FILE} is not a marketplace file VTC can extend`);
    market = parsed;
  }
  const name =
    typeof market.name === "string" && market.name !== "" ? market.name : CODEX_MARKETPLACE_NAME;
  const plugins = (Array.isArray(market.plugins) ? (market.plugins as unknown[]) : []).filter(
    (p) => !(isRecord(p) && p.name === CODEX_PLUGIN_NAME),
  );
  return {
    name,
    text: `${JSON.stringify({ ...market, name, plugins: [...plugins, codexMarketplaceEntry()] }, null, 2)}\n`,
  };
};

const headerKey = (line: string): string | null => {
  const match = /^\s*\[\s*([^\][]+?)\s*\]\s*(#.*)?$/.exec(line);
  return match?.[1] === undefined ? null : match[1].replace(/\s*\.\s*/g, ".").replace(/'/g, '"');
};

/**
 * Pure: `config` with the `[plugins."vtc@<marketplace>"]` table set to `enabled = true` (the
 * table replaced, everything else kept byte for byte).
 */
export const upsertPluginEnabled = (config: string, marketplace: string): string => {
  const key = `plugins."${CODEX_PLUGIN_NAME}@${marketplace}"`;
  const kept: string[] = [];
  let skipping = false;
  for (const line of config.split("\n")) {
    const header = /^\s*\[/.test(line) ? headerKey(line) : null;
    if (header !== null) {
      skipping = header === key;
      if (skipping && kept.at(-1) === MANAGED) kept.pop();
    }
    if (!skipping) kept.push(line);
  }
  const body = kept.join("\n").replace(/\n+$/, "");
  const table = `${MANAGED}\n[${key}]\nenabled = true\n`;
  return body === "" ? table : `${body}\n\n${table}`;
};

/** Registers the plugin under `root` (the repo or the home). */
export const registerCodexPlugin = (options: {
  readonly root: string;
  readonly pluginDir: string;
  readonly scope: "user" | "project";
}): CodexRegistration => {
  const { root, pluginDir } = options;
  if (!existsSync(join(pluginDir, "plugin.json")))
    throw new Error(`${pluginDir} has no plugin.json: rebuild the plugin (pnpm build)`);
  const target = join(root, CODEX_PLUGIN_PATH);
  copyPlugin(pluginDir, target);
  const marketPath = join(root, CODEX_MARKETPLACE_FILE);
  if (isLink(marketPath)) throw new Error(`${marketPath} is a symbolic link: refusing it`);
  const market = upsertMarketplace(
    existsSync(marketPath) ? readFileSync(marketPath, "utf8") : null,
  );
  writeAtomic(marketPath, market.text);
  const configPath = join(root, ".codex", "config.toml");
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  writeAtomic(configPath, upsertPluginEnabled(config, market.name));
  return {
    written: [target, marketPath, configPath],
    notes: [
      `Registered the vtc plugin as ${CODEX_PLUGIN_NAME}@${market.name} (${marketPath}) and enabled it in ${configPath}.`,
      ...(options.scope === "project"
        ? [
            "Codex loads a project's plugins and .codex/config.toml only once you trust the project.",
          ]
        : []),
    ],
  };
};
