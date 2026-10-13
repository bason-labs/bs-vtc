import { describe, expect, it } from "vitest";
import {
  contractsCompatible,
  encodeSocketLine,
  ENGINE_INSTANCE,
  ENGINE_SOCKET,
  EngineSocketHelloSchema,
  EngineSocketWelcomeSchema,
  engineDiscoveryFile,
  EngineDiscoverySchema,
  engineRepoKey,
  engineSocketFile,
  engineWindowsPipe,
  fitsUnixSocketPath,
  normalizeRepoRoot,
  UNIX_SOCKET_MAX_BYTES,
} from "../src/index.js";
import { NOW } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("engine instance (AD-12)", () => {
  it("keys a repo by its normalised absolute root", () => {
    const key = engineRepoKey("/Users/me/work/app");
    expect(key).toMatch(/^[a-f0-9]{16}$/);
    expect(engineRepoKey("/Users/me/work/app/")).toBe(key);
    expect(engineRepoKey("/Users/me/work/other")).not.toBe(key);
    expect(engineRepoKey("C:\\work\\app")).toBe(engineRepoKey("C:/work/app"));
    expect(engineDiscoveryFile("/Users/me/work/app")).toBe(`engines/${key}.json`);
  });
  it("refuses relative repo roots", () => {
    expect(() => normalizeRepoRoot("work/app")).toThrow();
    expect(normalizeRepoRoot("/")).toBe("/");
  });
  it("keeps the lock under the gitignored state directory", () => {
    expect(ENGINE_INSTANCE.lockFile.startsWith(".vtc/state/")).toBe(true);
  });
  it("names the install token file under the VTC home, never in the repo (AD-5 rule 2)", () => {
    expect(ENGINE_INSTANCE.tokenFile).toBe("token");
    expect(ENGINE_INSTANCE.tokenFile.startsWith(".vtc")).toBe(false);
  });
  const discovery = () => ({
    v: 1,
    pid: 4242,
    port: 47615,
    prototype_port: null,
    mcp_socket: "/Users/me/.vtc/run/0123456789abcdef.sock",
    repo_root: "/Users/me/work/app",
    started_at: NOW,
    engine_version: "0.0.0",
    contracts_version: "4.0.0",
  });
  it("validates the discovery file; it never carries the token", () => {
    expectValid(EngineDiscoverySchema, discovery());
    expectInvalid(EngineDiscoverySchema, { ...discovery(), token: "x" }, "");
    expectInvalid(EngineDiscoverySchema, { ...discovery(), port: 0 }, "port");
    expectInvalid(
      EngineDiscoverySchema,
      { ...discovery(), prototype_port: 70000 },
      "prototype_port",
    );
    expectInvalid(
      EngineDiscoverySchema,
      { ...discovery(), contracts_version: "2" },
      "contracts_version",
    );
  });
  it("puts the MCP socket under ~/.vtc/run/, short enough for sun_path at any repo depth", () => {
    const deep = `/Users/me/${"very-long-directory-name/".repeat(12)}app`;
    const file = engineSocketFile(deep);
    expect(file).toBe(`run/${engineRepoKey(deep)}.sock`);
    expect(file.length).toBe(25);
    // a typical home leaves plenty of room below the 104-byte macOS limit
    expect(fitsUnixSocketPath(`/Users/some.long.user.name/.vtc/${file}`)).toBe(true);
    expect(UNIX_SOCKET_MAX_BYTES).toBeLessThan(104);
    expect(fitsUnixSocketPath(`${deep}/.vtc/state/engine.sock`)).toBe(false);
    expect(engineWindowsPipe("C:/work/app")).toBe(
      `\\\\.\\pipe\\vtc-${engineRepoKey("C:/work/app")}`,
    );
  });
});

describe("local socket protocol (AD-12 rule 3)", () => {
  const hello = () => ({ v: 1, client: "bridge", host: "codex", contracts_version: "4.0.0" });
  it("is newline-delimited JSON-RPC, like MCP stdio", () => {
    expect(ENGINE_SOCKET).toMatchObject({ framing: "ndjson", protocol: "jsonrpc-2.0" });
    const line = encodeSocketLine(hello());
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expectValid(EngineSocketHelloSchema, JSON.parse(line));
  });
  it("a bridge tags its session with its host; the cli names none", () => {
    expectValid(EngineSocketHelloSchema, { ...hello(), client: "cli", host: null });
    expectInvalid(EngineSocketHelloSchema, { ...hello(), host: null }, "host");
    expectInvalid(EngineSocketHelloSchema, { ...hello(), client: "cli" }, "host");
    expectInvalid(EngineSocketHelloSchema, { ...hello(), host: "cursor" }, "host");
    expectInvalid(EngineSocketHelloSchema, { ...hello(), token: "x" }, "");
  });
  it("the daemon welcomes or refuses with a reason; MAJOR versions must match", () => {
    const welcome = { v: 1, ok: true, engine_version: "0.0.0", contracts_version: "4.0.0" };
    expectValid(EngineSocketWelcomeSchema, welcome);
    expectValid(EngineSocketWelcomeSchema, { ...welcome, ok: false, error: "upgrade vtc" });
    expectInvalid(EngineSocketWelcomeSchema, { ...welcome, ok: false }, "error");
    expectInvalid(EngineSocketWelcomeSchema, { ...welcome, error: "x" }, "error");
    expect(contractsCompatible("4.0.0", "4.2.1")).toBe(true);
    expect(contractsCompatible("4.0.0", "3.9.0")).toBe(false);
  });
});
