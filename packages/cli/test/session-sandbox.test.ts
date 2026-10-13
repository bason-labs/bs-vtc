/**
 * The Claude Code session sandbox the bridge reports (D-an, spine §5 reading 71), fix round 1:
 * - it is `on` only with `sandbox.failIfUnavailable` true, since by default Claude Code runs every
 *   command unsandboxed when its sandbox cannot start;
 * - any setting that lets a command past the sandbox, in the repo's local or committed settings
 *   or in the user's own, turns it `off` (`excludedCommands`, an allow entry reaching the VTC home,
 *   `filesystem.disabled`, `network.allowAllUnixSockets`, `enableWeakerNestedSandbox`);
 * - on a machine without the tools Claude Code's sandbox needs it is `unknown`;
 * - the bridge reads it again for every hello, so a mid-session edit is seen.
 * Fix round 2:
 * - every sandbox key that is not known to keep VTC's denies closed counts as widening (fail
 *   closed): `allowAppleEvents`, `enableWeakerNetworkIsolation`, `network.allowLocalBinding` not
 *   false, a non-empty `network.allowMachLookup`, an `enabledPlatforms` leaving out this platform,
 *   and any key VTC does not know;
 * - the files Claude Code reads for the session's cwd are read too: `<cwd>/.claude/settings.json`,
 *   `<cwd>/.claude/settings.local.json` and the same two at the worktree's top level (a linked
 *   worktree or a subdirectory), relative paths resolved against each file's own project dir.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTER_FACTORIES } from "@vtc/adapters";
import { claudeSessionSandboxSettings, type HostAdapter } from "@vtc/shared";
import { createInstallCommand, defaultInstallDeps } from "../src/commands/install.js";
import { checkSessionSandbox, detectGateSandbox } from "../src/doctor-checks.js";
import type { Exec, ExecResult } from "../src/process.js";
import {
  CLAUDE_LOCAL_SETTINGS,
  CLAUDE_PROJECT_SETTINGS,
  claudeSessionSandboxOf,
  mergeSessionSandboxSettings,
  sandboxToolsMissing,
  sessionSandboxProbe,
  sessionSandboxSettings,
  wideningOf,
  type SessionSandboxEnv,
} from "../src/session-sandbox.js";
import { capture, cleanupDirs, git, initRepo, tempDir, writePluginTrees } from "./helpers.js";

afterEach(cleanupDirs);

/** A user home with the VTC home inside it, and nothing read from the real one. */
const setup = (over: Partial<SessionSandboxEnv> = {}) => {
  const homeDir = tempDir("vtc-user-");
  const vtcHome = join(homeDir, ".vtc");
  mkdirSync(vtcHome);
  const repo = initRepo();
  const env: SessionSandboxEnv = {
    userSettings: join(homeDir, ".claude", "settings.json"),
    homeDir,
    platform: "darwin",
    pathEnv: "/usr/bin",
    exists: () => true,
    ...over,
  };
  const write = (rel: string, value: unknown): void => {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, rel), JSON.stringify(value));
  };
  const writeUser = (value: unknown): void => {
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "settings.json"), JSON.stringify(value));
  };
  const paths = { projectRoot: repo, homeDir };
  return { homeDir, vtcHome, repo, env, write, writeUser, paths };
};

