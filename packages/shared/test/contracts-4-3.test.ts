/**
 * Contracts 4.3.0: the hardening round (spine §5 readings 69–78, Lead decisions D-al..D-au).
 */
import { describe, expect, it } from "vitest";
import {
  claudeSessionSandboxSettings,
  claudeSessionSandboxState,
  VTC_HOME_SHELL_SPELLINGS,
  CODEX_IN_SESSION_REFUSED_REASON,
  CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS,
  ENGINE_INSTANCE,
  ENGINE_MCP_TOOLS,
  EngineSocketHelloSchema,
  EVENT_PAYLOAD_SCHEMAS,
  GATE_SANDBOX,
  GateReportSchema,
  GATES_CONFIG_FILE,
  gatesAllowUnsandboxed,
  gatesConfigNotCommitted,
  findForbiddenHostArgs,
  HIDDEN_TESTS,
  HOME_CREDENTIAL_LOCATIONS,
  hostConfigDirsOf,
  hostCredentialDenyReadPaths,
  HUMAN_ONLY_TOOLS,
  humanChannelRequired,
  inSessionDispatchAllowed,
  inSessionDispatchRefusal,
  isHumanOnlyTool,
  parsePersisted,
  PROJECT_CONFIG_FILE,
  projectConfigNotCommitted,
  ProjectConfigSchema,
  REPO_ROLE_DENIED,
  ROLE_DENIED_VTC,
  ScannerPinSchema,
  SESSION_SANDBOX_OFF_REASON,
  STATUSLINE_TEE,
  USER_CONFIG_FILE,
  UserConfigSchema,
} from "../src/index.js";
import { COMMIT, SHA, validGateReport } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

const TOKEN = "A".repeat(43);
const HOME = "/home/u/.vtc";

describe("ROLE_DENIED_VTC (D-ap, D-an)", () => {
  it("write-denies everything under the VTC home that later runs or is trusted with full privileges", () => {
    for (const glob of [
      "scanners/**",
      "claude-marketplace/**",
      "plugins/**",
      `${ENGINE_INSTANCE.discoveryDir}/**`,
      `${ENGINE_INSTANCE.socketDir}/**`,
      USER_CONFIG_FILE,
      ENGINE_INSTANCE.tokenFile,
    ]) {
      expect(ROLE_DENIED_VTC.homeWriteDeny).toContain(glob);
    }
  });
  it("read-denies the install token, the sockets and the hidden tests", () => {
    expect([...ROLE_DENIED_VTC.homeReadDeny].sort()).toEqual(
      [
        ENGINE_INSTANCE.tokenFile,
        `${ENGINE_INSTANCE.socketDir}/**`,
        `${HIDDEN_TESTS.homeDir}/**`,
      ].sort(),
    );
  });
  it("uses only relative globs a host rule can carry", () => {
    for (const glob of [...ROLE_DENIED_VTC.homeWriteDeny, ...ROLE_DENIED_VTC.homeReadDeny]) {
      expect(glob).toMatch(/^[a-z][a-z0-9.-]*(\/\*\*)?$/);
    }
  });
});

