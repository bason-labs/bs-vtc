import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STATUSLINE_TEE, statuslineTeeCommand } from "@vtc/shared";
import * as adapters from "../../src/index.js";
import { createClaudeCodeAdapter } from "../../src/index.js";
import { writeFixturePlugin } from "../support/plugin-fixture.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const setup = () => {
  const home = temp("vtc-home-");
  const projectRoot = temp("vtc-project-");
  const pluginDir = temp("vtc-plugin-");
  writeFixturePlugin("claude-code", pluginDir);
  return { home, projectRoot, pluginDir };
};
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const writeJsonFile = (path: string, value: unknown): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

describe("Claude install (AD-6 rule 5, AD-16 rule 4)", () => {
  it("user scope: places the plugin in a local marketplace and registers it in ~/.claude", async () => {
    const env = setup();
    const result = await createClaudeCodeAdapter().install({ ...env, scope: "user" });
    const marketplace = join(env.home, ".vtc", "claude-marketplace");
    const settingsPath = join(env.home, ".claude", "settings.json");
    expect(result.written).toContain(settingsPath);
    expect(result.written).toContain(join(marketplace, ".claude-plugin", "marketplace.json"));
    expect(result.written).toContain(join(marketplace, "plugins", "vtc", "vtc-manifest.json"));
    expect(existsSync(join(marketplace, "plugins/vtc/agents/vtc-qa-judge.md"))).toBe(true);
    expect(readJson(join(marketplace, ".claude-plugin", "marketplace.json"))).toEqual({
      name: "vtc-local",
      owner: { name: "vtc" },
      plugins: [
        {
          name: "vtc",
          source: "./plugins/vtc",
          description: "VTC fixture plugin.",
          version: "0.1.0",
        },
      ],
    });
    expect(readJson(settingsPath)).toEqual({
      extraKnownMarketplaces: {
        "vtc-local": { source: { source: "directory", path: marketplace } },
      },
      enabledPlugins: { "vtc@vtc-local": true },
      statusLine: { type: "command", command: "vtc statusline-tee" },
    });
  });

  it("wraps the user's own statusline and keeps every other setting", async () => {
    const env = setup();
    const settingsPath = join(env.home, ".claude", "settings.json");
    writeJsonFile(settingsPath, {
      model: "opus",
      enabledPlugins: { "other@market": true },
      statusLine: { type: "command", command: "~/bin/my line.sh 'x'", padding: 1 },
    });
    await createClaudeCodeAdapter().install({ ...env, scope: "user" });
    const settings = readJson(settingsPath);
    expect(settings.model).toBe("opus");
    expect(settings.enabledPlugins).toEqual({ "other@market": true, "vtc@vtc-local": true });
    expect(settings.statusLine).toEqual({
      type: "command",
      command: `vtc statusline-tee -- '~/bin/my line.sh '\\''x'\\'''`,
      padding: 1,
    });
  });

  it.skipIf(process.platform === "win32")(
    "the shell hands the shim the user's command unchanged as the one word after -- (`vtc statusline-tee [-- <cmd>]`)",
    () => {
      const user = `~/bin/my line.sh 'x' "$HOME" | tr a b; echo \\ done`;
      const wired = statuslineTeeCommand(user);
      expect(wired.startsWith("vtc statusline-tee -- ")).toBe(true);
      // run the wired line with a stand-in for `vtc statusline-tee` that prints its arguments
      const printed = execFileSync("/bin/sh", [
        "-c",
        wired.replace("vtc statusline-tee", "printf '%s\\0'"),
      ]).toString("utf8");
      expect(printed.split("\0").slice(0, -1)).toEqual(["--", user]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a 0600 settings file 0600 and rewrites a symlinked one through the link",
    async () => {
      const env = setup();
      const settingsPath = join(env.home, ".claude", "settings.json");
      writeJsonFile(settingsPath, { model: "opus" });
      chmodSync(settingsPath, 0o600);
      await createClaudeCodeAdapter().install({ ...env, scope: "user" });
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);

      const other = setup();
      const dotfiles = temp("vtc-dotfiles-");
      const real = join(dotfiles, "claude-settings.json");
      writeFileSync(real, JSON.stringify({ model: "haiku" }));
      chmodSync(real, 0o640);
      mkdirSync(join(other.home, ".claude"));
      const link = join(other.home, ".claude", "settings.json");
      symlinkSync(real, link);
      await createClaudeCodeAdapter().install({ ...other, scope: "user" });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readJson(real)).toMatchObject({
        model: "haiku",
        enabledPlugins: { "vtc@vtc-local": true },
      });
      expect(statSync(real).mode & 0o777).toBe(0o640);
    },
  );

  it.skipIf(process.platform === "win32")(
    "creates a new settings file 0600 (it may later hold MCP env tokens)",
    async () => {
      const env = setup();
      await createClaudeCodeAdapter().install({ ...env, scope: "user" });
      expect(statSync(join(env.home, ".claude", "settings.json")).mode & 0o777).toBe(0o600);
    },
  );

  it("refuses to replace a settings link that points at nothing", async () => {
    const env = setup();
    mkdirSync(join(env.home, ".claude"));
    const link = join(env.home, ".claude", "settings.json");
    symlinkSync(join(env.home, "missing.json"), link);
    await expect(createClaudeCodeAdapter().install({ ...env, scope: "user" })).rejects.toThrow(
      /link to a missing file/,
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("writes the shared shim command line and keeps no local copy of it (spine §5 reading 61)", async () => {
    expect(adapters).not.toHaveProperty("STATUSLINE_TEE");
    expect(adapters).not.toHaveProperty("statuslineTeeCommand");
    for (const [userLine, expected] of [
      [undefined, `${STATUSLINE_TEE.command} ${STATUSLINE_TEE.subcommand}`],
      ["   ", "vtc statusline-tee"],
      ["starship prompt", "vtc statusline-tee -- 'starship prompt'"],
    ] as const) {
      const env = setup();
      const settingsPath = join(env.home, ".claude", "settings.json");
      if (userLine !== undefined) {
        writeJsonFile(settingsPath, { statusLine: { type: "command", command: userLine } });
      }
      await createClaudeCodeAdapter().install({ ...env, scope: "user" });
      const command = (readJson(settingsPath).statusLine as { command: string }).command;
      expect(command).toBe(expected);
      expect(command).toBe(statuslineTeeCommand(userLine));
      expect(command).not.toContain("--wrap");
    }
  });

  it("rewrites an earlier `--wrap` shim to the frozen `--` form, keeping the user's command", async () => {
    const env = setup();
    const settingsPath = join(env.home, ".claude", "settings.json");
    writeJsonFile(settingsPath, {
      statusLine: { type: "command", command: "vtc statusline-tee --wrap 'my line'" },
    });
    await createClaudeCodeAdapter().install({ ...env, scope: "user" });
    expect(readJson(settingsPath).statusLine).toEqual({
      type: "command",
      command: "vtc statusline-tee -- 'my line'",
    });
  });

  it("installs both scopes and keeps the local marketplace under the request's home (reading 60, D-ah)", async () => {
    for (const scope of ["user", "project"] as const) {
      const env = setup();
      const result = await createClaudeCodeAdapter().install({ ...env, scope });
      const marketplace = join(env.home, ".vtc", "claude-marketplace");
      expect(existsSync(join(marketplace, ".claude-plugin", "marketplace.json"))).toBe(true);
      for (const path of result.written) {
        expect(path.startsWith(marketplace) || path.includes(".claude"), path).toBe(true);
      }
    }
  });

  it("is idempotent: a second install never wraps the shim twice", async () => {
    const env = setup();
    const settingsPath = join(env.home, ".claude", "settings.json");
    writeJsonFile(settingsPath, { statusLine: { type: "command", command: "starship" } });
    const adapter = createClaudeCodeAdapter();
    await adapter.install({ ...env, scope: "user" });
    const first = readFileSync(settingsPath, "utf8");
    await adapter.install({ ...env, scope: "user" });
    expect(readFileSync(settingsPath, "utf8")).toBe(first);
    expect(readJson(settingsPath).statusLine).toEqual({
      type: "command",
      command: statuslineTeeCommand("starship"),
    });
  });

  it("project scope writes only the repo's personal settings.local.json, wrapping the effective statusline", async () => {
    const env = setup();
    writeJsonFile(join(env.home, ".claude", "settings.json"), {
      statusLine: { type: "command", command: "user-line" },
    });
    writeJsonFile(join(env.projectRoot, ".claude", "settings.json"), { model: "sonnet" });
    const result = await createClaudeCodeAdapter().install({ ...env, scope: "project" });
    const local = join(env.projectRoot, ".claude", "settings.local.json");
    expect(result.written).toContain(local);
    expect(result.written).not.toContain(join(env.projectRoot, ".claude", "settings.json"));
    expect(readJson(join(env.projectRoot, ".claude", "settings.json"))).toEqual({
      model: "sonnet",
    });
    expect(readJson(local).statusLine).toEqual({
      type: "command",
      command: "vtc statusline-tee -- 'user-line'",
    });
    expect(result.notes.join(" ")).toContain("out of git");
  });

  it("refuses to overwrite a settings file it cannot read", async () => {
    const env = setup();
    const settingsPath = join(env.home, ".claude", "settings.json");
    mkdirSync(join(env.home, ".claude"));
    writeFileSync(settingsPath, "{ not json");
    await expect(createClaudeCodeAdapter().install({ ...env, scope: "user" })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
  });

  it("refuses a missing or foreign plugin", async () => {
    const env = setup();
    const adapter = createClaudeCodeAdapter();
    await expect(
      adapter.install({ ...env, pluginDir: temp("vtc-empty-"), scope: "user" }),
    ).rejects.toThrow(/missing vtc-manifest.json/);
    const codexPlugin = temp("vtc-codex-plugin-");
    writeFixturePlugin("codex", codexPlugin);
    await expect(
      adapter.install({ ...env, pluginDir: codexPlugin, scope: "user" }),
    ).rejects.toThrow(/codex plugin/);
  });

  it("reads a manifest from a newer MINOR with unknown keys (parsePersisted)", async () => {
    const env = setup();
    const manifestPath = join(env.pluginDir, "vtc-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ ...readJson(manifestPath), future_key: 1 }));
    await expect(
      createClaudeCodeAdapter().install({ ...env, scope: "user" }),
    ).resolves.toMatchObject({ written: expect.any(Array) as unknown });
  });
});