describe("the session sandbox needs sandbox.failIfUnavailable", () => {
  it("is part of what vtc install writes, on top of the shared settings", () => {
    const vtcHome = "/home/u/.vtc";
    const shared = claudeSessionSandboxSettings(vtcHome).sandbox;
    expect(sessionSandboxSettings(vtcHome)).toEqual({
      sandbox: { ...shared, failIfUnavailable: true },
    });
    expect(
      mergeSessionSandboxSettings({}, vtcHome, { projectRoot: "/r", homeDir: "/home/u" }),
    ).toEqual(sessionSandboxSettings(vtcHome));
  });

  it("reads as off with sandbox.failIfUnavailable missing when only the shared keys are there", () => {
    const { vtcHome, repo, env, write, paths } = setup();
    write(CLAUDE_LOCAL_SETTINGS, claudeSessionSandboxSettings(vtcHome));
    const report = claudeSessionSandboxOf(repo, vtcHome, env);
    expect(report.state).toBe("off");
    expect(report.missing).toEqual(["sandbox.failIfUnavailable"]);
    write(CLAUDE_LOCAL_SETTINGS, {
      sandbox: { ...sessionSandboxSettings(vtcHome).sandbox, failIfUnavailable: false },
    });
    expect(claudeSessionSandboxOf(repo, vtcHome, env).missing).toEqual([
      "sandbox.failIfUnavailable",
    ]);
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, vtcHome, paths));
    expect(claudeSessionSandboxOf(repo, vtcHome, env)).toEqual({
      state: "on",
      missing: [],
      widening: [],
      unavailable: [],
      file: "ok",
      path: join(repo, CLAUDE_LOCAL_SETTINGS),
    });
  });

  it("is unknown where Claude Code cannot start its sandbox (no bwrap or socat, Windows)", () => {
    expect(sandboxToolsMissing("darwin", "", (p) => p === "/usr/bin/sandbox-exec")).toEqual([]);
    expect(sandboxToolsMissing("darwin", "", () => false)).toEqual(["/usr/bin/sandbox-exec"]);
    const linuxHas = (names: string[]) => (p: string) => names.some((n) => p === `/opt/bin/${n}`);
    expect(sandboxToolsMissing("linux", "/opt/bin:relative", linuxHas(["bwrap", "socat"]))).toEqual(
      [],
    );
    expect(sandboxToolsMissing("linux", "/opt/bin", linuxHas(["socat"]))).toEqual(["bwrap"]);
    // a relative PATH entry is never searched
    expect(sandboxToolsMissing("linux", "bin", () => true)).toEqual(["bwrap", "socat"]);
    expect(sandboxToolsMissing("win32", "", () => true)).toEqual([
      "a Claude Code sandbox on win32",
    ]);
    const { vtcHome, repo, env, write, paths } = setup({
      platform: "linux",
      pathEnv: "/opt/bin",
      exists: linuxHas(["socat"]),
    });
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, vtcHome, paths));
    expect(claudeSessionSandboxOf(repo, vtcHome, env)).toMatchObject({
      state: "unknown",
      unavailable: ["bwrap"],
    });
  });
});