describe("the Lead session's Claude sandbox (D-an)", () => {
  const SCOPE = {
    projectRoot: "/work/app",
    homeDir: "/home/u",
    hostConfigDirs: hostConfigDirsOf({}, "/home/u"),
  };
  it("builds absolute deny paths from the VTC home", () => {
    const { sandbox } = claudeSessionSandboxSettings(`${HOME}/`, SCOPE);
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining([`${HOME}/token`, `${HOME}/run`, `${HOME}/hidden`]),
    );
    expect(sandbox.filesystem.denyWrite).toEqual(
      expect.arrayContaining([`${HOME}/token`, `${HOME}/config.yaml`, `${HOME}/scanners`]),
    );
    expect(sandbox.filesystem.denyWrite).toHaveLength(
      ROLE_DENIED_VTC.homeWriteDeny.length + REPO_ROLE_DENIED.writeDeny.length,
    );
    expect(() => claudeSessionSandboxSettings(".vtc", SCOPE)).toThrow(TypeError);
    expect(() => claudeSessionSandboxSettings(HOME, { ...SCOPE, projectRoot: "app" })).toThrow(
      TypeError,
    );
  });
  it("denies reading the host credential files and home credential stores (reading 79)", () => {
    const { denyRead } = claudeSessionSandboxSettings(HOME, SCOPE).sandbox.filesystem;
    expect(denyRead).toEqual(
      expect.arrayContaining([
        ...hostCredentialDenyReadPaths(SCOPE.hostConfigDirs),
        "/home/u/.ssh",
        "/home/u/.aws",
        "/home/u/.npmrc",
        "/home/u/.netrc",
      ]),
    );
    expect(denyRead).toHaveLength(
      ROLE_DENIED_VTC.homeReadDeny.length +
        hostCredentialDenyReadPaths(SCOPE.hostConfigDirs).length +
        HOME_CREDENTIAL_LOCATIONS.length +
        REPO_ROLE_DENIED.readDeny.length,
    );
    // a relocated host config directory is where its credential file is denied
    const moved = hostConfigDirsOf({ CLAUDE_CONFIG_DIR: "/cfg/claude", CODEX_HOME: "rel" }, "/h");
    expect(moved).toEqual({ "claude-code": "/cfg/claude", codex: "/h/.codex" });
    expect(
      claudeSessionSandboxSettings(HOME, { ...SCOPE, hostConfigDirs: moved }).sandbox.filesystem
        .denyRead,
    ).toEqual(expect.arrayContaining(hostCredentialDenyReadPaths(moved)));
    // the settings carry credential paths only in the sanctioned deny list (AD-9, D-ad)
    expect(
      findForbiddenHostArgs([JSON.stringify(claudeSessionSandboxSettings(HOME, SCOPE))]),
    ).toEqual([]);
  });
  it("denies roles the engine's gate checkouts and raw gate output, and writes to the run config", () => {
    const { denyRead, denyWrite } = claudeSessionSandboxSettings(HOME, SCOPE).sandbox.filesystem;
    expect(denyRead).toEqual(
      expect.arrayContaining(["/work/app/.vtc/state/checkouts", "/work/app/.vtc/state/gates"]),
    );
    expect(denyWrite).toEqual(
      expect.arrayContaining([
        "/work/app/.vtc/state/checkouts",
        "/work/app/.vtc/state/gates",
        "/work/app/.vtc/project.yaml",
        "/work/app/.vtc/gates.yml",
      ]),
    );
    // role worktrees stay writable
    expect(denyWrite.some((p) => p.startsWith("/work/app/.vtc/state/worktrees"))).toBe(false);
    expect(denyWrite).not.toContain("/work/app/.vtc/state");
  });
  it("denies the file tools every path the sandbox denies the shell (reading 81)", () => {
    const { sandbox, permissions } = claudeSessionSandboxSettings(HOME, SCOPE);
    // the sandbox confines shell commands only; Read/Edit/Write follow permission rules
    for (const path of sandbox.filesystem.denyRead) {
      expect(permissions.deny, path).toContain(`Read(/${path})`);
    }
    for (const path of sandbox.filesystem.denyWrite) {
      expect(permissions.deny, path).toContain(`Edit(/${path})`);
      expect(permissions.deny, path).toContain(`Edit(/${path}/**)`);
    }
    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        `Read(/${HOME}/token)`,
        "Read(//home/u/.ssh)",
        "Read(//home/u/.ssh/**)",
        "Read(//home/u/.config/gh/**)",
        "Read(//work/app/.vtc/state/checkouts/**)",
        "Edit(//work/app/.vtc/project.yaml)",
        "Bash(vtc calibrate)",
        "Bash(vtc calibrate *)",
        "Bash(*~/.vtc/token*)",
        "Bash(*$VTC_HOME/run*)",
      ]),
    );
    // a credential file is named only as a single-file rule (the D-ad exemption's form)
    for (const file of hostCredentialDenyReadPaths(SCOPE.hostConfigDirs)) {
      expect(permissions.deny).toContain(`Read(/${file})`);
      expect(permissions.deny).not.toContain(`Read(/${file}/**)`);
    }
    // every rule is absolute (`//`), a Bash rule, never relative to the settings file
    for (const rule of permissions.deny) expect(rule).toMatch(/^(Read\(\/\/|Edit\(\/\/|Bash\()/);
    expect(new Set(permissions.deny).size).toBe(permissions.deny.length);
  });
  it("denies shell commands that name a guarded VTC home path, by every spelling, and not the project's .vtc/", () => {
    // Claude Code Bash rules: `*` is any text; a trailing ` *` that is the only `*` also matches
    // the bare command.
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = (rule: string, command: string): boolean => {
      const body = /^Bash\((.*)\)$/.exec(rule)?.[1];
      if (body === undefined) return false;
      if (body.endsWith(" *") && body.indexOf("*") === body.length - 1) {
        return new RegExp(`^${escape(body.slice(0, -2))}( .*)?$`).test(command);
      }
      return new RegExp(`^${body.split("*").map(escape).join(".*")}$`).test(command);
    };
    const { deny } = claudeSessionSandboxSettings(HOME, SCOPE).permissions;
    const denied = (command: string): boolean => deny.some((rule) => matches(rule, command));
    expect(VTC_HOME_SHELL_SPELLINGS).toEqual([
      "~/.vtc",
      "$HOME/.vtc",
      "${HOME}/.vtc",
      "$VTC_HOME",
      "${VTC_HOME}",
    ]);
    for (const command of [
      "cat ~/.vtc/token",
      "base64 < $HOME/.vtc/token",
      "nc -U ~/.vtc/run/abc.sock",
      'echo \'{"client":"cli"}\' | socat - UNIX-CONNECT:${HOME}/.vtc/run/abc.sock',
      "echo '{}' > ~/.vtc/allowlists/k.json",
      "cp evil ~/.vtc/scanners/semgrep/semgrep",
      "sed -i s/a/b/ $VTC_HOME/config.yaml",
      "rm -rf ${VTC_HOME}/osv-db",
      "tee ~/.vtc/claude-marketplace/plugins/vtc/hooks/hooks.json",
      "vtc calibrate",
      "vtc calibrate --yes",
    ]) {
      expect(denied(command), command).toBe(true);
    }
    for (const command of ["pnpm test", "cat .vtc/config.yaml", "ls .vtc/runs", "vtc status"]) {
      expect(denied(command), command).toBe(false);
    }
  });
  it("is on only when every key and path is there", () => {
    const wanted = claudeSessionSandboxSettings(HOME, SCOPE);
    expect(claudeSessionSandboxState(wanted, HOME, SCOPE)).toEqual({ state: "on", missing: [] });
    expect(
      claudeSessionSandboxState(
        {
          ...wanted,
          permissions: { allow: [], deny: ["Bash(x)", ...wanted.permissions.deny] },
          other: 1,
        },
        HOME,
        SCOPE,
      ).state,
    ).toBe("on");
    const off = claudeSessionSandboxState(
      { ...wanted, sandbox: { ...wanted.sandbox, enabled: false } },
      HOME,
      SCOPE,
    );
    expect(off).toEqual({ state: "off", missing: ["sandbox.enabled"] });
    const escape = claudeSessionSandboxState(
      { ...wanted, sandbox: { ...wanted.sandbox, allowUnsandboxedCommands: true } },
      HOME,
      SCOPE,
    );
    expect(escape.missing).toEqual(["sandbox.allowUnsandboxedCommands"]);
    const partial = claudeSessionSandboxState(
      {
        ...wanted,
        sandbox: {
          ...wanted.sandbox,
          filesystem: {
            ...wanted.sandbox.filesystem,
            denyRead: wanted.sandbox.filesystem.denyRead.filter(
              (p) => p !== `${HOME}/run` && p !== `${HOME}/hidden` && p !== "/home/u/.ssh",
            ),
          },
        },
      },
      HOME,
      SCOPE,
    );
    expect(partial.state).toBe("off");
    expect(partial.missing).toEqual([`${HOME}/run`, `${HOME}/hidden`, "/home/u/.ssh"]);
    // settings written before reading 79 (VTC-home denies only) read as off
    const older = {
      ...wanted,
      sandbox: {
        ...wanted.sandbox,
        filesystem: {
          denyRead: ROLE_DENIED_VTC.homeReadDeny.map((g) => `${HOME}/${g.replace("/**", "")}`),
          denyWrite: ROLE_DENIED_VTC.homeWriteDeny.map((g) => `${HOME}/${g.replace("/**", "")}`),
        },
      },
    };
    expect(claudeSessionSandboxState(older, HOME, SCOPE).state).toBe("off");
    // settings written before reading 81 (sandbox lists only, no file-tool rules) read as off
    const sandboxOnly = { sandbox: wanted.sandbox };
    const before81 = claudeSessionSandboxState(sandboxOnly, HOME, SCOPE);
    expect(before81.state).toBe("off");
    expect(before81.missing).toEqual(wanted.permissions.deny);
    expect(claudeSessionSandboxState(null, HOME, SCOPE).state).toBe("unknown");
    expect(claudeSessionSandboxState("{}", HOME, SCOPE).state).toBe("unknown");
    expect(claudeSessionSandboxState({}, HOME, SCOPE).state).toBe("off");
  });
  it("gates every role on the Lead session's settings, and refuses Codex roles in-session (readings 81, 82)", () => {
    for (const profile of ["read_only", "write_scoped", "code_sandboxed"] as const) {
      expect(inSessionDispatchAllowed("claude-code", profile, "on", "linux")).toBe(true);
      for (const state of ["off", "unknown", undefined] as const) {
        // the file-tool deny rules live in the session settings, not in the agent: no profile
        // runs without them
        expect(inSessionDispatchRefusal("claude-code", profile, state, "darwin")).toBe(
          SESSION_SANDBOX_OFF_REASON,
        );
      }
      // a Codex agent inherits the Lead session's sandbox and network, which VTC cannot confirm
      for (const state of ["on", "off", "unknown", undefined] as const) {
        for (const platform of ["darwin", "linux", "win32", undefined]) {
          expect(inSessionDispatchRefusal("codex", profile, state, platform)).toBe(
            CODEX_IN_SESSION_REFUSED_REASON,
          );
        }
      }
    }
    expect(CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS).toEqual(["darwin"]);
    expect(SESSION_SANDBOX_OFF_REASON).toContain("vtc install --host claude-code");
    expect(CODEX_IN_SESSION_REFUSED_REASON).toMatch(/cannot narrow them/);
    // F7: the only remedy in v1 is a Claude Code Lead; no per-family host setting exists
    // (project.yaml `hosts` has none) and the engine launches no headless runs (reading 93)
    expect(CODEX_IN_SESSION_REFUSED_REASON).not.toMatch(/hosts\.dispatch/);
    expect(CODEX_IN_SESSION_REFUSED_REASON).not.toMatch(/project\.yaml/);
    expect(CODEX_IN_SESSION_REFUSED_REASON).toMatch(/a Codex Lead can run no roles in v1/);
    expect(CODEX_IN_SESSION_REFUSED_REASON).toContain("vtc install --host claude-code");
    expect(CODEX_IN_SESSION_REFUSED_REASON).toMatch(/run the Lead in Claude Code/);
  });
  it("a run starts only on a committed project.yaml (reading 79)", () => {
    expect(PROJECT_CONFIG_FILE).toBe(".vtc/project.yaml");
    expect(projectConfigNotCommitted(COMMIT)).toBe(
      `.vtc/project.yaml differs from the copy committed at ${COMMIT.slice(0, 12)}: commit the change (or undo it), then start the run again`,
    );
  });
});

