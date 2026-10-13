/**
 * Contracts 4.3.0: the hardening round (spine §5 readings 69–78, Lead decisions D-al..D-au).
 */
import { describe, expect, it } from "vitest";
import {
  claudeSessionSandboxSettings,
  claudeSessionSandboxState,
  ENGINE_INSTANCE,
  ENGINE_MCP_TOOLS,
  EngineSocketHelloSchema,
  EVENT_PAYLOAD_SCHEMAS,
  GATE_SANDBOX,
  GateReportSchema,
  GATES_CONFIG_FILE,
  gatesAllowUnsandboxed,
  gatesConfigNotCommitted,
  HIDDEN_TESTS,
  HUMAN_ONLY_TOOLS,
  humanChannelRequired,
  inSessionDispatchAllowed,
  isHumanOnlyTool,
  parsePersisted,
  ProjectConfigSchema,
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
  it("builds absolute deny paths from the VTC home", () => {
    const { sandbox } = claudeSessionSandboxSettings(`${HOME}/`);
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining([`${HOME}/token`, `${HOME}/run`, `${HOME}/hidden`]),
    );
    expect(sandbox.filesystem.denyWrite).toEqual(
      expect.arrayContaining([`${HOME}/token`, `${HOME}/config.yaml`, `${HOME}/scanners`]),
    );
    expect(sandbox.filesystem.denyWrite).toHaveLength(ROLE_DENIED_VTC.homeWriteDeny.length);
    expect(() => claudeSessionSandboxSettings(".vtc")).toThrow(TypeError);
  });
  it("is on only when every key and path is there", () => {
    const wanted = claudeSessionSandboxSettings(HOME);
    expect(claudeSessionSandboxState(wanted, HOME)).toEqual({ state: "on", missing: [] });
    expect(
      claudeSessionSandboxState({ permissions: { allow: [] }, ...wanted, other: 1 }, HOME).state,
    ).toBe("on");
    const off = claudeSessionSandboxState({ sandbox: { ...wanted.sandbox, enabled: false } }, HOME);
    expect(off).toEqual({ state: "off", missing: ["sandbox.enabled"] });
    const escape = claudeSessionSandboxState(
      { sandbox: { ...wanted.sandbox, allowUnsandboxedCommands: true } },
      HOME,
    );
    expect(escape.missing).toEqual(["sandbox.allowUnsandboxedCommands"]);
    const partial = claudeSessionSandboxState(
      {
        sandbox: {
          ...wanted.sandbox,
          filesystem: { ...wanted.sandbox.filesystem, denyRead: [`${HOME}/token`] },
        },
      },
      HOME,
    );
    expect(partial.state).toBe("off");
    expect(partial.missing).toEqual([`${HOME}/run`, `${HOME}/hidden`]);
    expect(claudeSessionSandboxState(null, HOME).state).toBe("unknown");
    expect(claudeSessionSandboxState("{}", HOME).state).toBe("unknown");
    expect(claudeSessionSandboxState({}, HOME).state).toBe("off");
  });
  it("gates only code-running roles in a Claude Code Lead session", () => {
    expect(inSessionDispatchAllowed("claude-code", "code_sandboxed", "on")).toBe(true);
    for (const state of ["off", "unknown", undefined] as const) {
      expect(inSessionDispatchAllowed("claude-code", "code_sandboxed", state)).toBe(false);
      expect(inSessionDispatchAllowed("claude-code", "write_scoped", state)).toBe(true);
      expect(inSessionDispatchAllowed("codex", "code_sandboxed", state)).toBe(true);
    }
    expect(SESSION_SANDBOX_OFF_REASON).toContain("vtc install --host claude-code");
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