describe("settings that widen the sandbox turn it off", () => {
  it("lists every widening key of one settings object", () => {
    const vtcHome = "/home/u/.vtc";
    const source = { path: "/r/.claude/settings.json", base: "/r", homeDir: "/home/u" };
    expect(wideningOf({ sandbox: { excludedCommands: [] } }, source, vtcHome)).toEqual([]);
    expect(
      wideningOf(
        {
          permissions: { additionalDirectories: ["~/.vtc/run", "/elsewhere"] },
          sandbox: {
            excludedCommands: ["npm *"],
            enableWeakerNestedSandbox: true,
            network: {
              allowAllUnixSockets: true,
              allowUnixSockets: ["/home/u/.vtc/run/abc.sock", "/var/run/docker.sock"],
            },
            filesystem: {
              disabled: true,
              allowRead: ["~/", "~/.vtc/run", "/home/u/.v*/token", "/srv/**"],
              allowWrite: ["../../home/u/.vtc/token", "/tmp"],
            },
          },
        },
        source,
        vtcHome,
      ),
    ).toEqual([
      'sandbox.excludedCommands ["npm *"] in /r/.claude/settings.json',
      "sandbox.enableWeakerNestedSandbox in /r/.claude/settings.json",
      "sandbox.network.allowAllUnixSockets in /r/.claude/settings.json",
      "sandbox.filesystem.disabled in /r/.claude/settings.json",
      'sandbox.filesystem.allowRead ["~/.vtc/run","/home/u/.v*/token"] in /r/.claude/settings.json',
      'sandbox.filesystem.allowWrite ["../../home/u/.vtc/token"] in /r/.claude/settings.json',
      'sandbox.network.allowUnixSockets ["/home/u/.vtc/run/abc.sock"] in /r/.claude/settings.json',
      'permissions.additionalDirectories ["~/.vtc/run"] in /r/.claude/settings.json',
    ]);
    // a list that is not a list of strings is not understood, so it counts
    expect(
      wideningOf({ sandbox: { filesystem: { allowRead: "~/.vtc" } } }, source, vtcHome),
    ).toEqual(['sandbox.filesystem.allowRead "~/.vtc" in /r/.claude/settings.json']);
  });

  it("an excludedCommands entry in the repo's committed settings turns it off", () => {
    const { vtcHome, repo, env, write, paths } = setup();
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, vtcHome, paths));
    write(CLAUDE_PROJECT_SETTINGS, { sandbox: { excludedCommands: ["npm *"] } });
    const report = claudeSessionSandboxOf(repo, vtcHome, env);
    expect(report.state).toBe("off");
    expect(report.missing).toEqual([]);
    expect(report.widening).toEqual([
      `sandbox.excludedCommands ["npm *"] in ${join(repo, CLAUDE_PROJECT_SETTINGS)}`,
    ]);
    expect(checkSessionSandbox(report)).toMatchObject({
      status: "warn",
      detail: expect.stringContaining(`let commands past it: sandbox.excludedCommands`) as string,
    });
  });

  it("an allowRead under the VTC home in the user's settings turns it off", () => {
    const { vtcHome, repo, env, write, writeUser, paths, homeDir } = setup();
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, vtcHome, paths));
    writeUser({ sandbox: { filesystem: { allowRead: ["~/.vtc/run"] } } });
    const report = claudeSessionSandboxOf(repo, vtcHome, env);
    expect(report.state).toBe("off");
    expect(report.widening).toEqual([
      `sandbox.filesystem.allowRead ["~/.vtc/run"] in ${join(homeDir, ".claude", "settings.json")}`,
    ]);
    // a wider allow keeps the narrower deny: not widening
    writeUser({ sandbox: { filesystem: { allowRead: ["~/"] } } });
    expect(claudeSessionSandboxOf(repo, vtcHome, env).state).toBe("on");
    // left out (tests, or a user without one): nothing read
    expect(claudeSessionSandboxOf(repo, vtcHome, { ...env, userSettings: null }).state).toBe("on");
  });

  it("widening keys in the local file itself turn it off", () => {
    const { vtcHome, repo, env, write, paths } = setup();
    const merged = mergeSessionSandboxSettings({}, vtcHome, paths) as {
      sandbox: Record<string, unknown>;
    };
    write(CLAUDE_LOCAL_SETTINGS, {
      ...merged,
      sandbox: { ...merged.sandbox, network: { allowAllUnixSockets: true } },
    });
    expect(claudeSessionSandboxOf(repo, vtcHome, env)).toMatchObject({
      state: "off",
      widening: [`sandbox.network.allowAllUnixSockets in ${join(repo, CLAUDE_LOCAL_SETTINGS)}`],
    });
  });

  it("a committed settings file it cannot read (a link, not JSON) makes it unknown", () => {
    const { vtcHome, repo, env, write, paths } = setup();
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, vtcHome, paths));
    const elsewhere = join(tempDir(), "settings.json");
    writeFileSync(elsewhere, "{}");
    symlinkSync(elsewhere, join(repo, CLAUDE_PROJECT_SETTINGS));
    const linked = claudeSessionSandboxOf(repo, vtcHome, env);
    expect(linked.state).toBe("unknown");
    expect(linked.widening).toEqual([
      expect.stringMatching(/settings\.json cannot be read \(it is a symbolic link\)/),
    ]);
    const { vtcHome: h2, repo: r2, env: e2, write: w2, writeUser, paths: p2 } = setup();
    w2(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, h2, p2));
    writeUser("not an object");
    expect(claudeSessionSandboxOf(r2, h2, e2).state).toBe("unknown");
  });

  it("vtc install's merge drops the local entries that widen it, keeping the rest", () => {
    const vtcHome = "/home/u/.vtc";
    const paths = { projectRoot: "/r", homeDir: "/home/u" };
    const merged = mergeSessionSandboxSettings(
      {
        permissions: { allow: ["Bash(ls)"], additionalDirectories: ["~/.vtc", "/data"] },
        sandbox: {
          excludedCommands: ["docker *"],
          enableWeakerNestedSandbox: true,
          network: {
            allowedDomains: ["registry.npmjs.org"],
            allowAllUnixSockets: true,
            allowUnixSockets: ["~/.vtc/run/x.sock", "/var/run/docker.sock"],
          },
          filesystem: { disabled: true, allowRead: ["~/.vtc/run", "."], allowWrite: ["/x"] },
        },
      },
      vtcHome,
      paths,
    );
    const wanted = sessionSandboxSettings(vtcHome).sandbox;
    expect(merged).toEqual({
      permissions: { allow: ["Bash(ls)"], additionalDirectories: ["/data"] },
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        network: {
          allowedDomains: ["registry.npmjs.org"],
          allowUnixSockets: ["/var/run/docker.sock"],
        },
        filesystem: {
          allowRead: ["."],
          allowWrite: ["/x"],
          denyRead: wanted.filesystem.denyRead,
          denyWrite: wanted.filesystem.denyWrite,
        },
      },
    });
    expect(wideningOf(merged, { path: "/r/x", base: "/r", homeDir: "/home/u" }, vtcHome)).toEqual(
      [],
    );
  });
});

