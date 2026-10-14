/**
 * `vtc install codex` registers the compiled plugin per Codex's plugin layout
 * (developers.openai.com/codex/plugins/build): a marked copy at `.agents/plugins/vtc/`, the local
 * marketplace `.agents/plugins/marketplace.json`, and `[plugins."vtc@<marketplace>"] enabled =
 * true` in `.codex/config.toml`, merged into what the user already has.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_MARKETPLACE_FILE,
  CODEX_MARKETPLACE_NAME,
  CODEX_PLUGIN_PATH,
  codexMarketplaceEntry,
  registerCodexPlugin,
  upsertMarketplace,
  upsertPluginEnabled,
} from "../src/codex-registration.js";
import { cleanupDirs, tempDir, writePluginTrees } from "./helpers.js";

afterEach(cleanupDirs);

const codexPlugin = (): string => writePluginTrees(tempDir())["plugin:codex"];

describe("Codex plugin registration (official layout)", () => {
  it("copies the plugin, lists it in a new local marketplace and enables it", () => {
    const root = tempDir("vtc-root-");
    const plugin = codexPlugin();
    const result = registerCodexPlugin({ root, pluginDir: plugin, scope: "project" });
    const copy = join(root, CODEX_PLUGIN_PATH);
    expect(result.written).toEqual([
      copy,
      join(root, CODEX_MARKETPLACE_FILE),
      join(root, ".codex/config.toml"),
    ]);
    expect(readFileSync(join(copy, "plugin.json"), "utf8")).toBe(
      readFileSync(join(plugin, "plugin.json"), "utf8"),
    );
    expect(existsSync(join(copy, "skills"))).toBe(true);
    // the engine entry lives in config.toml (the adapter's), never a second one in the plugin
    expect(existsSync(join(copy, ".mcp.json"))).toBe(false);
    expect(existsSync(join(copy, "mcp.json"))).toBe(false);
    const market = JSON.parse(readFileSync(join(root, CODEX_MARKETPLACE_FILE), "utf8")) as unknown;
    expect(market).toEqual({
      name: CODEX_MARKETPLACE_NAME,
      interface: { displayName: "VTC (local)" },
      plugins: [
        {
          name: "vtc",
          source: { source: "local", path: "./.agents/plugins/vtc" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Coding",
        },
      ],
    });
    const config = readFileSync(join(root, ".codex/config.toml"), "utf8");
    expect(config).toContain('[plugins."vtc@vtc-local"]\nenabled = true\n');
    expect(result.notes.join("\n")).toMatch(/only once you trust the project/);
  });

  it("is idempotent and keeps the user's marketplace, plugins and config", () => {
    const root = tempDir("vtc-root-");
    mkdirSync(join(root, ".agents/plugins"), { recursive: true });
    writeFileSync(
      join(root, CODEX_MARKETPLACE_FILE),
      JSON.stringify({
        name: "team-tools",
        interface: { displayName: "Team" },
        plugins: [
          { name: "lint-kit", source: "./plugins/lint-kit" },
          { name: "vtc", source: "./old" },
        ],
      }),
    );
    mkdirSync(join(root, ".codex"), { recursive: true });
    const userConfig =
      'model = "gpt-6.1-sol"\n\n[mcp_servers.vtc]\ncommand = "vtc"\n\n[plugins."lint-kit@team-tools"]\nenabled = false\n';
    writeFileSync(join(root, ".codex/config.toml"), userConfig);
    const plugin = codexPlugin();
    registerCodexPlugin({ root, pluginDir: plugin, scope: "user" });
    registerCodexPlugin({ root, pluginDir: plugin, scope: "user" });
    const market = JSON.parse(readFileSync(join(root, CODEX_MARKETPLACE_FILE), "utf8")) as {
      name: string;
      plugins: { name: string }[];
    };
    expect(market.name).toBe("team-tools");
    expect(market.plugins).toEqual([
      { name: "lint-kit", source: "./plugins/lint-kit" },
      codexMarketplaceEntry(),
    ]);
    const config = readFileSync(join(root, ".codex/config.toml"), "utf8");
    expect(config.startsWith(userConfig.trimEnd())).toBe(true);
    expect(config.match(/\[plugins\."vtc@team-tools"\]/g)).toHaveLength(1);
  });

  it("replaces only its own table, under either quote style", () => {
    const before = "[plugins.'vtc@m']\nenabled = false\nextra = 1\n\n[other]\nx = 1\n";
    const after = upsertPluginEnabled(before, "m");
    expect(after).toBe(
      '[other]\nx = 1\n\n# Managed by `vtc install`: enables the vtc plugin (rewritten on install).\n[plugins."vtc@m"]\nenabled = true\n',
    );
    expect(upsertPluginEnabled(after, "m")).toBe(after);
    expect(upsertPluginEnabled("", "m")).toMatch(/^# Managed/);
  });

  it("refuses what it did not write and files it cannot extend", () => {
    const root = tempDir("vtc-root-");
    mkdirSync(join(root, CODEX_PLUGIN_PATH), { recursive: true });
    writeFileSync(join(root, CODEX_PLUGIN_PATH, "plugin.json"), "{}");
    expect(() => registerCodexPlugin({ root, pluginDir: codexPlugin(), scope: "user" })).toThrow(
      /was not written by vtc install/,
    );
    expect(() => upsertMarketplace("[]")).toThrow(/not a marketplace file/);
    expect(() => upsertMarketplace('{"plugins": {}}')).toThrow(/not a marketplace file/);
    const linked = tempDir("vtc-root-");
    mkdirSync(join(linked, ".agents/plugins"), { recursive: true });
    writeFileSync(join(linked, "elsewhere.json"), "{}");
    symlinkSync(join(linked, "elsewhere.json"), join(linked, CODEX_MARKETPLACE_FILE));
    expect(() =>
      registerCodexPlugin({ root: linked, pluginDir: codexPlugin(), scope: "user" }),
    ).toThrow(/symbolic link/);
    expect(() => registerCodexPlugin({ root, pluginDir: tempDir(), scope: "user" })).toThrow(
      /no plugin\.json/,
    );
  });
});
