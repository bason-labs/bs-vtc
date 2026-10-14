import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineMcpServer,
  findDisallowedHostArgs,
  findForbiddenHostArgs,
  HEADLESS_DEFAULTS,
  headlessIsolationGaps,
  hostCredentialDenyReadPaths,
  HostOutcomeSchema,
  jsonSchemaFor,
  ROLE_DENIED_VTC,
  WAVE3_HOME_WRITE_DENY,
  type RoleTools,
  type SandboxProfile,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { claudeSandboxProfile } from "../../src/claude-code/command.js";
import { ADAPTER_FACTORIES, createClaudeCodeAdapter } from "../../src/index.js";
import { fakeSpawner } from "../support/fake-spawner.js";
import { fixtureText } from "../support/fixtures.js";

const CWD = "/work/app/.vtc/state/worktrees/T-1";
const READ_ONLY: RoleTools = { profile: "read_only", write_paths: [], engine_tools: [] };
const WRITE_SCOPED: RoleTools = {
  profile: "write_scoped",
  write_paths: [".vtc/spec/**"],
  engine_tools: ["research_fetch"],
};
const ENGINEER: RoleTools = { profile: "code_sandboxed", write_paths: [], engine_tools: [] };

const VTC_HOME = "/home/dev/.vtc";
const CODEX_HOME = "/home/dev/.codex";
const CLAUDE_CONFIG = "/home/dev/.claude";
const PLUGIN_DIR = "/opt/vtc/plugin";
const HOMES = { vtcHome: VTC_HOME, codexHome: CODEX_HOME, claudeConfigDir: CLAUDE_CONFIG };
/** Claude's own credential file, built only through the shared deny helper (D-ad). */
const credentialsIn = (configDir: string): string => {
  const [path] = hostCredentialDenyReadPaths({ "claude-code": configDir });
  if (path === undefined) throw new Error("no Claude credential path");
  return path;
};
const CLAUDE_CREDENTIALS = credentialsIn(CLAUDE_CONFIG);
const profileRequest = (
  tools: RoleTools,
  network: "none" | "registries" = "none",
  writablePaths: readonly string[] = ["src/**"],
) => ({ tools, cwd: CWD, writablePaths, protectedPaths: ["test/acceptance/**"], network });
const profile = (...args: Parameters<typeof profileRequest>) =>
  createClaudeCodeAdapter(HOMES).sandboxProfile(profileRequest(...args));

/** Denied to every role: the web tools (engine tools only). */
const ALWAYS_DENIED = ["WebFetch", "WebSearch"];
/**
 * Never readable, as absolute rules in the settings: the VTC home's install token, daemon
 * sockets and hidden acceptance tests (`ROLE_DENIED_VTC.homeReadDeny`, D-an), the Codex home and
 * Claude's own credential file (D-ad).
 */
const UNREADABLE_RULES = [
  "Read(//home/dev/.vtc/token)",
  "Read(//home/dev/.vtc/run/**)",
  "Read(//home/dev/.vtc/hidden/**)",
  "Read(//home/dev/.codex/**)",
  `Read(/${CLAUDE_CREDENTIALS})`,
];
/** The VTC home's hidden acceptance tests and daemon sockets (§7.3; spine §7). */
const UNREADABLE_VTC_DIRS = [`${VTC_HOME}/hidden`, `${VTC_HOME}/run`];
const UNREADABLE = [
  `${VTC_HOME}/token`,
  `${VTC_HOME}/run`,
  `${VTC_HOME}/hidden`,
  CODEX_HOME,
  CLAUDE_CREDENTIALS,
];
/** D-w, D-ap: what no role may write under the VTC home, as sandbox paths (directories and files). */
const VTC_HOME_DENIED_PATHS = [
  "allowlists",
  "osv-db",
  "hidden",
  // D-ap (spine §5 reading 73): everything under the VTC home that is later run or trusted
  "scanners",
  "claude-marketplace",
  "plugins",
  "engines",
  "run",
  "config.yaml",
  "token",
  // wave 3 (contracts 4.5.0, spine §5 reading 103): Lookback versions and pins, the research
  // cache, the pinned browser store and the design library
  "lookback",
  "research-cache",
  "browsers",
  "design-library",
].map((d) => `${VTC_HOME}/${d}`);