describe("vtc install --host claude-code and widening settings", () => {
  it("shows and drops the local entries, and names what other files still widen", async () => {
    const { vtcHome, repo, env, write } = setup();
    git(repo, "config", "core.excludesFile", "/dev/null");
    write(CLAUDE_LOCAL_SETTINGS, { sandbox: { excludedCommands: ["docker *"] } });
    write(CLAUDE_PROJECT_SETTINGS, { sandbox: { excludedCommands: ["npm *"] } });
    git(repo, "add", CLAUDE_PROJECT_SETTINGS);
    git(repo, "commit", "-q", "-m", "committed settings");
    const adapter = {
      host: "claude-code",
      install: () => Promise.resolve({ written: [], notes: [] }),
      dispose: () => Promise.resolve(),
    } as unknown as HostAdapter;
    const questions: string[] = [];
    const cmd = createInstallCommand(() => ({
      ...defaultInstallDeps(),
      factories: { "claude-code": () => adapter },
      home: () => env.homeDir,
      pluginDir: (host) => `/plugins/${host}`,
      platform: "darwin",
      timerHost: () => {
        throw new Error("the real launchd or systemd is never touched in tests");
      },
      confirm: (q) => (questions.push(q), Promise.resolve(true)),
      sessionSandboxEnv: () => env,
    }));
    const { ctx, out } = capture(repo, vtcHome);
    expect(await cmd.run(["claude-code"], ctx)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(
      /let commands past the sandbox and are removed:\n {2}- sandbox\.excludedCommands \["docker \*"\]/,
    );
    expect(questions).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(repo, CLAUDE_LOCAL_SETTINGS), "utf8")) as {
      sandbox: Record<string, unknown>;
    };
    expect(written.sandbox).not.toHaveProperty("excludedCommands");
    expect(written.sandbox.failIfUnavailable).toBe(true);
    // the committed file is the repo's: named, never edited
    expect(text).toMatch(
      /still off[^]*sandbox\.excludedCommands \["npm \*"\] in .*settings\.json \(remove it\)/,
    );
    expect(readFileSync(join(repo, CLAUDE_PROJECT_SETTINGS), "utf8")).toContain("npm *");
  });
});

