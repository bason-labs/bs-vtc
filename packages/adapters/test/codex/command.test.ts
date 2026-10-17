import {
  chmodSync,
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
import {
  CODEX_HOST_WEB_SEARCH,
  findDisallowedHostArgs,
  findForbiddenHostArgs,
  headlessIsolationGaps,
  HostOutcomeSchema,
  jsonSchemaFor,
  ModelTierSchema,
  ROLE_DENIED_VTC,
  type RoleTools,
  type SpawnRoleRequest,
  TIER_EFFORT_WITHOUT_MODEL,
  WAVE3_HOME_WRITE_DENY,
} from "@vtc/shared";
import { codexSandboxProfile } from "../../src/codex/command.js";
import { ADAPTER_FACTORIES, createCodexAdapter } from "../../src/index.js";
import { codexFakeSpawner } from "../support/fake-spawner.js";
import { fixtureLines } from "../support/fixtures.js";

const CWD = "/work/app/.vtc/state/worktrees/T-1";
const READ_ONLY: RoleTools = { profile: "read_only", write_paths: [], engine_tools: [] };
const ENGINEER: RoleTools = { profile: "code_sandboxed", write_paths: [], engine_tools: [] };
const WRITE_SCOPED: RoleTools = {
  profile: "write_scoped",
  write_paths: [".vtc/spec/**"],
  engine_tools: [],
};

// the engine bridge every role run pins, with no engine tool enabled and the human-only ones
// disabled (D-an); a role with `engine_tools` gets exactly those enabled
const BRIDGE_ARGS = [
  "--config",
  'mcp_servers.vtc.command="vtc"',
  "--config",
  'mcp_servers.vtc.args=["engine", "--mcp", "--host", "codex"]',
  "--config",
  "mcp_servers.vtc.enabled_tools=[]",
  "--config",
  'mcp_servers.vtc.disabled_tools=["approve", "answer", "change_request", "cancel"]',
];
/**
 * Codex's own web search (`web_search`, codex-cli 0.162.1), set explicitly on every role run:
 * `disabled` unless the role has `host_web`, then `cached` and never `live` (H-3, D-cf).
 */
/**
 * Codex's other routes to pages the model picks, off for every role run (D-cf, the D-cl live
 * check 2026-10-15: with `web_search="disabled"` a role still called the ChatGPT apps connector
 * `codex_apps` `search_service.web_run`): the apps connectors, browser use and computer use.
 */
const OTHER_WEB_OFF = [
  "--config",
  "features.apps=false",
  "--config",
  "features.browser_use=false",
  "--config",
  "features.browser_use_external=false",
  "--config",
  "features.in_app_browser=false",
  "--config",
  "features.computer_use=false",
  // a plugin's own MCP servers cannot be turned off by name (D-cf, `mcp-servers.ts`)
  "--config",
  "features.plugins=false",
];
const FEATURES_OFF = {
  apps: false,
  browser_use: false,
  browser_use_external: false,
  in_app_browser: false,
  computer_use: false,
  plugins: false,
};
const WEB_OFF = ["--config", 'web_search="disabled"', ...OTHER_WEB_OFF];
const BRIDGE_SETTINGS = {
  vtc: {
    command: "vtc",
    args: ["engine", "--mcp", "--host", "codex"],
    enabled_tools: [],
    disabled_tools: ["approve", "answer", "change_request", "cancel"],
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vtc-codex-scratch-"));
  dirs.push(dir);
  return dir;
};

// not under /home: on macOS that is an automount, and the overlap check resolves real paths
const VTC_HOME = "/users-dev/.vtc";
// macOS: the one platform where the network-off sandbox is shown to block a Unix-socket connect
const profile = (tools: RoleTools, network: "none" | "registries" = "none") =>
  createCodexAdapter({ vtcHome: VTC_HOME, platform: "darwin" }).sandboxProfile({
    tools,
    cwd: CWD,
    writablePaths: ["src/**"],
    protectedPaths: ["test/acceptance/**"],
    network,
  });

const argAfter = (args: readonly string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

const request = (overrides: Partial<SpawnRoleRequest> = {}): SpawnRoleRequest => ({
  role: "spec_verifier",
  model: { tier: "top", effort: "high", model: "engine-model-id" },
  dispatch: "headless",
  cwd: CWD,
  prompt: "Read the task pack and follow it.",
  outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
  sandbox: profile(READ_ONLY),
  timeoutMs: 60_000,
  ...overrides,
});

describe("Codex sandboxProfile (§12.1, AD-9)", () => {
  it("reviewers run read-only", () => {
    const p = profile(READ_ONLY);
    expect(p.cliArgs).toEqual(["--config", 'sandbox_mode="read-only"', ...WEB_OFF, ...BRIDGE_ARGS]);
    expect(p.settings).toEqual({
      sandbox_mode: "read-only",
      web_search: "disabled",
      features: FEATURES_OFF,
      mcp_servers: BRIDGE_SETTINGS,
    });
    expect(p.enforced).toEqual({
      readOnly: true,
      perPathWriteDeny: false,
      network: true,
      secretsUnreadable: false,
      readDeny: false,
    });
  });

  it("write-scoped roles and engineers run workspace-write with the network forced off; the engine checks the paths", () => {
    for (const tools of [WRITE_SCOPED, ENGINEER]) {
      const p = profile(tools);
      // set explicitly, so a user config.toml that opens the network or adds roots cannot widen it
      expect(p.cliArgs).toEqual([
        "--config",
        'sandbox_mode="workspace-write"',
        ...WEB_OFF,
        "--config",
        "sandbox_workspace_write.network_access=false",
        "--config",
        "sandbox_workspace_write.writable_roots=[]",
        ...BRIDGE_ARGS,
      ]);
      expect(p.settings).toEqual({
        sandbox_mode: "workspace-write",
        web_search: "disabled",
        features: FEATURES_OFF,
        sandbox_workspace_write: { network_access: false, writable_roots: [] },
        mcp_servers: BRIDGE_SETTINGS,
      });
      // Codex has no per-path read deny: the token and host credentials stay readable (D-ad)
      expect(p.enforced).toEqual({
        readOnly: false,
        perPathWriteDeny: false,
        network: true,
        secretsUnreadable: false,
        readDeny: false,
      });
    }
  });

  it("cannot enforce a replay trial's readDeny (no per-path read deny, reading 82): it says so and the profile is otherwise unchanged, so the trial records paths_only (D-cj)", () => {
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const plain = profile(tools);
      const denied = createCodexAdapter({ vtcHome: VTC_HOME, platform: "darwin" }).sandboxProfile({
        tools,
        cwd: CWD,
        writablePaths: ["src/**"],
        protectedPaths: ["test/acceptance/**"],
        network: "none",
        readDeny: ["/work/repo", "/work/repo/.git"],
      });
      expect(denied.enforced.readDeny).toBe(false);
      expect(denied.cliArgs).toEqual(plain.cliArgs);
      expect(denied.settings).toEqual(plain.settings);
    }
  });

  it("fails closed where the network-off sandbox is not shown to block a Unix-socket connect into the VTC home's run/ (D-an): the engine then refuses the run", () => {
    for (const platform of ["linux", "win32", "freebsd"] as const) {
      for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
        const p = createCodexAdapter({ vtcHome: VTC_HOME, platform }).sandboxProfile({
          tools,
          cwd: CWD,
          writablePaths: [],
          protectedPaths: [],
          network: "none",
        });
        // the sandbox still asks for no network, but the profile does not claim it is enforced
        expect(p.cliArgs).not.toContain("sandbox_workspace_write.network_access=true");
        expect(p.enforced.network).toBe(false);
        expect(p.enforced.secretsUnreadable).toBe(false);
        // the engine's guard (`roleSandboxProblem`) accepts only one of the two
        expect(p.enforced.secretsUnreadable === true || p.enforced.network).toBe(false);
      }
    }
  });

  it("reads the platform from the process by default", () => {
    for (const tools of [READ_ONLY, ENGINEER]) {
      const p = createCodexAdapter({ vtcHome: VTC_HOME }).sandboxProfile({
        tools,
        cwd: CWD,
        writablePaths: [],
        protectedPaths: [],
        network: "none",
      });
      expect(p.enforced.network).toBe(process.platform === "darwin");
    }
  });

  describe("host web search (H-3, D-cf, spine §5 readings 156 and 200)", () => {
    const ALL_TOOLS: readonly RoleTools[] = [
      READ_ONLY,
      WRITE_SCOPED,
      ENGINEER,
      { ...READ_ONLY, host_web: true },
      { ...WRITE_SCOPED, host_web: true },
      { ...READ_ONLY, host_web: false },
      { ...WRITE_SCOPED, engine_tools: ["research_fetch"], host_web: true },
    ];

    it("a host_web role gets the cached web search (CODEX_HOST_WEB_SEARCH), set explicitly, and nothing else changes", () => {
      expect(CODEX_HOST_WEB_SEARCH).toBe("cached");
      for (const tools of [
        { ...READ_ONLY, host_web: true },
        { ...WRITE_SCOPED, host_web: true },
      ]) {
        const p = profile(tools);
        expect(argAfter(p.cliArgs, "--config")).toMatch(/^sandbox_mode=/u);
        expect(p.cliArgs).toContain(`web_search="${CODEX_HOST_WEB_SEARCH}"`);
        expect(p.cliArgs).not.toContain('web_search="disabled"');
        expect(p.settings.web_search).toBe(CODEX_HOST_WEB_SEARCH);
        // the role's sandbox stays as it was: search runs on the host provider, not in the sandbox
        expect(p.cliArgs).not.toContain("sandbox_workspace_write.network_access=true");
        expect(p.cliArgs.filter((arg) => arg.startsWith("web_search="))).toHaveLength(1);
      }
    });

    it("every other role sets web search to disabled explicitly, as a top-level override", () => {
      for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER, { ...READ_ONLY, host_web: false }]) {
        const p = profile(tools);
        expect(p.cliArgs).toContain('web_search="disabled"');
        expect(p.settings.web_search).toBe("disabled");
        expect(p.cliArgs.filter((arg) => arg.startsWith("web_search="))).toHaveLength(1);
      }
    });

    it("no profile, settings or argv, fresh or resumed, ever names live web search (D-cf)", () => {
      const adapter = createCodexAdapter({
        vtcHome: VTC_HOME,
        platform: "darwin",
        scratchDir: scratch(),
      });
      for (const tools of ALL_TOOLS) {
        const p = profile(tools);
        const settings = JSON.stringify(p.settings);
        expect(settings).not.toMatch(/live/u);
        expect(p.cliArgs.join("\n")).not.toMatch(/live/u);
        // always explicit: a full-access sandbox would otherwise default to live
        expect(p.cliArgs.filter((arg) => /^web_search\s*=/u.test(arg))).toHaveLength(1);
        for (const session of [undefined, { host: "codex" as const, id: "thread-1" }]) {
          const args = adapter.headlessCommand(request({ sandbox: p }), session).args;
          expect(args.join("\n")).not.toMatch(/web_search\s*=\s*"?live/u);
          expect(args.filter((arg) => /^web_search\s*=/u.test(arg))).toHaveLength(1);
        }
      }
    });

    it("refuses a profile from anywhere else that asks for live or another mode, or sets web search twice or not at all (fail closed)", () => {
      const adapter = createCodexAdapter({
        vtcHome: VTC_HOME,
        platform: "darwin",
        scratchDir: scratch(),
      });
      const base = profile({ ...READ_ONLY, host_web: true });
      const swap = (to: readonly string[]) => {
        const index = base.cliArgs.indexOf(`web_search="${CODEX_HOST_WEB_SEARCH}"`);
        return {
          ...base,
          cliArgs: [...base.cliArgs.slice(0, index - 1), ...to, ...base.cliArgs.slice(index + 1)],
        };
      };
      for (const cliArgs of [
        ["--config", 'web_search="live"'],
        ["--config", "web_search=live"],
        ["--config", 'web_search = "live"'],
        ["--config", 'web_search="indexed"'],
        ["--config", 'web_search="cached"', "--config", 'web_search="live"'],
        // a legacy key or a profile, with no top-level mode at all
        ["--config", "tools.web_search=true"],
        ["--config", 'profile="x"'],
        [],
      ]) {
        expect(
          () => adapter.headlessCommand(request({ sandbox: swap(cliArgs) })),
          JSON.stringify(cliArgs),
        ).toThrow(/web search/u);
      }
      // beside the one allowed override: any other key that names web search, on any path, or
      // that picks or defines a profile whose layer could carry its own
      for (const extra of [
        "tools.web_search=true",
        "features.web_search_request=true",
        "features.web_search_cached=true",
        "features.Web_Search_Request = true",
        'profiles.x.web_search="live"',
        '"profiles"."x"."web_search"="live"',
        'profile="x"',
        "profiles={}",
        'profiles.x.model="o"',
      ]) {
        const cliArgs = ["--config", `web_search="${CODEX_HOST_WEB_SEARCH}"`, "--config", extra];
        expect(() => adapter.headlessCommand(request({ sandbox: swap(cliArgs) })), extra).toThrow(
          /web search/u,
        );
      }
    });

    it("every role run, host_web or not, fresh or resumed, turns off Codex's other routes to pages the model picks (apps connectors, browser and computer use)", () => {
      const adapter = createCodexAdapter({
        vtcHome: VTC_HOME,
        platform: "darwin",
        scratchDir: scratch(),
      });
      for (const tools of ALL_TOOLS) {
        const p = profile(tools);
        expect(p.settings.features).toEqual(FEATURES_OFF);
        for (const session of [undefined, { host: "codex" as const, id: "thread-1" }]) {
          const args = adapter.headlessCommand(request({ sandbox: p }), session).args;
          for (let i = 1; i < OTHER_WEB_OFF.length; i += 2) {
            expect(args).toContain(OTHER_WEB_OFF[i]);
          }
        }
      }
    });

    it("refuses a profile from anywhere else that leaves one of those routes on (fail closed)", () => {
      const adapter = createCodexAdapter({
        vtcHome: VTC_HOME,
        platform: "darwin",
        scratchDir: scratch(),
      });
      const base = profile({ ...READ_ONLY, host_web: true });
      for (const off of OTHER_WEB_OFF.filter((_, i) => i % 2 === 1)) {
        const at = base.cliArgs.indexOf(off);
        const sandbox = {
          ...base,
          cliArgs: [...base.cliArgs.slice(0, at - 1), ...base.cliArgs.slice(at + 1)],
        };
        expect(() => adapter.headlessCommand(request({ sandbox })), off).toThrow(/web/u);
        const flipped = {
          ...base,
          cliArgs: base.cliArgs.map((arg) => (arg === off ? off.replace("false", "true") : arg)),
        };
        expect(() => adapter.headlessCommand(request({ sandbox: flipped })), off).toThrow(/web/u);
      }
    });

    it("refuses host web search for a code_sandboxed role", () => {
      expect(() => profile({ ...ENGINEER, host_web: true })).toThrow(/code_sandboxed.*web/);
    });

    it("the headless command carries the profile's web search setting, fresh and resumed", () => {
      const adapter = createCodexAdapter({
        vtcHome: VTC_HOME,
        platform: "darwin",
        scratchDir: scratch(),
      });
      const sandbox = profile({ ...READ_ONLY, host_web: true });
      for (const session of [undefined, { host: "codex" as const, id: "thread-1" }]) {
        const args = adapter.headlessCommand(request({ sandbox }), session).args;
        expect(args).toContain('web_search="cached"');
        expect(findDisallowedHostArgs(args)).toEqual([]);
        expect(headlessIsolationGaps("codex", args)).toEqual([]);
      }
    });
  });

  it("refuses the registry network for every role: Codex could only open all of it, engine API included (D-ac)", () => {
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      expect(() => profile(tools, "registries")).toThrow(/registries network on Codex/);
    }
  });

  it("keeps the VTC home's denied directories unwritable: the sandbox writes only the worktree, so a worktree overlapping one is refused (D-w)", () => {
    const at =
      (vtcHome: string, tools: RoleTools, cwd = CWD) =>
      () =>
        createCodexAdapter({ vtcHome }).sandboxProfile({
          tools,
          cwd,
          writablePaths: [],
          protectedPaths: [],
          network: "none",
        });
    for (const tools of [WRITE_SCOPED, ENGINEER]) {
      expect(at(`${CWD}/.home/.vtc`, tools)).toThrow(/VTC home/);
      expect(at("/v", tools, "/v/hidden/T-1")).toThrow(/VTC home/);
      expect(at("/v", tools, "/v")).toThrow(/VTC home/);
      // D-ap: everything under the VTC home that is later run or trusted with full privileges
      for (const inside of [
        "/v/scanners/osv",
        "/v/claude-marketplace/plugins",
        "/v/plugins/0.1.0",
        "/v/engines",
        "/v/run",
        "/v/config.yaml",
        "/v/token",
        // spine §5 reading 103: the wave-3 directories (WAVE3_HOME_WRITE_DENY)
        ...WAVE3_HOME_WRITE_DENY.map((glob) => `/v/${glob.replace(/\/\*\*$/u, "")}/x`),
        "/v/research-cache",
        "/v/design-library",
        // contracts 4.12.0: the engine's private directory
        "/v/guard/repo-key/replays",
      ]) {
        expect(at("/v", tools, inside), inside).toThrow(/VTC home/);
      }
      // a repo whose own .vtc is the VTC home (a dotfiles repo at ~) keeps its worktrees writable
      expect(at(VTC_HOME, tools, `${VTC_HOME}/state/worktrees/T-1`)).not.toThrow();
    }
    // a reviewer writes nothing, wherever the VTC home is
    expect(() =>
      createCodexAdapter({ vtcHome: `${CWD}/.vtc-home` }).sandboxProfile({
        tools: READ_ONLY,
        cwd: CWD,
        writablePaths: [],
        protectedPaths: [],
        network: "none",
      }),
    ).not.toThrow();
  });

  it("drops the OS temp roots from the writable set when the VTC home lies under one (D-w)", () => {
    const request = (tools: RoleTools) => ({
      tools,
      cwd: CWD,
      writablePaths: [],
      protectedPaths: [],
      network: "none" as const,
    });
    const excluded = [
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
    ];
    for (const tools of [WRITE_SCOPED, ENGINEER]) {
      const p = codexSandboxProfile(request(tools), {
        vtcHome: "/scratch-tmp/vtc",
        tempRoots: ["/scratch-tmp"],
      });
      expect(p.cliArgs.slice(-4 - BRIDGE_ARGS.length, -BRIDGE_ARGS.length)).toEqual(excluded);
      expect(p.settings).toEqual({
        sandbox_mode: "workspace-write",
        web_search: "disabled",
        features: FEATURES_OFF,
        sandbox_workspace_write: {
          network_access: false,
          writable_roots: [],
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: true,
        },
        mcp_servers: BRIDGE_SETTINGS,
      });
      // a VTC home outside every temp root keeps the temp directory writable (D-ag)
      expect(
        codexSandboxProfile(request(tools), { vtcHome: VTC_HOME, tempRoots: ["/scratch-tmp"] })
          .cliArgs,
      ).not.toContain("sandbox_workspace_write.exclude_slash_tmp=true");
      // the real temp directory, as the adapter finds it
      expect(
        createCodexAdapter({ vtcHome: join(scratch(), "vtc") }).sandboxProfile(request(tools))
          .cliArgs,
      ).toEqual(expect.arrayContaining(excluded));
    }
    // a reviewer writes nothing, so it needs no exclusion
    expect(
      codexSandboxProfile(request(READ_ONLY), {
        vtcHome: "/scratch-tmp/vtc",
        tempRoots: ["/scratch-tmp"],
      }).cliArgs,
    ).toEqual(["--config", 'sandbox_mode="read-only"', ...WEB_OFF, ...BRIDGE_ARGS]);
  });

  it.skipIf(process.platform === "win32")(
    "compares real paths, so a symlinked worktree or VTC home cannot hide an overlap (D-w)",
    () => {
      const root = scratch();
      const vtcHome = join(root, "vtc");
      mkdirSync(join(vtcHome, "hidden", "T-1"), { recursive: true });
      symlinkSync(join(vtcHome, "hidden", "T-1"), join(root, "worktree-link"));
      const at = (home: string, cwd: string) => () =>
        createCodexAdapter({ vtcHome: home }).sandboxProfile({
          tools: ENGINEER,
          cwd,
          writablePaths: [],
          protectedPaths: [],
          network: "none",
        });
      expect(at(vtcHome, join(root, "worktree-link"))).toThrow(/VTC home/);
      const worktree = join(root, "repo", "wt");
      mkdirSync(join(worktree, "nested"), { recursive: true });
      symlinkSync(join(worktree, "nested"), join(root, "vtc-link"));
      expect(at(join(root, "vtc-link"), worktree)).toThrow(/VTC home/);
    },
  );

  it("records what Codex cannot express of the role deny list (D-w): no command deny for `vtc calibrate`, no per-path write deny", () => {
    // Gap: Codex has no per-command deny for a headless run, so `vtc calibrate` cannot be denied
    // here. Writes to <vtcHome>/{allowlists,osv-db,hidden} are blocked only because
    // workspace-write writes nothing outside the worktree (and the OS temp directory, D-ag).
    // `vtc calibrate` confirms in an interactive terminal only, and the engine never runs a role
    // with a terminal.
    expect(ROLE_DENIED_VTC.subcommands).toEqual(["calibrate", "lookback", "merge-level"]);
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const p = profile(tools);
      const text = JSON.stringify([p.cliArgs, p.settings]);
      for (const sub of ROLE_DENIED_VTC.subcommands) expect(text).not.toContain(`vtc ${sub}`);
      for (const glob of ROLE_DENIED_VTC.homeWriteDeny) expect(text).not.toContain(glob);
      expect(p.enforced.perPathWriteDeny).toBe(false);
    }
  });
});