const settingsOf = (p: SandboxProfile) =>
  p.settings as {
    permissions: { deny: string[] };
    sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } };
  };
const HOST_CONFIG_DENIED = [".claude/**", ".mcp.json", ".codex/**"].flatMap((path) =>
  ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(${path})`),
);

const argAfter = (args: readonly string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

const request = (overrides: Partial<SpawnRoleRequest> = {}): SpawnRoleRequest => ({
  role: "qa",
  mode: "judge",
  model: { tier: "mid", effort: "medium", model: "sonnet" },
  dispatch: "headless",
  cwd: CWD,
  prompt: "Read the task pack and follow it.",
  outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
  sandbox: profile(READ_ONLY),
  timeoutMs: 60_000,
  ...overrides,
});

describe("Claude sandboxProfile (§12.1, AD-9)", () => {
  it("reviewers get read tools only: no edits, no shell", () => {
    const p = profile(READ_ONLY);
    expect(p.enforced).toEqual({
      readOnly: true,
      perPathWriteDeny: true,
      network: true,
      secretsUnreadable: true,
    });
    expect(argAfter(p.cliArgs, "--allowedTools")).toBe("Read,Grep,Glob,ToolSearch");
    // the built-in tool set itself is minimal, so no settings file can bring another tool in;
    // ToolSearch only loads deferred tool definitions (the engine MCP tools may be deferred)
    expect(argAfter(p.cliArgs, "--tools")).toBe("Read,Grep,Glob,ToolSearch");
    expect(argAfter(p.cliArgs, "--disallowedTools")?.split(",")).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
      ...ALWAYS_DENIED,
    ]);
  });

  it("pins the permission mode in the settings too, so the allowlist decides", () => {
    expect(profile(WRITE_SCOPED).settings).toMatchObject({
      permissions: { defaultMode: "dontAsk" },
    });
  });

  it("no role may read the VTC install token, the Codex home or Claude's credential file, from a tool or from the sandboxed shell (AD-5, D-ad)", () => {
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const p = profile(tools);
      expect(p.enforced.secretsUnreadable).toBe(true);
      expect(argAfter(p.cliArgs, "--disallowedTools")?.split(",")).toEqual(
        expect.arrayContaining(ALWAYS_DENIED),
      );
      const settings = settingsOf(p);
      expect(settings.permissions.deny.slice(0, 5)).toEqual(UNREADABLE_RULES);
      expect(settings.sandbox.filesystem.denyRead).toEqual(UNREADABLE);
      // the credential path appears only in the two sanctioned deny lists (AD-9 exemption)
      expect(findForbiddenHostArgs(p.cliArgs)).toEqual([]);
      expect(findForbiddenHostArgs([JSON.stringify(p.settings)])).toEqual([]);
      for (const arg of p.cliArgs.filter((a) => !a.startsWith("{"))) {
        expect(arg).not.toContain(CLAUDE_CREDENTIALS);
      }
    }
  });

  it("no role may read the hidden acceptance tests or reach the daemon sockets under the VTC home (§7.3)", () => {
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const settings = settingsOf(profile(tools));
      expect(settings.permissions.deny).toEqual(
        expect.arrayContaining(["Read(//home/dev/.vtc/hidden/**)", "Read(//home/dev/.vtc/run/**)"]),
      );
      expect(settings.sandbox.filesystem.denyRead).toEqual(
        expect.arrayContaining(UNREADABLE_VTC_DIRS),
      );
    }
  });

  it("builds every VTC-home read deny from ROLE_DENIED_VTC.homeReadDeny, the one source (D-an)", () => {
    expect([...ROLE_DENIED_VTC.homeReadDeny].sort()).toEqual(["hidden/**", "run/**", "token"]);
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const settings = settingsOf(profile(tools));
      const ruleRead = settings.permissions.deny.filter((r) =>
        r.startsWith("Read(//home/dev/.vtc/"),
      );
      expect(ruleRead).toEqual(
        ROLE_DENIED_VTC.homeReadDeny.map((glob) => `Read(//home/dev/.vtc/${glob})`),
      );
      expect(
        settings.sandbox.filesystem.denyRead.filter((p) => p.startsWith(`${VTC_HOME}/`)),
      ).toEqual(
        ROLE_DENIED_VTC.homeReadDeny.map((glob) => `${VTC_HOME}/${glob.replace(/\/\*\*$/u, "")}`),
      );
    }
  });

  it("write-denies the VTC home's single files as files, not as directories (D-ap: config.yaml, token)", () => {
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const settings = settingsOf(profile(tools));
      for (const file of ["config.yaml", "token"]) {
        expect(ROLE_DENIED_VTC.homeWriteDeny).toContain(file);
        expect(settings.sandbox.filesystem.denyWrite).toContain(`${VTC_HOME}/${file}`);
        for (const tool of ["Edit", "Write", "NotebookEdit"]) {
          expect(settings.permissions.deny).toContain(`${tool}(//home/dev/.vtc/${file})`);
          expect(settings.permissions.deny).not.toContain(`${tool}(//home/dev/.vtc/${file}/**)`);
        }
      }
      // a directory entry still covers everything below it
      expect(settings.permissions.deny).toContain("Write(//home/dev/.vtc/claude-marketplace/**)");
      expect(settings.sandbox.filesystem.denyWrite).toContain(`${VTC_HOME}/claude-marketplace`);
    }
  });

  it("denies every role running `vtc calibrate` and writing the VTC home's allowlists, scanner DB and hidden tests (D-w)", () => {
    expect(ROLE_DENIED_VTC.subcommands).toEqual(["calibrate"]);
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const settings = settingsOf(profile(tools));
      const deny = settings.permissions.deny;
      for (const rule of [
        "Bash(vtc calibrate)",
        "Bash(vtc calibrate:*)",
        "Bash(npx vtc calibrate:*)",
        "Bash(pnpm exec vtc calibrate:*)",
        "Bash(bunx vtc calibrate:*)",
      ]) {
        expect(deny).toContain(rule);
      }
      for (const glob of ROLE_DENIED_VTC.homeWriteDeny) {
        for (const tool of ["Edit", "Write", "NotebookEdit"]) {
          expect(deny).toContain(`${tool}(//home/dev/.vtc/${glob})`);
        }
      }
      expect(settings.sandbox.filesystem.denyWrite).toEqual(
        expect.arrayContaining(VTC_HOME_DENIED_PATHS),
      );
    }
  });

  it("denies every role writing the wave-3 directories of the VTC home, from tools and from the shell (WAVE3_HOME_WRITE_DENY)", () => {
    expect([...WAVE3_HOME_WRITE_DENY]).toEqual([
      "lookback/**",
      "research-cache/**",
      "browsers/**",
      "design-library/**",
    ]);
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const settings = settingsOf(profile(tools));
      for (const glob of WAVE3_HOME_WRITE_DENY) {
        for (const tool of ["Edit", "Write", "NotebookEdit"]) {
          // once, even after the integrator folds the list into ROLE_DENIED_VTC.homeWriteDeny
          expect(
            settings.permissions.deny.filter((r) => r === `${tool}(//home/dev/.vtc/${glob})`),
          ).toHaveLength(1);
        }
        const dir = `${VTC_HOME}/${glob.replace(/\/\*\*$/u, "")}`;
        expect(settings.sandbox.filesystem.denyWrite.filter((p) => p === dir)).toHaveLength(1);
      }
    }
  });

  it("protects the token of the VTC home actually in use, even with spaces in its path", () => {
    const p = createClaudeCodeAdapter({
      vtcHome: "/srv/vtc home",
      codexHome: "/srv/codex",
      claudeConfigDir: "/srv/claude config",
    }).sandboxProfile(profileRequest(ENGINEER));
    const credentials = credentialsIn("/srv/claude config");
    const settings = settingsOf(p);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(//srv/vtc home/token)",
        "Read(//srv/codex/**)",
        `Read(/${credentials})`,
        "Write(//srv/vtc home/allowlists/**)",
      ]),
    );
    expect(settings.sandbox.filesystem.denyRead).toEqual([
      "/srv/vtc home/token",
      "/srv/vtc home/run",
      "/srv/vtc home/hidden",
      "/srv/codex",
      credentials,
    ]);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["Read(//srv/vtc home/hidden/**)", "Read(//srv/vtc home/run/**)"]),
    );
    expect(findForbiddenHostArgs([JSON.stringify(p.settings)])).toEqual([]);
    // the rules travel as JSON array entries, never through the comma-separated tool lists
    expect(argAfter(p.cliArgs, "--disallowedTools")).not.toContain("token");
  });

  describe("default homes", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });
    it("follow $VTC_HOME, $CODEX_HOME and $CLAUDE_CONFIG_DIR like the cli and the hosts, and the factory takes the cli's VTC home", () => {
      vi.stubEnv("VTC_HOME", "/env/vtc");
      vi.stubEnv("CODEX_HOME", "/env/codex");
      vi.stubEnv("CLAUDE_CONFIG_DIR", "/env/claude");
      expect(
        settingsOf(createClaudeCodeAdapter().sandboxProfile(profileRequest(READ_ONLY))).sandbox
          .filesystem.denyRead,
      ).toEqual([
        "/env/vtc/token",
        "/env/vtc/run",
        "/env/vtc/hidden",
        "/env/codex",
        credentialsIn("/env/claude"),
      ]);
      const wired = ADAPTER_FACTORIES["claude-code"]!({ vtcHome: "/cli/vtc" });
      expect(
        settingsOf(wired.sandboxProfile(profileRequest(READ_ONLY))).permissions.deny.slice(0, 5),
      ).toEqual([
        "Read(//cli/vtc/token)",
        "Read(//cli/vtc/run/**)",
        "Read(//cli/vtc/hidden/**)",
        "Read(//env/codex/**)",
        `Read(/${credentialsIn("/env/claude")})`,
      ]);
    });

    it("without $CLAUDE_CONFIG_DIR, deny Claude's credential file under the home's .claude", () => {
      vi.stubEnv("CLAUDE_CONFIG_DIR", "");
      vi.stubEnv("HOME", "/home/someone");
      const denyRead = settingsOf(
        createClaudeCodeAdapter({ vtcHome: VTC_HOME, codexHome: CODEX_HOME }).sandboxProfile(
          profileRequest(READ_ONLY),
        ),
      ).sandbox.filesystem.denyRead;
      expect(denyRead.at(-1)).toBe(credentialsIn(join(homedir(), ".claude")));
    });
  });

  describe("on Windows (spec §4.4 windows-x64)", () => {
    const WINDOWS = {
      vtcHome: "C:\\Users\\u\\.vtc",
      codexHome: "C:\\Users\\u\\.codex",
      claudeConfigDir: "C:\\Users\\u\\.claude",
      platformPath: win32,
    };
    const windowsProfile = (tools: RoleTools) =>
      claudeSandboxProfile({ ...profileRequest(tools), cwd: "C:\\work\\app\\wt\\T-1" }, WINDOWS);
    const credentials = credentialsIn("C:/Users/u/.claude");

    it("file-tool roles deny Claude's credential file by an absolute drive rule", () => {
      for (const tools of [READ_ONLY, WRITE_SCOPED]) {
        const p = windowsProfile(tools);
        expect(p.enforced.secretsUnreadable).toBe(true);
        const settings = settingsOf(p);
        expect(settings.permissions.deny).toEqual(
          expect.arrayContaining([
            "Read(//c/Users/u/.vtc/token)",
            "Read(//c/Users/u/.codex/**)",
            `Read(//c${credentials.slice("C:".length)})`,
          ]),
        );
        // a bare `C:/…` entry is not an AD-9 deny-list form yet, so the sandbox list (which
        // only a shell would use) does not carry it
        expect(settings.sandbox.filesystem.denyRead).not.toContain(credentials);
        expect(findForbiddenHostArgs(p.cliArgs)).toEqual([]);
        expect(findForbiddenHostArgs([JSON.stringify(p.settings)])).toEqual([]);
      }
    });

    it("refuses a shell role explicitly until the sandbox can deny the credential file there", () => {
      expect(() => windowsProfile(ENGINEER)).toThrow(/Windows drive path/);
    });
  });

  it("refuses a Claude config directory whose credential deny could name something else", () => {
    expect(() =>
      createClaudeCodeAdapter({ ...HOMES, claudeConfigDir: "/srv/a(b)" }).sandboxProfile(
        profileRequest(READ_ONLY),
      ),
    ).toThrow(/credential/);
  });

  it("refuses a write path that would inject permission rules", () => {
    for (const hostile of [
      "x),mcp__plugin_vtc_vtc__approve,Edit(y",
      "a b",
      "src/(x)",
      'src/"x"',
      "src/\u0007x",
    ]) {
      expect(() => profile(WRITE_SCOPED, "none", [hostile])).toThrow(/permission rule/);
    }
    expect(() => profile(WRITE_SCOPED, "none", ["src/**/*.ts", ".vtc/spec/**"])).not.toThrow();
  });

  it("refuses a write path Claude would read outside the worktree (home or absolute prefix)", () => {
    for (const outside of ["~/**", "~/.ssh/authorized_keys", "~user/x", "~", "/etc/x", "//etc/x"]) {
      expect(() => profile(WRITE_SCOPED, "none", [outside])).toThrow(/relative to the worktree/);
      expect(() =>
        createClaudeCodeAdapter(HOMES).sandboxProfile({
          ...profileRequest(ENGINEER),
          protectedPaths: [outside],
        }),
      ).toThrow(/relative to the worktree/);
    }
  });

  it("anchors every allow rule to the worktree", () => {
    const allowed = argAfter(
      profile(WRITE_SCOPED, "none", ["docs/x.md", "./notes/**"]).cliArgs,
      "--allowedTools",
    )?.split(",");
    expect(allowed).toEqual(expect.arrayContaining(["Edit(./docs/x.md)", "Write(./notes/**)"]));
  });

  it("write-scoped roles may edit only their paths, plus their engine tools", () => {
    const allowed = argAfter(profile(WRITE_SCOPED).cliArgs, "--allowedTools")?.split(",");
    expect(allowed).toEqual([
      "Read",
      "Grep",
      "Glob",
      "ToolSearch",
      "Edit(./src/**)",
      "Write(./src/**)",
      "NotebookEdit(./src/**)",
      "mcp__plugin_vtc_vtc__research_fetch",
      // the same engine tool through the VTC-only --mcp-config server (AD-25 rule 1)
      "mcp__vtc__research_fetch",
    ]);
    expect(argAfter(profile(WRITE_SCOPED).cliArgs, "--disallowedTools")?.split(",")).toEqual([
      "Edit(test/acceptance/**)",
      "Write(test/acceptance/**)",
      "NotebookEdit(test/acceptance/**)",
      ...HOST_CONFIG_DENIED,
      "Bash",
      ...ALWAYS_DENIED,
    ]);
  });

  it("every role's sandbox fails closed when it cannot start, instead of running Bash unsandboxed", () => {
    // code.claude.com settings: without failIfUnavailable, a sandbox that cannot start runs
    // commands unsandboxed
    for (const role of [ENGINEER, WRITE_SCOPED, READ_ONLY]) {
      expect(profile(role).settings).toMatchObject({ sandbox: { failIfUnavailable: true } });
    }
  });

  it("engineers get Bash inside the OS sandbox, with no unsandboxed escape", () => {
    const p = profile(ENGINEER);
    expect(argAfter(p.cliArgs, "--allowedTools")?.split(",")).toContain("Bash");
    expect(p.settings).toMatchObject({
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          denyWrite: [
            `${CWD}/test/acceptance/**`,
            `${CWD}/.claude/**`,
            `${CWD}/.mcp.json`,
            `${CWD}/.codex/**`,
            ...VTC_HOME_DENIED_PATHS,
          ],
          denyRead: UNREADABLE,
        },
        network: { allowedDomains: [] },
      },
    });
    expect(JSON.parse(argAfter(p.cliArgs, "--settings") ?? "")).toEqual(p.settings);
    expect(argAfter(p.cliArgs, "--tools")).toBe(
      "Read,Grep,Glob,ToolSearch,Edit,Write,NotebookEdit,Bash",
    );
  });

  it("write-scoped roles get the edit tools but no shell in the built-in tool set", () => {
    expect(argAfter(profile(WRITE_SCOPED).cliArgs, "--tools")).toBe(
      "Read,Grep,Glob,ToolSearch,Edit,Write,NotebookEdit",
    );
  });

  it("protected paths and host config are denied to the edit tools as well", () => {
    expect(argAfter(profile(ENGINEER).cliArgs, "--disallowedTools")?.split(",")).toEqual([
      "Edit(test/acceptance/**)",
      "Write(test/acceptance/**)",
      "NotebookEdit(test/acceptance/**)",
      ...HOST_CONFIG_DENIED,
      ...ALWAYS_DENIED,
    ]);
  });

  it("only the install phase reaches package registries", () => {
    const domains = (network: "none" | "registries") =>
      (
        profile(ENGINEER, network).settings as {
          sandbox: { network: { allowedDomains: string[] } };
        }
      ).sandbox.network.allowedDomains;
    expect(domains("none")).toEqual([]);
    expect(domains("registries")).toContain("registry.npmjs.org");
  });
});