describe("vtc install --host claude-code with the real Claude adapter: one writer, after consent (D-an)", () => {
  const installWith = (
    env: SessionSandboxEnv,
    answer: boolean,
  ): { cmd: ReturnType<typeof createInstallCommand>; questions: string[] } => {
    const questions: string[] = [];
    const plugins = writePluginTrees(tempDir("vtc-plugins-"));
    const cmd = createInstallCommand(() => ({
      ...defaultInstallDeps(),
      factories: { "claude-code": ADAPTER_FACTORIES["claude-code"] },
      home: () => env.homeDir,
      pluginDir: (host) => plugins[`plugin:${host}`],
      platform: "darwin",
      timerHost: () => {
        throw new Error("the real launchd or systemd is never touched in tests");
      },
      confirm: (q) => (questions.push(q), Promise.resolve(answer)),
      sessionSandboxEnv: () => env,
    }));
    return { cmd, questions };
  };

  for (const scope of ["user", "project"] as const) {
    it(`${scope} scope: a local excludedCommands is shown and dropped, not refused, and the sandbox reads on`, async () => {
      const { vtcHome, repo, env, write } = setup();
      git(repo, "config", "core.excludesFile", "/dev/null");
      write(CLAUDE_LOCAL_SETTINGS, { model: "opus", sandbox: { excludedCommands: ["docker *"] } });
      const { cmd, questions } = installWith(env, true);
      const { ctx, out } = capture(repo, vtcHome);
      expect(await cmd.run(["claude-code", "--scope", scope], ctx)).toBe(0);
      const text = out.join("\n");
      expect(text).toMatch(
        /let commands past the sandbox and are removed:\n {2}- sandbox\.excludedCommands/,
      );
      expect(questions).toHaveLength(1);
      const written = JSON.parse(readFileSync(join(repo, CLAUDE_LOCAL_SETTINGS), "utf8")) as {
        model: string;
        sandbox: Record<string, unknown>;
      };
      expect(written.model).toBe("opus");
      expect(written.sandbox).not.toHaveProperty("excludedCommands");
      expect(claudeSessionSandboxOf(repo, vtcHome, env, repo).state).toBe("on");
    });

    it(`${scope} scope: declining leaves no sandbox settings on disk`, async () => {
      const { vtcHome, repo, env, write } = setup();
      git(repo, "config", "core.excludesFile", "/dev/null");
      write(CLAUDE_LOCAL_SETTINGS, { model: "opus" });
      const { cmd, questions } = installWith(env, false);
      const { ctx, out } = capture(repo, vtcHome);
      expect(await cmd.run(["claude-code", "--scope", scope], ctx)).toBe(0);
      expect(questions).toHaveLength(1);
      expect(out.join("\n")).toMatch(/Session sandbox not written/);
      const local = JSON.parse(readFileSync(join(repo, CLAUDE_LOCAL_SETTINGS), "utf8")) as Record<
        string,
        unknown
      >;
      expect(local.model).toBe("opus");
      expect(local).not.toHaveProperty("sandbox");
      expect(claudeSessionSandboxOf(repo, vtcHome, env, repo).state).not.toBe("on");
    });
  }
});

describe("the bridge reads the state again for every hello", () => {
  it("sees an edit made mid-session, and reports nothing for Codex or outside a repo", () => {
    const { vtcHome, repo, env, write, paths } = setup();
    expect(sessionSandboxProbe(repo, "codex", vtcHome, env)).toBeUndefined();
    expect(sessionSandboxProbe(null, "claude-code", vtcHome, env)).toBeUndefined();
    const probe = sessionSandboxProbe(repo, "claude-code", vtcHome, env);
    expect(probe?.()).toBe("unknown");
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, vtcHome, paths));
    expect(probe?.()).toBe("on");
    write(CLAUDE_PROJECT_SETTINGS, { sandbox: { excludedCommands: ["git *"] } });
    expect(probe?.()).toBe("off");
  });
});

const result = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  ...over,
});

describe("vtc doctor's gate sandbox check runs a confined no-op, not a version probe", () => {
  it("reports bwrap only when it can create its namespaces, sandbox-exec only when it starts", async () => {
    const seen: string[] = [];
    const execOf =
      (ok: Record<string, boolean>): Exec =>
      (command, args) => {
        const line = [command, ...args].join(" ");
        seen.push(line);
        return Promise.resolve(result({ code: ok[line] === true ? 0 : 1 }));
      };
    const BWRAP =
      "bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid --unshare-net --die-with-parent -- true";
    const SEATBELT = "/usr/bin/sandbox-exec -p (version 1)(allow default) -- /usr/bin/true";
    // installed, but namespaces are refused (AppArmor userns restriction, userns disabled)
    expect(await detectGateSandbox("linux", () => false, execOf({ "bwrap --version": true }))).toBe(
      null,
    );
    expect(seen).toContain(BWRAP);
    expect(await detectGateSandbox("linux", () => false, execOf({ [BWRAP]: true }))).toBe("bwrap");
    const exists = (p: string): boolean => p === "/usr/bin/sandbox-exec";
    expect(await detectGateSandbox("darwin", exists, execOf({}))).toBeNull();
    expect(await detectGateSandbox("darwin", exists, execOf({ [SEATBELT]: true }))).toBe(
      "sandbox-exec",
    );
    expect(await detectGateSandbox("darwin", () => false, execOf({ [SEATBELT]: true }))).toBeNull();
  });
});