describe("the human channel (D-an)", () => {
  const hello = { v: 1, client: "cli", host: null, contracts_version: "4.3.0" } as const;
  it("names the human-only tools, all of them engine tools", () => {
    expect([...HUMAN_ONLY_TOOLS]).toEqual(["approve", "answer", "change_request"]);
    const names: readonly string[] = ENGINE_MCP_TOOLS.map((t) => t.name);
    for (const tool of HUMAN_ONLY_TOOLS) expect(names).toContain(tool);
    expect(isHumanOnlyTool("approve")).toBe(true);
    expect(isHumanOnlyTool("pause")).toBe(false);
    expect(humanChannelRequired("approve")).toMatch(/^approve records a human decision/);
  });
  it("lets only the cli carry the install token and only a bridge report its sandbox", () => {
    expectValid(EngineSocketHelloSchema, hello);
    expectValid(EngineSocketHelloSchema, { ...hello, install_token: TOKEN });
    expectInvalid(EngineSocketHelloSchema, { ...hello, install_token: "short" }, "install_token");
    const bridge = { ...hello, client: "bridge", host: "claude-code" } as const;
    expectValid(EngineSocketHelloSchema, { ...bridge, session_sandbox: "on" });
    expectInvalid(EngineSocketHelloSchema, { ...bridge, install_token: TOKEN }, "install_token");
    expectInvalid(EngineSocketHelloSchema, { ...hello, session_sandbox: "on" }, "session_sandbox");
    expectInvalid(
      EngineSocketHelloSchema,
      { ...bridge, session_sandbox: "maybe" },
      "session_sandbox",
    );
  });
});