describe("Codex headlessCommand", () => {
  it("runs codex exec --json with the sandbox, the schema file, the engine's model and the prompt on stdin", () => {
    const dir = scratch();
    const command = createCodexAdapter({ scratchDir: dir }).headlessCommand(request());
    expect(command.command).toBe("codex");
    expect(command.env).toEqual({});
    const args = command.args;
    // an explicit sandbox and no approval prompt nobody could answer (AD-25 rule 1)
    expect(args.slice(0, 4)).toEqual(["exec", "--sandbox", "read-only", "--json"]);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(argAfter(args, "-c")).toBe('approval_policy="never"');
    expect(headlessIsolationGaps("codex", args)).toEqual([]);
    // no automatic approver (AD-25 rule 2)
    expect(findDisallowedHostArgs(args)).toEqual([]);
    expect(argAfter(args, "--output-schema")).toMatch(
      new RegExp(`^${dir}/role-result-[0-9a-f]{16}\\.json$`),
    );
    expect(args).toContain('model_reasoning_effort="high"');
    // the engine resolves the model (AD-6 rule 2); the adapter never picks one
    expect(argAfter(args, "--model")).toBe("engine-model-id");
    expect(args.slice(-2)).toEqual(["--", "-"]);
    expect(args.join(" ")).not.toContain("Read the task pack");
    expect(findForbiddenHostArgs(args)).toEqual([]);
  });

  it("resumes the thread with codex exec resume (spike: works after 4h)", () => {
    const args = createCodexAdapter().headlessCommand(request(), {
      host: "codex",
      id: "thr-1",
    }).args;
    // `codex exec resume` (0.162.1) rejects --sandbox after `resume` but takes it as an option
    // of `exec` before it; the config override keeps the sandbox too (spine §7 "Codex resume
    // argv" confirms which one the resumed thread applies)
    expect(args.slice(0, 5)).toEqual(["exec", "--sandbox", "read-only", "resume", "--json"]);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(argAfter(args, "-c")).toBe('approval_policy="never"');
    expect(headlessIsolationGaps("codex", args)).toEqual([]);
    expect(args.slice(-3)).toEqual(["--", "thr-1", "-"]);
  });

  it("names the profile's own sandbox, fresh and resumed, for every tool profile (AD-25 rule 1)", () => {
    const adapter = createCodexAdapter({ vtcHome: VTC_HOME });
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      for (const [tools, mode] of [
        [READ_ONLY, "read-only"],
        [WRITE_SCOPED, "workspace-write"],
        [ENGINEER, "workspace-write"],
      ] as const) {
        const args = adapter.headlessCommand(request({ sandbox: profile(tools) }), session).args;
        expect(argAfter(args, "--sandbox")).toBe(mode);
        expect(args.indexOf("--sandbox")).toBe(1);
        expect(args).toContain(`sandbox_mode="${mode}"`);
        expect(headlessIsolationGaps("codex", args)).toEqual([]);
        expect(findDisallowedHostArgs(args)).toEqual([]);
      }
    }
  });

  it("refuses a profile whose sandbox is not read-only or workspace-write (fail closed)", () => {
    const sandbox = { ...profile(READ_ONLY), settings: { sandbox_mode: "full" } };
    expect(() => createCodexAdapter().headlessCommand(request({ sandbox }))).toThrow(
      /sandbox mode/,
    );
    const none = { ...profile(READ_ONLY), settings: {} };
    expect(() => createCodexAdapter().headlessCommand(request({ sandbox: none }))).toThrow(
      /sandbox mode/,
    );
  });

  it("runs on the session's default model with only the effort set when the engine resolved no id (D-ae)", () => {
    const adapter = ADAPTER_FACTORIES.codex!({ vtcHome: VTC_HOME });
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      const args = adapter.headlessCommand(
        request({ model: { tier: "mid", effort: "medium" } }),
        session,
      ).args;
      expect(args).not.toContain("--model");
      expect(args).not.toContain("-m");
      expect(args.some((a) => a.startsWith("model="))).toBe(false);
      expect(args).toContain('model_reasoning_effort="medium"');
    }
  });

  it("D-co interim: with no model id each routed tier still changes the run, through its effort only (TIER_EFFORT_WITHOUT_MODEL)", () => {
    const adapter = ADAPTER_FACTORIES.codex!({ vtcHome: VTC_HOME });
    const efforts = new Set<string>();
    for (const tier of ModelTierSchema.options) {
      for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
        const effort = TIER_EFFORT_WITHOUT_MODEL[tier];
        const args = adapter.headlessCommand(request({ model: { tier, effort } }), session).args;
        expect(args, tier).not.toContain("--model");
        expect(args, tier).not.toContain("-m");
        // exactly one effort override, the resolved one
        const set = args.filter((a) => a.startsWith("model_reasoning_effort="));
        expect(set, tier).toEqual([`model_reasoning_effort="${effort}"`]);
        expect(args[args.indexOf(set[0]!) - 1]).toBe("--config");
        efforts.add(set[0]!);
      }
    }
    expect(efforts.size).toBe(3);
  });

  it("D-co: once an id is resolved, every tier passes it as --model alongside its effort, fresh or resumed", () => {
    const adapter = createCodexAdapter({ vtcHome: VTC_HOME });
    for (const tier of ModelTierSchema.options) {
      for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
        const model = { tier, effort: "low" as const, model: `id-${tier}` };
        const args = adapter.headlessCommand(request({ model }), session).args;
        expect(
          args.filter((a) => a === "--model"),
          tier,
        ).toHaveLength(1);
        expect(argAfter(args, "--model"), tier).toBe(`id-${tier}`);
        expect(args, tier).toContain('model_reasoning_effort="low"');
        // before the `--` that ends the options
        expect(args.indexOf("--model")).toBeLessThan(args.indexOf("--"));
      }
    }
  });

  it("turns off `notify` for every role run, fresh or resumed, so no planted or user notify command runs outside the sandbox (D-ao)", () => {
    const adapter = createCodexAdapter({ vtcHome: VTC_HOME });
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
        const args = adapter.headlessCommand(request({ sandbox: profile(tools) }), session).args;
        const at = args.indexOf("notify=[]");
        expect(at).toBeGreaterThan(0);
        expect(args[at - 1]).toBe("--config");
        // an option, never after the `--` that ends them
        expect(at).toBeLessThan(args.indexOf("--"));
      }
    }
  });

  it("skips user and project execpolicy `.rules` for every role run, fresh or resumed, so no `allow` rule runs a command outside the sandbox (D-ao)", () => {
    const adapter = createCodexAdapter({ vtcHome: VTC_HOME });
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
        const args = adapter.headlessCommand(request({ sandbox: profile(tools) }), session).args;
        const at = args.indexOf("--ignore-rules");
        // `codex exec` and `codex exec resume` (0.162.1) both take it, as an option
        expect(at).toBeGreaterThan(args.indexOf(session === undefined ? "exec" : "resume"));
        expect(at).toBeLessThan(args.indexOf("--"));
        expect(findForbiddenHostArgs(args)).toEqual([]);
      }
    }
  });

  it("records what `codex exec --help` (0.162.1) offers no override for: project MCP servers (D-ao, spine §7)", () => {
    // Gap: `-c` sets one dotted key and its help does not say whether a table value replaces or
    // merges into the project layer, and no flag skips the project `.codex/config.toml`
    // (`--ignore-user-config` covers only `$CODEX_HOME/config.toml`). A blanket
    // `-c mcp_servers={}` would also drop the engine bridge `[mcp_servers.vtc]` that roles use
    // for engine tools, if it replaced the table. So no override names any server but the
    // engine bridge; the engine's pre-dispatch restore of `.codex/**` (spine §5 reading 72) keeps
    // a planted server from reaching the next start, and the §7 spike row settles the override.
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      const args = createCodexAdapter({ vtcHome: VTC_HOME }).headlessCommand(
        request(),
        session,
      ).args;
      const mcp = args.filter((a) => a.startsWith("mcp_servers"));
      expect(mcp.length).toBeGreaterThan(0);
      expect(mcp.every((a) => a.startsWith("mcp_servers.vtc."))).toBe(true);
      expect(args).not.toContain("--dangerously-bypass-hook-trust");
    }
  });

  it("keeps the human-only engine tools out of every role run, fresh or resumed, and enables only the role's engine tools (D-an)", () => {
    // `approval_policy="never"` lets every MCP call through unasked, and a role bridge's hello
    // looks like the Lead's: only the bridge filter keeps approve/answer/change_request/cancel out.
    // The keys were read back on codex-cli 0.162.1 through app-server `mcpServerStatus/list`.
    const adapter = createCodexAdapter({ vtcHome: VTC_HOME });
    const researcher: RoleTools = {
      ...READ_ONLY,
      engine_tools: ["research_fetch", "fact_lookup", "approve"],
    };
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER, researcher]) {
        const args = adapter.headlessCommand(request({ sandbox: profile(tools) }), session).args;
        const at = args.indexOf(
          'mcp_servers.vtc.disabled_tools=["approve", "answer", "change_request", "cancel"]',
        );
        expect(args[at - 1]).toBe("--config");
        expect(at).toBeGreaterThan(args.indexOf(session === undefined ? "exec" : "resume"));
        expect(at).toBeLessThan(args.indexOf("--"));
        // pinned to the entry `vtc install` writes, so the filter never names a server that is
        // not there (a filter key alone fails the config load with "invalid transport")
        expect(args).toContain('mcp_servers.vtc.command="vtc"');
        expect(args).toContain('mcp_servers.vtc.args=["engine", "--mcp", "--host", "codex"]');
        expect(args).toContain(
          tools === researcher
            ? 'mcp_servers.vtc.enabled_tools=["research_fetch", "fact_lookup"]'
            : "mcp_servers.vtc.enabled_tools=[]",
        );
        expect(findForbiddenHostArgs(args)).toEqual([]);
      }
    }
  });

  it("refuses a profile whose overrides do not disable the human-only engine tools (D-an)", () => {
    const sandbox = profile(READ_ONLY);
    const unfiltered = {
      ...sandbox,
      cliArgs: sandbox.cliArgs.filter(
        (a, i, all) => !a.includes("disabled_tools") && !all[i + 1]?.includes("disabled_tools"),
      ),
    };
    expect(unfiltered.cliArgs.length).toBe(sandbox.cliArgs.length - 2);
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      expect(() =>
        createCodexAdapter().headlessCommand(request({ sandbox: unfiltered }), session),
      ).toThrow(/human-only/);
    }
  });

  it("refuses a profile that passes anything but --config overrides, so no sandbox flag is repeated", () => {
    const sandbox = profile(READ_ONLY);
    for (const extra of [["--sandbox", "workspace-write"], ["--add-dir", "/"], ["--config"]]) {
      const widened = { ...sandbox, cliArgs: [...sandbox.cliArgs, ...extra] };
      expect(
        () => createCodexAdapter().headlessCommand(request({ sandbox: widened })),
        extra[0],
      ).toThrow(/sandbox profile may only pass/);
    }
  });

  it("refuses a replay arm's plugin directory: codex exec loads no compiled agent, so no copy could be proven (D-cg)", () => {
    const adapter = createCodexAdapter({
      vtcHome: VTC_HOME,
      platform: "darwin",
      scratchDir: scratch(),
    });
    expect(() =>
      adapter.headlessCommand(request({ pluginDir: "/users-dev/.vtc/guard/lookback/arms/t/b" })),
    ).toThrow(/plugin/u);
  });

  it("refuses another host's session", () => {
    expect(() =>
      createCodexAdapter().headlessCommand(request(), { host: "claude-code", id: "s" }),
    ).toThrow(/claude-code/);
  });
});

