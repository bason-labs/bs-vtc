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
  claudeSessionSandboxSettings,
  claudeSessionSandboxState,
  ROLE_DENIED_VTC,
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

describe("Claude install: the session sandbox for in-session roles (D-an, spine §5 reading 71)", () => {
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
  /** A project that is a git checkout, where the session sandbox goes. */
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

  it("keeps the local settings out of git: adds them to .git/info/exclude once, when nothing ignores them yet (D-an)", async () => {
    for (const scope of ["user", "project"] as const) {
      const env = repoSetup();
      expect(ignored(env.projectRoot)).toBe(false);
      const adapter = createClaudeCodeAdapter({ vtcHome: VTC_HOME });
      const result = await adapter.install({ ...env, scope });
      expect(ignored(env.projectRoot)).toBe(true);
      // ignored, and not committed or staged by `git add -A`
      git(env.projectRoot, "add", "-A");
      expect(git(env.projectRoot, "ls-files", "--", ".claude")).toBe("");
      expect(result.written).toContain(excludeOf(env.projectRoot));
      expect(result.notes.join("\n")).toContain("out of git");
      const once = readFileSync(excludeOf(env.projectRoot), "utf8");
      expect(once.match(/settings\.local\.json/g)).toHaveLength(1);
      await adapter.install({ ...env, scope });
      expect(readFileSync(excludeOf(env.projectRoot), "utf8")).toBe(once);
    }
  });

  it("leaves .git/info/exclude alone when the repo already ignores the local settings", async () => {
    const env = repoSetup();
    writeFileSync(join(env.projectRoot, ".gitignore"), ".claude/settings.local.json\n");
    const before = readFileSync(excludeOf(env.projectRoot), "utf8");
    const result = await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({
      ...env,
      scope: "user",
    });
    expect(readFileSync(excludeOf(env.projectRoot), "utf8")).toBe(before);
    expect(result.written).not.toContain(excludeOf(env.projectRoot));
    expect(ignored(env.projectRoot)).toBe(true);
  });

  it("refuses, writing nothing, when git tracks the local settings: it never writes machine paths into a shared file", async () => {
    for (const scope of ["user", "project"] as const) {
      const env = repoSetup();
      writeJsonFile(localOf(env.projectRoot), { model: "opus" });
      git(env.projectRoot, "add", "-f", "--", ".claude/settings.local.json");
      const before = snapshot(env);
      await expect(
        createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope }),
      ).rejects.toThrow(/tracked by git.*git rm --cached/);
      expect(snapshot(env)).toEqual(before);
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses, writing nothing, when the local settings or their .claude directory is a link: no file outside the project is rewritten",
    async () => {
      for (const scope of ["user", "project"] as const) {
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
            createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope }),
          ).rejects.toThrow(/is a link/);
          expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ model: "haiku" }));
          expect(snapshot(env)).toEqual(before);
        }
      }
    },
  );

  it("refuses, writing nothing, when a settings layer reopens an escape from the session sandbox, naming each key", async () => {
    const escapes: [string, Record<string, unknown>][] = [
      ["sandbox.excludedCommands", { excludedCommands: ["docker"] }],
      ["sandbox.network.allowAllUnixSockets", { network: { allowAllUnixSockets: true } }],
      [
        `sandbox.network.allowUnixSockets: ${VTC_HOME}/run/engine.sock`,
        { network: { allowUnixSockets: [`${VTC_HOME}/run/engine.sock`] } },
      ],
      [`sandbox.filesystem.allowRead: ${VTC_HOME}`, { filesystem: { allowRead: [VTC_HOME] } }],
      ["sandbox.filesystem.allowWrite: /home/dev", { filesystem: { allowWrite: ["/home/dev"] } }],
      [
        `sandbox.filesystem.allowRead: ${VTC_HOME}/run/**`,
        { filesystem: { allowRead: [`${VTC_HOME}/run/**`] } },
      ],
      ["sandbox.enableWeakerNestedSandbox", { enableWeakerNestedSandbox: true }],
    ];
    for (const [key, sandbox] of escapes) {
      for (const layer of ["local", "shared", "user"] as const) {
        const env = repoSetup();
        const file =
          layer === "local"
            ? localOf(env.projectRoot)
            : layer === "shared"
              ? join(env.projectRoot, ".claude", "settings.json")
              : join(env.home, ".claude", "settings.json");
        writeJsonFile(file, { sandbox });
        const before = snapshot(env);
        await expect(
          createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope: "user" }),
        ).rejects.toThrow(key);
        expect(snapshot(env)).toEqual(before);
      }
    }
  });

  it("keeps sandbox entries that stay clear of the VTC home", async () => {
    const env = repoSetup();
    const sandbox = {
      excludedCommands: [],
      network: { allowUnixSockets: ["/var/run/docker.sock"], allowAllUnixSockets: false },
      filesystem: { allowRead: ["/opt/data"], allowWrite: ["/scratch", "~/.cache"] },
    };
    writeJsonFile(localOf(env.projectRoot), { sandbox });
    await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope: "user" });
    const written = readJson(localOf(env.projectRoot)).sandbox as Record<string, unknown>;
    expect(written).toMatchObject({ excludedCommands: [], network: sandbox.network });
    expect(claudeSessionSandboxState(readJson(localOf(env.projectRoot)), VTC_HOME).state).toBe(
      "on",
    );
  });

  it("writes claudeSessionSandboxSettings into the project's settings.local.json in either scope", async () => {
    for (const scope of ["user", "project"] as const) {
      const env = repoSetup();
      const result = await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({
        ...env,
        scope,
      });
      const local = localOf(env.projectRoot);
      expect(result.written).toContain(local);
      const settings = readJson(local);
      expect(settings.sandbox).toEqual(claudeSessionSandboxSettings(VTC_HOME).sandbox);
      expect(claudeSessionSandboxState(settings, VTC_HOME)).toEqual({ state: "on", missing: [] });
      // reads denied on the token and sockets, writes on every homeWriteDeny entry
      const sandbox = settings.sandbox as {
        filesystem: { denyRead: string[]; denyWrite: string[] };
      };
      expect(sandbox.filesystem.denyRead).toEqual(
        expect.arrayContaining([`${VTC_HOME}/token`, `${VTC_HOME}/run`]),
      );
      expect(sandbox.filesystem.denyWrite).toHaveLength(ROLE_DENIED_VTC.homeWriteDeny.length);
      // the user is told what was written, and that the file stays out of git
      const notes = result.notes.join("\n");
      expect(notes).toContain(local);
      expect(notes).toContain(`${VTC_HOME}/token`);
      expect(notes).toContain("out of git");
    }
  });

  it("user scope leaves the user's own settings without a sandbox block", async () => {
    const env = repoSetup();
    await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope: "user" });
    expect(readJson(join(env.home, ".claude", "settings.json"))).not.toHaveProperty("sandbox");
    expect(readJson(localOf(env.projectRoot))).toEqual({
      sandbox: claudeSessionSandboxSettings(VTC_HOME).sandbox,
    });
  });

  it("merges into the existing local settings: keeps the user's keys and entries, turns the sandbox on, and is idempotent", async () => {
    const env = repoSetup();
    const local = localOf(env.projectRoot);
    writeJsonFile(local, {
      model: "opus",
      sandbox: {
        enabled: false,
        allowUnsandboxedCommands: true,
        network: { allowedDomains: ["example.test"] },
        filesystem: { denyRead: ["/secrets", `${VTC_HOME}/token`], allowWrite: ["/scratch"] },
      },
    });
    const adapter = createClaudeCodeAdapter({ vtcHome: VTC_HOME });
    await adapter.install({ ...env, scope: "user" });
    const wanted = claudeSessionSandboxSettings(VTC_HOME).sandbox;
    const settings = readJson(local);
    expect(settings.model).toBe("opus");
    expect(settings.sandbox).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ["example.test"] },
      filesystem: {
        denyRead: [
          "/secrets",
          `${VTC_HOME}/token`,
          ...wanted.filesystem.denyRead.filter((p) => p !== `${VTC_HOME}/token`),
        ],
        denyWrite: wanted.filesystem.denyWrite,
        allowWrite: ["/scratch"],
      },
    });
    expect(claudeSessionSandboxState(settings, VTC_HOME).state).toBe("on");
    const first = readFileSync(local, "utf8");
    await adapter.install({ ...env, scope: "user" });
    expect(readFileSync(local, "utf8")).toBe(first);
  });

  it("project scope keeps the plugin registration and the sandbox in the one local file", async () => {
    const env = repoSetup();
    await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope: "project" });
    const settings = readJson(localOf(env.projectRoot));
    expect(settings.enabledPlugins).toEqual({ "vtc@vtc-local": true });
    expect(claudeSessionSandboxState(settings, VTC_HOME).state).toBe("on");
  });

  it("refuses, writing nothing, when the local settings it would write carry an AD-9 marker", async () => {
    const env = repoSetup();
    const local = localOf(env.projectRoot);
    writeJsonFile(local, { permissions: { defaultMode: "bypassPermissions" } });
    const before = readFileSync(local, "utf8");
    await expect(
      createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({ ...env, scope: "user" }),
    ).rejects.toThrow(/bypassPermissions/);
    expect(readFileSync(local, "utf8")).toBe(before);
    expect(existsSync(join(env.home, ".vtc", "claude-marketplace"))).toBe(false);
    expect(existsSync(join(env.home, ".claude", "settings.json"))).toBe(false);
  });

  it("writes no sandbox outside a git checkout, and says how to turn it on", async () => {
    const env = setup();
    const result = await createClaudeCodeAdapter({ vtcHome: VTC_HOME }).install({
      ...env,
      scope: "user",
    });
    expect(existsSync(localOf(env.projectRoot))).toBe(false);
    expect(result.notes.join("\n")).toMatch(/session sandbox/);
  });

  it("writes no sandbox for a Windows VTC home, where Claude Code has no session sandbox, and says so", async () => {
    const env = repoSetup();
    const result = await createClaudeCodeAdapter({ vtcHome: "C:\\Users\\u\\.vtc" }).install({
      ...env,
      scope: "user",
    });
    expect(existsSync(localOf(env.projectRoot))).toBe(false);
    expect(result.notes.join("\n")).toMatch(/no session sandbox on this platform/);
  });

  it("follows the VTC home the cli resolved", async () => {
    const env = repoSetup();
    await adapters.ADAPTER_FACTORIES["claude-code"]!({ vtcHome: "/cli/vtc home" }).install({
      ...env,
      scope: "user",
    });
    expect(claudeSessionSandboxState(readJson(localOf(env.projectRoot)), "/cli/vtc home")).toEqual({
      state: "on",
      missing: [],
    });
  });
});
