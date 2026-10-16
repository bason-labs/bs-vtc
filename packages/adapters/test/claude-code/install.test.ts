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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeSessionSandboxState,
  hostCredentialDenyReadPaths,
  STATUSLINE_TEE,
  statuslineTeeCommand,
} from "@vtc/shared";
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
    });
    expect(result.notes.join("\n")).not.toMatch(/statusline/i);
  });

  it("leaves the user's statusline alone unless asked (H-10, reading 264)", async () => {
    const env = setup();
    const settingsPath = join(env.home, ".claude", "settings.json");
    const statusLine = { type: "command", command: "~/bin/my line.sh", padding: 1 };
    writeJsonFile(settingsPath, { model: "opus", statusLine });
    for (const statusline of [undefined, "keep"] as const) {
      const result = await createClaudeCodeAdapter().install({
        ...env,
        scope: "user",
        ...(statusline === undefined ? {} : { statusline }),
      });
      expect(readJson(settingsPath).statusLine).toEqual(statusLine);
      expect(result.notes.join("\n")).not.toMatch(/statusline/i);
    }
  });

  it("says how to undo a statusline an earlier install wrapped, and leaves it as it is", async () => {
    const env = setup();
    const settingsPath = join(env.home, ".claude", "settings.json");
    const statusLine = { type: "command", command: statuslineTeeCommand("starship") };
    writeJsonFile(settingsPath, { statusLine });
    const result = await createClaudeCodeAdapter().install({ ...env, scope: "user" });
    expect(readJson(settingsPath).statusLine).toEqual(statusLine);
    expect(result.notes.join("\n")).toMatch(
      /still runs through vtc statusline-tee.*vtc install claude-code --no-statusline/,
    );
  });

  it("--no-statusline puts back the command an earlier install wrapped", async () => {
    for (const [wired, restored] of [
      [statuslineTeeCommand("~/bin/my line.sh 'x'"), "~/bin/my line.sh 'x'"],
      ["vtc statusline-tee --wrap 'my line'", "my line"],
      [statuslineTeeCommand(`a'b'"c" | d`), `a'b'"c" | d`],
    ] as const) {
      const env = setup();
      const settingsPath = join(env.home, ".claude", "settings.json");
      writeJsonFile(settingsPath, {
        model: "opus",
        statusLine: { type: "command", command: wired, padding: 2 },
      });
      const result = await createClaudeCodeAdapter().install({
        ...env,
        scope: "user",
        statusline: "unwrap",
      });
      expect(readJson(settingsPath)).toMatchObject({
        model: "opus",
        statusLine: { type: "command", command: restored, padding: 2 },
      });
      expect(result.notes.join("\n")).toMatch(/Your statusline runs your own command again/);
    }
  });

  it("--no-statusline removes a shim that wrapped no command, and leaves a statusline it did not wrap", async () => {
    const env = setup();
    const settingsPath = join(env.home, ".claude", "settings.json");
    writeJsonFile(settingsPath, { statusLine: { type: "command", command: "vtc statusline-tee" } });
    await createClaudeCodeAdapter().install({ ...env, scope: "user", statusline: "unwrap" });
    expect(readJson(settingsPath)).not.toHaveProperty("statusLine");
    const own = { type: "command", command: "starship" };
    writeJsonFile(settingsPath, { statusLine: own });
    const result = await createClaudeCodeAdapter().install({
      ...env,
      scope: "user",
      statusline: "unwrap",
    });
    expect(readJson(settingsPath).statusLine).toEqual(own);
    expect(result.notes.join("\n")).toMatch(/does not run through vtc statusline-tee/);
  });

  it("wraps the user's own statusline when asked and keeps every other setting", async () => {
    const env = setup();
    const settingsPath = join(env.home, ".claude", "settings.json");
    writeJsonFile(settingsPath, {
      model: "opus",
      enabledPlugins: { "other@market": true },
      statusLine: { type: "command", command: "~/bin/my line.sh 'x'", padding: 1 },
    });
    const result = await createClaudeCodeAdapter().install({
      ...env,
      scope: "user",
      statusline: "wrap",
    });
    expect(result.notes.join("\n")).toContain("vtc statusline-tee");
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
      await createClaudeCodeAdapter().install({ ...env, scope: "user", statusline: "wrap" });
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
    await createClaudeCodeAdapter().install({ ...env, scope: "user", statusline: "wrap" });
    expect(readJson(settingsPath).statusLine).toEqual({
      type: "command",
      command: "vtc statusline-tee -- 'my line'",
    });
  });

  it("puts the local marketplace under the request's VTC home, where the role deny lists point (reading 83)", async () => {
    const env = setup();
    const vtcHome = temp("vtc-vtchome-");
    const result = await createClaudeCodeAdapter().install({ ...env, vtcHome, scope: "user" });
    const marketplace = join(vtcHome, "claude-marketplace");
    expect(existsSync(join(marketplace, "plugins/vtc/agents/vtc-qa-judge.md"))).toBe(true);
    expect(existsSync(join(env.home, ".vtc", "claude-marketplace"))).toBe(false);
    for (const path of result.written.filter((p) => !p.includes(".claude"))) {
      expect(path.startsWith(marketplace), path).toBe(true);
    }
    const settings = readJson(join(env.home, ".claude", "settings.json"));
    expect(settings.extraKnownMarketplaces).toEqual({
      "vtc-local": { source: { source: "directory", path: marketplace } },
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
    await adapter.install({ ...env, scope: "user", statusline: "wrap" });
    const first = readFileSync(settingsPath, "utf8");
    await adapter.install({ ...env, scope: "user", statusline: "wrap" });
    expect(readFileSync(settingsPath, "utf8")).toBe(first);
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
    const result = await createClaudeCodeAdapter().install({
      ...env,
      scope: "project",
      statusline: "wrap",
    });
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
    // unwrapping drops the local copy, so the user's own statusline applies again
    await createClaudeCodeAdapter().install({ ...env, scope: "project", statusline: "unwrap" });
    expect(readJson(local)).not.toHaveProperty("statusLine");
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

describe("Claude install: the project's local settings; the session sandbox is the cli's alone (D-an)", () => {
  const VTC_HOME = "/home/dev/.vtc";
  // git sees only the repository under test: no user or system ignore rules or config
  beforeEach(() => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    // the default `core.excludesFile` is `$XDG_CONFIG_HOME/git/ignore`
    vi.stubEnv("XDG_CONFIG_HOME", temp("vtc-xdg-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  /** A project that is a git checkout. */
  const repoSetup = () => {
    const env = setup();
    git(env.projectRoot, "init", "-q");
    return env;
  };
  const localOf = (projectRoot: string) => join(projectRoot, ".claude", "settings.local.json");
  const excludeOf = (projectRoot: string) => join(projectRoot, ".git", "info", "exclude");
  const ignored = (projectRoot: string): boolean => {
    try {
      git(projectRoot, "check-ignore", "-q", "--", ".claude/settings.local.json");
      return true;
    } catch {
      return false;
    }
  };
  /** Everything an install writes, as it is before the install. */
  const snapshot = (env: { home: string; projectRoot: string }) =>
    [
      join(env.home, ".claude", "settings.json"),
      join(env.home, ".vtc", "claude-marketplace"),
      localOf(env.projectRoot),
      excludeOf(env.projectRoot),
    ].map((path) =>
      existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : existsSync(path),
    );

  it("project scope keeps the local settings out of git: adds them to .git/info/exclude once, when nothing ignores them yet", async () => {
    const env = repoSetup();
    expect(ignored(env.projectRoot)).toBe(false);
    const adapter = createClaudeCodeAdapter({ vtcHome: VTC_HOME });
    const result = await adapter.install({ ...env, scope: "project" });
    expect(ignored(env.projectRoot)).toBe(true);
    // ignored, and not committed or staged by `git add -A`
    git(env.projectRoot, "add", "-A");
    expect(git(env.projectRoot, "ls-files", "--", ".claude")).toBe("");
    expect(result.written).toContain(excludeOf(env.projectRoot));
    expect(result.notes.join("\n")).toContain("out of git");
    const once = readFileSync(excludeOf(env.projectRoot), "utf8");
    expect(once.match(/settings\.local\.json/g)).toHaveLength(1);
    await adapter.install({ ...env, scope: "project" });
    expect(readFileSync(excludeOf(env.projectRoot), "utf8")).toBe(once);
  });

  it("leaves .git/info/exclude alone when the repo already ignores the local settings", async () => {
    const env = repoSetup();
    writeFileSync(join(env.projectRoot, ".gitignore"), ".claude/settings.local.json\n");
    const before = readFileSync(excludeOf(env.projectRoot), "utf8");
    const result = await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({
      ...env,
      scope: "project",
    });
    expect(readFileSync(excludeOf(env.projectRoot), "utf8")).toBe(before);
    expect(result.written).not.toContain(excludeOf(env.projectRoot));
    expect(ignored(env.projectRoot)).toBe(true);
  });

  it("project scope refuses, writing nothing, when git tracks the local settings: it never writes machine paths into a shared file", async () => {
    const env = repoSetup();
    writeJsonFile(localOf(env.projectRoot), { model: "opus" });
    git(env.projectRoot, "add", "-f", "--", ".claude/settings.local.json");
    const before = snapshot(env);
    await expect(
      createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope: "project" }),
    ).rejects.toThrow(/tracked by git.*git rm --cached/);
    expect(snapshot(env)).toEqual(before);
  });

  it.skipIf(process.platform === "win32")(
    "project scope refuses, writing nothing, when the local settings or their .claude directory is a link",
    async () => {
      for (const linked of ["file", "dir"] as const) {
        const env = repoSetup();
        const outside = temp("vtc-outside-");
        const target = join(outside, "settings.local.json");
        writeFileSync(target, JSON.stringify({ model: "haiku" }));
        if (linked === "file") {
          mkdirSync(join(env.projectRoot, ".claude"));
          symlinkSync(target, localOf(env.projectRoot));
        } else {
          symlinkSync(outside, join(env.projectRoot, ".claude"));
        }
        const before = snapshot(env);
        await expect(
          createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope: "project" }),
        ).rejects.toThrow(/is a link/);
        expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ model: "haiku" }));
        expect(snapshot(env)).toEqual(before);
      }
    },
  );

  it("user scope in a git checkout writes no local settings: no session sandbox without the user's confirmation", async () => {
    const env = repoSetup();
    const before = readFileSync(excludeOf(env.projectRoot), "utf8");
    const result = await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({
      ...env,
      scope: "user",
    });
    expect(existsSync(localOf(env.projectRoot))).toBe(false);
    expect(result.written).not.toContain(localOf(env.projectRoot));
    expect(readFileSync(excludeOf(env.projectRoot), "utf8")).toBe(before);
    expect(readJson(join(env.home, ".claude", "settings.json"))).not.toHaveProperty("sandbox");
  });

  it("project scope registers the plugin and leaves the user's sandbox keys as they are, widening ones included (the cli shows and drops those)", async () => {
    const env = repoSetup();
    const local = localOf(env.projectRoot);
    const sandbox = { enabled: false, excludedCommands: ["docker"] };
    writeJsonFile(local, { model: "opus", sandbox });
    const result = await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({
      ...env,
      scope: "project",
    });
    const settings = readJson(local);
    expect(settings.enabledPlugins).toEqual({ "vtc@vtc-local": true });
    expect(settings.model).toBe("opus");
    expect(settings.sandbox).toEqual(sandbox);
    expect(
      claudeSessionSandboxState(settings, VTC_HOME, {
        projectRoot: env.projectRoot,
        homeDir: env.home,
        hostConfigDirs: {},
      }).state,
    ).toBe("off");
    expect(result.notes.join("\n")).not.toMatch(/Turned on the Claude Code session sandbox/);
  });

  it("project scope keeps a session sandbox that read-denies the host credential files (D-ad)", async () => {
    const env = repoSetup();
    const local = localOf(env.projectRoot);
    const denyRead = hostCredentialDenyReadPaths({
      "claude-code": join(env.home, ".claude"),
      codex: join(env.home, ".codex"),
    });
    writeJsonFile(local, { sandbox: { enabled: true, filesystem: { denyRead } } });
    await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope: "project" });
    const settings = readJson(local);
    expect(settings.enabledPlugins).toEqual({ "vtc@vtc-local": true });
    expect(settings.sandbox).toEqual({ enabled: true, filesystem: { denyRead } });
  });

  it("project scope refuses, writing nothing, when the local settings it would write carry an AD-9 marker", async () => {
    const env = repoSetup();
    const local = localOf(env.projectRoot);
    writeJsonFile(local, { permissions: { defaultMode: "bypassPermissions" } });
    const before = readFileSync(local, "utf8");
    await expect(
      createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope: "project" }),
    ).rejects.toThrow(/bypassPermissions/);
    expect(readFileSync(local, "utf8")).toBe(before);
    expect(existsSync(join(env.home, ".vtc", "claude-marketplace"))).toBe(false);
  });
});