describe("fix round 2: sandbox keys VTC does not know to be safe turn it off", () => {
  const vtcHome = "/home/u/.vtc";
  const source = { path: "/r/.claude/settings.json", base: "/r", homeDir: "/home/u" };

  it("flags allowAppleEvents, weaker network isolation, local binding, Mach lookups and platforms", () => {
    expect(
      wideningOf(
        {
          sandbox: {
            allowAppleEvents: true,
            enableWeakerNetworkIsolation: true,
            enabledPlatforms: ["linux"],
            network: { allowLocalBinding: true, allowMachLookup: ["com.apple.*"] },
          },
        },
        source,
        vtcHome,
        "darwin",
      ),
    ).toEqual([
      "sandbox.allowAppleEvents in /r/.claude/settings.json",
      "sandbox.enableWeakerNetworkIsolation in /r/.claude/settings.json",
      "sandbox.network.allowLocalBinding in /r/.claude/settings.json",
      'sandbox.network.allowMachLookup ["com.apple.*"] in /r/.claude/settings.json',
      'sandbox.enabledPlatforms ["linux"] (leaves out macos) in /r/.claude/settings.json',
    ]);
    // a list that includes this platform, false flags and empty lists are fine
    expect(
      wideningOf(
        {
          sandbox: {
            allowAppleEvents: false,
            enableWeakerNetworkIsolation: false,
            enabledPlatforms: ["macos", "linux"],
            network: { allowLocalBinding: false, allowMachLookup: [] },
          },
        },
        source,
        vtcHome,
        "darwin",
      ),
    ).toEqual([]);
    // Linux: Claude Code may call it linux or wsl, so the list needs both
    expect(
      wideningOf({ sandbox: { enabledPlatforms: ["linux"] } }, source, vtcHome, "linux"),
    ).toEqual(['sandbox.enabledPlatforms ["linux"] (leaves out wsl) in /r/.claude/settings.json']);
    expect(
      wideningOf({ sandbox: { enabledPlatforms: "macos" } }, source, vtcHome, "darwin"),
    ).toEqual(['sandbox.enabledPlatforms "macos" (leaves out macos) in /r/.claude/settings.json']);
  });

  it("flags every key it does not know, and leaves the known-safe ones alone", () => {
    expect(
      wideningOf(
        {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: true,
            ignoreViolations: { "*": ["/tmp"] },
            credentials: { envVars: [] },
            network: {
              allowedDomains: ["registry.npmjs.org"],
              deniedDomains: ["evil.example"],
              strictAllowlist: true,
              allowManagedDomainsOnly: false,
              httpProxyPort: 8080,
              socksProxyPort: 1080,
            },
            filesystem: {
              denyRead: ["/secret"],
              denyWrite: ["/secret"],
              allowManagedReadPathsOnly: false,
            },
          },
        },
        source,
        vtcHome,
        "darwin",
      ),
    ).toEqual([]);
    expect(
      wideningOf(
        {
          sandbox: {
            bwrapPath: "/opt/fake-bwrap",
            someFutureKey: 1,
            network: { allowEverything: true },
            filesystem: { allowGitConfig: true },
          },
        },
        source,
        vtcHome,
        "darwin",
      ),
    ).toEqual([
      'sandbox.bwrapPath "/opt/fake-bwrap" (not known to keep the sandbox closed) in /r/.claude/settings.json',
      "sandbox.someFutureKey 1 (not known to keep the sandbox closed) in /r/.claude/settings.json",
      "sandbox.network.allowEverything true (not known to keep the sandbox closed) in /r/.claude/settings.json",
      "sandbox.filesystem.allowGitConfig true (not known to keep the sandbox closed) in /r/.claude/settings.json",
    ]);
    // a sandbox, network or filesystem that is not an object is not understood
    expect(wideningOf({ sandbox: true }, source, vtcHome, "darwin")).toEqual([
      "sandbox true (not known to keep the sandbox closed) in /r/.claude/settings.json",
    ]);
    expect(wideningOf({ sandbox: { network: [] } }, source, vtcHome, "darwin")).toEqual([
      "sandbox.network [] (not known to keep the sandbox closed) in /r/.claude/settings.json",
    ]);
  });

  it("allowAppleEvents in the user's settings turns it off", () => {
    const { vtcHome: home, repo, env, write, writeUser, paths, homeDir } = setup();
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, home, paths));
    writeUser({ sandbox: { allowAppleEvents: true } });
    expect(claudeSessionSandboxOf(repo, home, env)).toMatchObject({
      state: "off",
      widening: [`sandbox.allowAppleEvents in ${join(homeDir, ".claude", "settings.json")}`],
    });
  });

  it("allowMachLookup in the repo's committed settings turns it off", () => {
    const { vtcHome: home, repo, env, write, paths } = setup();
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, home, paths));
    write(CLAUDE_PROJECT_SETTINGS, { sandbox: { network: { allowMachLookup: ["*"] } } });
    expect(claudeSessionSandboxOf(repo, home, env)).toMatchObject({
      state: "off",
      widening: [`sandbox.network.allowMachLookup ["*"] in ${join(repo, CLAUDE_PROJECT_SETTINGS)}`],
    });
  });

  it("another local file turning a required key back turns it off; the user's file does not win", () => {
    const { vtcHome: home, repo, env, write, writeUser, paths } = setup();
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, home, paths));
    // the local tier wins over the user's: these do not reach the session
    writeUser({ sandbox: { allowUnsandboxedCommands: true, enabled: false } });
    expect(claudeSessionSandboxOf(repo, home, env).state).toBe("on");
    // a subdirectory's legacy local file, merged in by Claude Code: not known which one wins
    const sub = join(repo, "sub");
    mkdirSync(join(sub, ".claude"), { recursive: true });
    writeFileSync(
      join(sub, CLAUDE_LOCAL_SETTINGS),
      JSON.stringify({ sandbox: { allowUnsandboxedCommands: true, enabled: false } }),
    );
    expect(claudeSessionSandboxOf(repo, home, env, sub)).toMatchObject({
      state: "off",
      widening: [
        `sandbox.enabled false in ${join(sub, CLAUDE_LOCAL_SETTINGS)}`,
        `sandbox.allowUnsandboxedCommands true in ${join(sub, CLAUDE_LOCAL_SETTINGS)}`,
      ],
    });
  });

  it("vtc install's merge drops the new widening keys and the unknown ones", () => {
    const paths = { projectRoot: "/r", homeDir: "/home/u", platform: "darwin" as const };
    const merged = mergeSessionSandboxSettings(
      {
        sandbox: {
          allowAppleEvents: true,
          enableWeakerNetworkIsolation: true,
          enabledPlatforms: ["linux"],
          bwrapPath: "/opt/fake-bwrap",
          autoAllowBashIfSandboxed: true,
          network: {
            allowLocalBinding: true,
            allowMachLookup: ["*"],
            allowedDomains: ["registry.npmjs.org"],
            mystery: 1,
          },
          filesystem: { allowGitConfig: true, allowWrite: ["/x"] },
        },
      },
      vtcHome,
      paths,
    );
    const wanted = sessionSandboxSettings(vtcHome).sandbox;
    expect(merged).toEqual({
      sandbox: {
        autoAllowBashIfSandboxed: true,
        enabled: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        network: { allowedDomains: ["registry.npmjs.org"] },
        filesystem: {
          allowWrite: ["/x"],
          denyRead: wanted.filesystem.denyRead,
          denyWrite: wanted.filesystem.denyWrite,
        },
      },
    });
    expect(
      wideningOf(merged, { path: "/r/x", base: "/r", homeDir: "/home/u" }, vtcHome, "darwin"),
    ).toEqual([]);
    // a sandbox that is not an object is replaced
    expect(mergeSessionSandboxSettings({ sandbox: true }, vtcHome, paths)).toEqual(
      sessionSandboxSettings(vtcHome),
    );
  });
});