describe("Codex spawnRole", () => {
  it("a subagent dispatch is a foreground spawn_role with the base agent name", async () => {
    const result = await createCodexAdapter().spawnRole(
      request({ dispatch: "subagent", role: "qa", mode: "author" }),
    );
    expect(result).toEqual({
      dispatch: "subagent",
      instruction: {
        agent: "vtc-qa-author",
        prompt: "Read the task pack and follow it.",
        background: false,
      },
    });
    expect("subagentName" in createCodexAdapter()).toBe(false);
  });

  it("a headless run writes the schema file, sends the prompt on stdin and ends with the recorded outcome", async () => {
    const dir = scratch();
    const { spawner, processes } = codexFakeSpawner();
    const adapter = createCodexAdapter({ spawner, scratchDir: dir });
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    const proc = processes[0]!;
    expect(proc.command).toEqual(adapter.headlessCommand(request()));
    expect(proc.options).toEqual({ cwd: CWD, stdin: "pipe" });
    expect(await proc.stdinText()).toBe("Read the task pack and follow it.");
    const schemaPath = argAfter(proc.command.args, "--output-schema")!;
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(request().outputSchema);
    expect(statSync(schemaPath).mode & 0o077).toBe(0);
    proc.emit(...fixtureLines("codex/exec-output-schema-events.jsonl").filter((l) => l !== ""));
    proc.exit(0);
    const outcome = HostOutcomeSchema.parse(await spawned.run.wait());
    expect(outcome).toMatchObject({
      kind: "done",
      session_ref: { host: "codex", id: "<thread-id>" },
    });
    await adapter.dispose();
  });

  it("hands the run's request to the outcome: a refusal on stderr naming the id asked for ends model_refused (D-cx)", async () => {
    const { spawner, processes } = codexFakeSpawner();
    const adapter = createCodexAdapter({ spawner, scratchDir: scratch() });
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    const proc = processes[0]!;
    proc.writeStderr("Error: model 'engine-model-id' is not available on your current plan\n");
    proc.exit(1);
    const outcome = HostOutcomeSchema.parse(await spawned.run.wait());
    expect(outcome).toMatchObject({ kind: "error", retryable: true, cause: "model_refused" });
    await adapter.dispose();
  });

  it("a resumed run is supervised by the request's idle timeout and ends with cause idle (AD-25 rule 4)", async () => {
    const { spawner, processes } = codexFakeSpawner({
      onSpawn: (p) => {
        p.obeysInt = false;
      },
    });
    const adapter = createCodexAdapter({
      spawner,
      scratchDir: scratch(),
      interruptGraceMs: 10,
      killGraceMs: 10,
    });
    const session = { host: "codex" as const, id: "thr-1" };
    const resumed = await adapter.resume(session, request({ idleTimeoutMs: 30 }));
    if (resumed.dispatch !== "headless") throw new Error("expected a headless run");
    processes[0]!.emit(...fixtureLines("codex/exec-killed.jsonl").filter((l) => l !== ""));
    const outcome = HostOutcomeSchema.parse(await resumed.run.wait());
    expect(outcome).toMatchObject({ kind: "error", retryable: true, cause: "idle" });
    expect(processes[0]?.signals).toEqual(["SIGINT", "SIGTERM"]);
    await adapter.dispose();
  });
});