describe("the gate sandbox (D-al)", () => {
  it("records the sandbox a gate report ran in", () => {
    for (const sandbox of ["sandbox-exec", "bwrap", "none"]) {
      expect(expectValid(GateReportSchema, { ...validGateReport(), sandbox }).sandbox).toBe(
        sandbox,
      );
    }
    expect(expectValid(GateReportSchema, validGateReport()).sandbox).toBeUndefined();
    expectInvalid(GateReportSchema, { ...validGateReport(), sandbox: "docker" }, "sandbox");
    expect(GATE_SANDBOX.noSandboxReason).toBe("no OS sandbox for gates");
  });
  it("is switched off only in the user-level config, never in project.yaml", () => {
    expect(gatesAllowUnsandboxed(UserConfigSchema.parse({ version: 1 }))).toBe(false);
    expect(UserConfigSchema.parse({ version: 1, gates: {} }).gates).toEqual({
      allow_unsandboxed: false,
    });
    expect(
      gatesAllowUnsandboxed(
        UserConfigSchema.parse({ version: 1, gates: { allow_unsandboxed: true } }),
      ),
    ).toBe(true);
    expectInvalid(UserConfigSchema, { version: 1, gates: { allow: true } }, "gates");
    expectInvalid(ProjectConfigSchema, { version: 1, gates: { allow_unsandboxed: true } });
  });
  it("an older reader of config.yaml drops the new key", () => {
    const older = UserConfigSchema.omit({ gates: true });
    const read = parsePersisted(older, { version: 1, gates: { allow_unsandboxed: true } });
    expect(read).toMatchObject({ success: true, data: { version: 1, env_passthrough: [] } });
  });
  it("records restored host config and unsandboxed gate runs as incidents", () => {
    const incident = EVENT_PAYLOAD_SCHEMAS["incident.recorded"];
    for (const kind of ["host_config_restored", "unsandboxed_gate"]) {
      expectValid(incident, { kind, detail: "x" });
    }
  });
});