describe("fix round 2: the settings Claude Code reads for the session's cwd", () => {
  it("a linked worktree's committed settings.json widening the sandbox turns it off", () => {
    const { vtcHome, repo, env, write, paths } = setup();
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, vtcHome, paths));
    git(repo, "checkout", "-q", "-b", "widen");
    write(CLAUDE_PROJECT_SETTINGS, { sandbox: { excludedCommands: ["npm *"] } });
    git(repo, "add", CLAUDE_PROJECT_SETTINGS);
    git(repo, "commit", "-q", "-m", "widen");
    git(repo, "checkout", "-q", "main");
    const worktree = join(tempDir("vtc-wt-"), "wt");
    git(repo, "worktree", "add", "-q", worktree, "widen");
    // the main checkout reads on; a Lead session in the worktree does not
    expect(claudeSessionSandboxOf(repo, vtcHome, env).state).toBe("on");
    const report = claudeSessionSandboxOf(repo, vtcHome, env, worktree);
    expect(report.state).toBe("off");
    expect(report.widening).toEqual([
      `sandbox.excludedCommands ["npm *"] in ${join(worktree, CLAUDE_PROJECT_SETTINGS)}`,
    ]);
    // and from a subdirectory of that worktree: its top level is read too
    mkdirSync(join(worktree, "pkg"));
    expect(claudeSessionSandboxOf(repo, vtcHome, env, join(worktree, "pkg")).widening).toEqual([
      `sandbox.excludedCommands ["npm *"] in ${join(worktree, CLAUDE_PROJECT_SETTINGS)}`,
    ]);
    // the probe the bridge builds reads from the session's cwd
    expect(sessionSandboxProbe(repo, "claude-code", vtcHome, env, worktree)?.()).toBe("off");
    expect(sessionSandboxProbe(repo, "claude-code", vtcHome, env, repo)?.()).toBe("on");
  });

  it("a subdirectory's own settings.json or legacy settings.local.json turns it off", () => {
    const { vtcHome, repo, env, write, paths } = setup();
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, vtcHome, paths));
    const sub = join(repo, "apps", "web");
    mkdirSync(join(sub, ".claude"), { recursive: true });
    writeFileSync(
      join(sub, CLAUDE_PROJECT_SETTINGS),
      JSON.stringify({ sandbox: { excludedCommands: ["npm *"] } }),
    );
    expect(claudeSessionSandboxOf(repo, vtcHome, env, sub)).toMatchObject({
      state: "off",
      widening: [`sandbox.excludedCommands ["npm *"] in ${join(sub, CLAUDE_PROJECT_SETTINGS)}`],
    });
    writeFileSync(join(sub, CLAUDE_PROJECT_SETTINGS), "{}");
    // a relative path resolves against the subdirectory's own project dir
    const rel = relative(sub, join(vtcHome, "run"));
    writeFileSync(
      join(sub, CLAUDE_LOCAL_SETTINGS),
      JSON.stringify({ sandbox: { network: { allowUnixSockets: [rel] } } }),
    );
    expect(claudeSessionSandboxOf(repo, vtcHome, env, sub)).toMatchObject({
      state: "off",
      widening: [
        `sandbox.network.allowUnixSockets ${JSON.stringify([rel])} in ${join(sub, CLAUDE_LOCAL_SETTINGS)}`,
      ],
    });
    // the same cwd as the repo root reads each file once
    expect(claudeSessionSandboxOf(repo, vtcHome, env, repo).state).toBe("on");
  });

  it("a subdirectory whose .claude is a link makes it unknown", () => {
    const { vtcHome, repo, env, write, paths } = setup();
    write(CLAUDE_LOCAL_SETTINGS, mergeSessionSandboxSettings({}, vtcHome, paths));
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, "settings.json"), "{}");
    symlinkSync(elsewhere, join(sub, ".claude"));
    const report = claudeSessionSandboxOf(repo, vtcHome, env, sub);
    expect(report.state).toBe("unknown");
    expect(report.widening).toEqual([
      expect.stringMatching(/sub\/\.claude is a symbolic link/),
      expect.stringMatching(/sub\/\.claude is a symbolic link/),
    ]);
  });
});