describe.skipIf(process.platform === "win32")("Codex scratch directory", () => {
  const spawnWith = async (scratchDir: string) => {
    const { spawner } = codexFakeSpawner({
      onSpawn: (p) => {
        p.exit(0);
      },
    });
    const adapter = createCodexAdapter({ spawner, scratchDir });
    try {
      await adapter.spawnRole(request());
    } finally {
      await adapter.dispose();
    }
  };

  it("creates a missing scratch directory private (0700)", async () => {
    const dir = join(scratch(), "nested");
    await spawnWith(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("defaults to <vtcHome>/run/codex, which no role can write, never the OS temp directory (D-w)", async () => {
    const vtcHome = scratch();
    const { spawner, processes } = codexFakeSpawner({
      onSpawn: (p) => {
        p.exit(0);
      },
    });
    const adapter = createCodexAdapter({ spawner, vtcHome });
    try {
      await adapter.spawnRole(request());
    } finally {
      await adapter.dispose();
    }
    const schemaPath = argAfter(processes[0]!.command.args, "--output-schema")!;
    expect(schemaPath.startsWith(join(vtcHome, "run", "codex") + "/")).toBe(true);
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(request().outputSchema);
    expect(statSync(join(vtcHome, "run", "codex")).mode & 0o777).toBe(0o700);
  });

  it("never writes the schema through a link planted at its path: the link's target is untouched", async () => {
    const dir = scratch();
    const victim = join(scratch(), "victim");
    writeFileSync(victim, "keep me");
    const schemaPath = argAfter(
      createCodexAdapter({ scratchDir: dir }).headlessCommand(request()).args,
      "--output-schema",
    )!;
    symlinkSync(victim, schemaPath);
    await expect(spawnWith(dir)).rejects.toThrow(/not a regular file/);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(lstatSync(schemaPath).isSymbolicLink()).toBe(true);
    // a dangling link is refused as well, and nothing is created where it points
    rmSync(victim);
    await expect(spawnWith(dir)).rejects.toThrow(/not a regular file/);
    expect(() => statSync(victim)).toThrow();
  });

  it("refuses a scratch directory others can reach, or a link planted in its place", async () => {
    const open = join(scratch(), "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    await expect(spawnWith(open)).rejects.toThrow(/not a private directory/);
    const link = join(scratch(), "link");
    symlinkSync(scratch(), link);
    await expect(spawnWith(link)).rejects.toThrow(/not a private directory/);
  });
});