describe("scanner pins anchor the extracted binary (D-ap)", () => {
  const pin = () => ({
    name: "gitleaks",
    version: "8.30.0",
    url: "https://github.com/gitleaks/gitleaks/releases/download/v{version}/gitleaks_{platform}.tar.gz",
    sha256: { "darwin-arm64": SHA },
    license: "MIT",
  });
  it("takes a binary checksum per platform that has a download checksum", () => {
    expectValid(ScannerPinSchema, pin());
    expectValid(ScannerPinSchema, { ...pin(), binary_sha256: { "darwin-arm64": SHA } });
    expectInvalid(
      ScannerPinSchema,
      { ...pin(), binary_sha256: { "linux-x64": SHA } },
      "binary_sha256.linux-x64",
    );
    expectInvalid(
      ScannerPinSchema,
      { ...pin(), binary_sha256: { "darwin-arm64": "nope" } },
      "binary_sha256.darwin-arm64",
    );
  });
});

describe("statusline shim and run start refusals (D-as, D-au)", () => {
  it("prints a visible line when misconfigured and exits EX_USAGE", () => {
    expect(STATUSLINE_TEE.usageExit).toBe(64);
    expect(STATUSLINE_TEE.misconfiguredLine).toBe("vtc: statusline misconfigured — run vtc doctor");
    expect(STATUSLINE_TEE.misconfiguredLine).not.toContain("\n");
  });
  it("says to calibrate and commit gates.yml", () => {
    const text = gatesConfigNotCommitted(COMMIT);
    expect(GATES_CONFIG_FILE).toBe(".vtc/gates.yml");
    expect(text).toContain(COMMIT.slice(0, 12));
    expect(text).toContain("vtc calibrate");
    expect(text).toContain(`commit ${GATES_CONFIG_FILE}`);
  });
});
