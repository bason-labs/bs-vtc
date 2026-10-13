import { describe, expect, it } from "vitest";
import {
  ENGINE_INSTANCE,
  engineDiscoveryFile,
  EngineDiscoverySchema,
  engineRepoKey,
  normalizeRepoRoot,
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
  const discovery = () => ({
    v: 1,
    pid: 4242,
    port: 47615,
    mcp_socket: "/Users/me/work/app/.vtc/state/engine.sock",
    repo_root: "/Users/me/work/app",
    started_at: NOW,
    engine_version: "0.0.0",
    contracts_version: "2.0.0",
  });
  it("validates the discovery file; it never carries the token", () => {
    expectValid(EngineDiscoverySchema, discovery());
    expectInvalid(EngineDiscoverySchema, { ...discovery(), token: "x" }, "");
    expectInvalid(EngineDiscoverySchema, { ...discovery(), port: 0 }, "port");
    expectInvalid(
      EngineDiscoverySchema,
      { ...discovery(), contracts_version: "2" },
      "contracts_version",
    );
  });
});