describe("Claude headlessCommand", () => {
  const adapter = createClaudeCodeAdapter({ ...HOMES, pluginDir: PLUGIN_DIR });

  it("runs claude -p as the role's plugin agent with stream-json, the host schema form and the prompt on stdin", () => {
    const command = adapter.headlessCommand(request({ maxTurns: 30, maxBudgetUsd: 2.5 }));
    expect(command.command).toBe("claude");
    // set explicitly, so a -p run never waits the host's default 10 minutes for background work
    expect(command.env).toEqual({
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(HEADLESS_DEFAULTS.claudeBackgroundWaitMs),
    });
    const args = command.args;
    expect(args[0]).toBe("-p");
    expect(argAfter(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(argAfter(args, "--agent")).toBe("vtc:vtc-qa-judge");
    expect(argAfter(args, "--model")).toBe("sonnet");
    expect(argAfter(args, "--effort")).toBe("medium");
    // a run can be capped, never widened: no bypass mode and no extra directories
    expect(args).not.toContain("--add-dir");
    expect(argAfter(args, "--permission-prompts")).toBe("none");
    // pinned, so the user's defaultMode (acceptEdits, auto) never applies to a role run
    expect(argAfter(args, "--permission-mode")).toBe("dontAsk");
    expect(argAfter(args, "--max-turns")).toBe("30");
    expect(argAfter(args, "--max-budget-usd")).toBe("2.5");
    const schema = JSON.parse(argAfter(args, "--json-schema") ?? "") as Record<string, unknown>;
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).not.toHaveProperty("$id");
    expect(args.join(" ")).not.toContain("Read the task pack");
    expect(args).not.toContain("--resume");
    expect(findForbiddenHostArgs(args)).toEqual([]);
  });

  it("loads the compiled plugin, the user's own settings and a VTC-only MCP config, never the repo's settings or MCP servers, fresh and resumed (AD-25 rule 1, reading 108)", () => {
    for (const session of [undefined, { host: "claude-code" as const, id: "sess-9" }]) {
      const args = adapter.headlessCommand(request(), session).args;
      expect(argAfter(args, "--plugin-dir")).toBe(PLUGIN_DIR);
      expect(argAfter(args, "--agent")).toBe("vtc:vtc-qa-judge");
      // the user's settings are the user's trust domain; a committed .claude/settings.json
      // (allow rules, hooks, env, MCP enablement) or a local one is untrusted repo content
      expect(argAfter(args, "--setting-sources")).toBe("user");
      expect(args.filter((a) => a === "--setting-sources")).toHaveLength(1);
      // no .mcp.json or user MCP server: only the engine bridge VTC names itself
      expect(args).toContain("--strict-mcp-config");
      const bridge = engineMcpServer("claude-code");
      expect(JSON.parse(argAfter(args, "--mcp-config") ?? "")).toEqual({
        mcpServers: { vtc: { command: bridge.command, args: [...bridge.args] } },
      });
      // reading 108 replaces `--restricted` (it would drop the user's settings; a §7 spike row)
      expect(args).not.toContain("--restricted");
      expect(args.filter((a) => a === "--settings")).toHaveLength(1);
      expect(argAfter(args, "--tools")).toBe("Read,Grep,Glob,ToolSearch");
      expect(headlessIsolationGaps("claude-code", args)).toEqual([]);
      // API-key mode never: it would not read the user's subscription login (AD-9)
      expect(findDisallowedHostArgs(args)).toEqual([]);
    }
  });

  it("runs on the session's default model with only the effort set when the engine resolved no id (D-ae)", () => {
    for (const session of [undefined, { host: "claude-code" as const, id: "sess-9" }]) {
      const args = adapter.headlessCommand(
        request({ model: { tier: "low", effort: "low" } }),
        session,
      ).args;
      expect(args).not.toContain("--model");
      expect(argAfter(args, "--effort")).toBe("low");
    }
  });

  it("refuses a headless run without the compiled plugin, as the bare factory builds it (fail closed)", async () => {
    const { spawner, processes } = fakeSpawner();
    for (const bare of [
      createClaudeCodeAdapter({ spawner }),
      ADAPTER_FACTORIES["claude-code"]!(),
    ]) {
      expect(() => bare.headlessCommand(request())).toThrow(/compiled plugin/);
      await expect(bare.spawnRole(request())).rejects.toThrow(/compiled plugin/);
      await expect(bare.resume({ host: "claude-code", id: "s" }, request())).rejects.toThrow(
        /compiled plugin/,
      );
      await bare.dispose();
    }
    expect(processes).toEqual([]);
    const wired = ADAPTER_FACTORIES["claude-code"]!({ pluginDir: PLUGIN_DIR });
    expect(argAfter(wired.headlessCommand(request()).args, "--plugin-dir")).toBe(PLUGIN_DIR);
  });

  it("resumes the same session with --resume (spike: works after 4h)", () => {
    const args = adapter.headlessCommand(request(), { host: "claude-code", id: "sess-9" }).args;
    expect(argAfter(args, "--resume")).toBe("sess-9");
  });

  it("refuses another host's session or sandbox profile", () => {
    expect(() => adapter.headlessCommand(request(), { host: "codex", id: "t" })).toThrow(/codex/);
    const codexSandbox = { ...profile(READ_ONLY), host: "codex" as const };
    expect(() => adapter.headlessCommand(request({ sandbox: codexSandbox }))).toThrow(/codex/);
  });

  it("names plugin agents with the plugin namespace (AD-14 rule 1)", () => {
    expect(adapter.subagentName?.("vtc-qa-judge")).toBe("vtc:vtc-qa-judge");
  });
});

describe("Claude spawnRole and resume", () => {
  it("a subagent dispatch is a background spawn_role instruction for the Lead", async () => {
    // in-session subagents need no plugin dir: the Lead's session already has the plugin
    const result = await createClaudeCodeAdapter().spawnRole(request({ dispatch: "subagent" }));
    expect(result).toEqual({
      dispatch: "subagent",
      instruction: {
        agent: "vtc:vtc-qa-judge",
        prompt: "Read the task pack and follow it.",
        background: true,
      },
    });
  });

  it("a headless run starts exactly headlessCommand, streams lines and ends with the outcome", async () => {
    const { spawner, processes } = fakeSpawner();
    const adapter = createClaudeCodeAdapter({ spawner, pluginDir: PLUGIN_DIR });
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    const proc = processes[0]!;
    expect(proc.command).toEqual(adapter.headlessCommand(request()));
    expect(proc.options).toEqual({ cwd: CWD, stdin: "pipe" });
    expect(await proc.stdinText()).toBe("Read the task pack and follow it.");
    expect(spawned.run.command).toBe(proc.command);
    const result = JSON.stringify(JSON.parse(fixtureText("claude-code/p-json-schema-result.json")));
    proc.emit('{"type":"system","subtype":"init","session_id":"<session-id>"}', result);
    proc.exit(0);
    const outcome = HostOutcomeSchema.parse(await spawned.run.wait());
    expect(outcome.kind).toBe("done");
    const lines: string[] = [];
    for await (const line of spawned.run.lines()) lines.push(line);
    expect(lines).toHaveLength(2);
    expect(adapter.parseEvents(lines).outcome).toEqual(outcome);
  });

  it("resume starts the --resume command and refuses a Codex session", async () => {
    const { spawner, processes } = fakeSpawner((p) => {
      p.exit(1);
    });
    const adapter = createClaudeCodeAdapter({ spawner, pluginDir: PLUGIN_DIR });
    const session = { host: "claude-code" as const, id: "sess-1" };
    const resumed = await adapter.resume(session, request());
    if (resumed.dispatch !== "headless") throw new Error("expected a headless run");
    await resumed.run.wait();
    expect(processes[0]?.command).toEqual(adapter.headlessCommand(request(), session));
    await expect(adapter.resume({ host: "codex", id: "t" }, request())).rejects.toThrow(/codex/);
  });

  it("a headless run is supervised by the request's wall timeout and ends with cause timeout (AD-25 rule 4)", async () => {
    const { spawner, processes } = fakeSpawner((p) => {
      p.obeysInt = false;
      p.obeysTerm = false;
    });
    const adapter = createClaudeCodeAdapter({
      spawner,
      pluginDir: PLUGIN_DIR,
      interruptGraceMs: 10,
      killGraceMs: 10,
    });
    const spawned = await adapter.spawnRole(request({ timeoutMs: 30, idleTimeoutMs: 60_000 }));
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    processes[0]!.emit(
      ...fixtureText("claude-code/stream-killed.synthetic.jsonl")
        .split("\n")
        .filter((l) => l !== ""),
    );
    const outcome = HostOutcomeSchema.parse(await spawned.run.wait());
    expect(outcome).toMatchObject({ kind: "error", retryable: true, cause: "timeout" });
    expect(processes[0]?.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    await adapter.dispose();
  });

  it("dispose kills live runs and refuses new ones", async () => {
    const { spawner, processes } = fakeSpawner();
    const adapter = createClaudeCodeAdapter({ spawner, pluginDir: PLUGIN_DIR });
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    await adapter.dispose();
    // the whole group gets SIGINT first (AD-25 rule 4); this host ends its turn on it
    expect(processes[0]?.signals).toEqual(["SIGINT"]);
    expect(await spawned.run.wait()).toMatchObject({ kind: "error", cause: "killed" });
    await expect(adapter.spawnRole(request())).rejects.toThrow(/disposed/);
    await adapter.dispose();
  });
});
