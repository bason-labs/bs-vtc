import { describe, expect, it } from "vitest";
import {
  GatesConfigSchema,
  GateSchema,
  ProjectConfigSchema,
  ScannerPinSchema,
  ScannerPinsSchema,
} from "../src/index.js";
import { COMMIT, SHA, validGatesConfig, validProjectConfig } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("ProjectConfigSchema", () => {
  it("fills every spec default from { version: 1 }", () => {
    const config = expectValid(ProjectConfigSchema, validProjectConfig());
    expect(config).toEqual({
      version: 1,
      merge_level: 2,
      caps: { low: 3, med: 4, high: 5 },
      budgets: { task_usd: { S: 1.5, M: 5, L: 15 }, final_review_share: 0.15 },
      risk_rules: { paths: [], max_diff_lines: 800, max_diff_files: 30 },
      allowlists: { dependencies: [], licenses: [] },
      hosts: { dispatch: "plugin_only", cross_family_review: false },
      concurrency: 2,
      usage: { reserve_pct: 10 },
      auto_merge: { block_severity: "medium" },
    });
  });
  it("accepts a fully specified config", () => {
    expectValid(ProjectConfigSchema, {
      version: 1,
      client: "acme",
      track_default: "feature",
      merge_level: 3,
      caps: { low: 3, med: 3, high: 5 },
      budgets: { task_usd: { S: 2, M: 6, L: 20 }, final_review_share: 0.2 },
      risk_rules: { paths: ["src/billing/**"], max_diff_lines: 500, max_diff_files: 20 },
      allowlists: { dependencies: ["zod"], licenses: ["MIT", "Apache-2.0"] },
      hosts: {
        preferred: "codex",
        dispatch: "headless_allowed",
        cross_family_review: true,
        models: { "claude-code": { top: "claude-opus-5-5" } },
      },
      concurrency: 3,
      usage: { reserve_pct: 15 },
      auto_merge: { block_severity: "low" },
    });
  });
  it.each([
    ["version", { version: 2 }],
    ["merge_level", { merge_level: 4 }],
    ["merge_level", { merge_level: "2" }],
    ["caps.high", { caps: { high: 6 } }],
    ["caps.low", { caps: { low: 2 } }],
    ["concurrency", { concurrency: 4 }],
    ["concurrency", { concurrency: 0 }],
    ["budgets.final_review_share", { budgets: { final_review_share: 1 } }],
    ["budgets.task_usd.S", { budgets: { task_usd: { S: 0 } } }],
    ["risk_rules.paths.0", { risk_rules: { paths: ["/etc/**"] } }],
    ["hosts.preferred", { hosts: { preferred: "cursor" } }],
    ["hosts.dispatch", { hosts: { dispatch: "headless" } }],
    ["usage.reserve_pct", { usage: { reserve_pct: 101 } }],
    ["track_default", { track_default: "epic" }],
    ["caps", { caps: { mid: 4 } }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(ProjectConfigSchema, { version: 1, ...patch }, path);
  });
});

describe("GatesConfigSchema", () => {
  it("accepts calibrated gates and applies gate defaults", () => {
    const config = expectValid(GatesConfigSchema, validGatesConfig());
    const typecheck = config.gates.find((g) => g.id === "typecheck");
    expect(typecheck).toMatchObject({ phase: "verify", timeout_s: 900, blocking: true });
  });
  it.each([
    ["gates", { gates: [] }],
    [
      "gates",
      {
        gates: [
          { id: "a", layer: "L0", command: ["x"] },
          { id: "a", layer: "L1", command: ["y"] },
        ],
      },
    ],
    ["", { scanners: [] }],
    [
      "baseline.revision",
      { baseline: { revision: "HEAD", calibrated_at: "2026-10-13T00:00:00Z", confirmed: true } },
    ],
    [
      "baseline.confirmed",
      { baseline: { revision: COMMIT, calibrated_at: "2026-10-13T00:00:00Z" } },
    ],
    [
      "baseline.revision",
      {
        baseline: { revision: "abcdef1", calibrated_at: "2026-10-13T00:00:00Z", confirmed: true },
      },
    ],
    ["sources.0", { sources: ["vibes"] }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(GatesConfigSchema, { ...validGatesConfig(), ...patch }, path);
  });
});

describe("GateSchema", () => {
  it.each([
    ["command", { id: "a", layer: "L0", command: [] }],
    ["command", { id: "a", layer: "L0", command: "pnpm test" }],
    ["blocking", { id: "a", layer: "L2", command: ["x"], blocking: false }],
    ["layer", { id: "a", layer: "L7", command: ["x"] }],
    ["phase", { id: "a", layer: "L0", command: ["x"], phase: "deploy" }],
    ["timeout_s", { id: "a", layer: "L0", command: ["x"], timeout_s: 0 }],
    [
      "report.format",
      { id: "a", layer: "L2", command: ["x"], report: { format: "xml", path: "r.xml" } },
    ],
    ["cwd", { id: "a", layer: "L0", command: ["x"], cwd: "../" }],
  ])("rejects invalid %s", (path, gate) => {
    expectInvalid(GateSchema, gate, path);
  });
  it("allows warn-only L6 checks", () => {
    expectValid(GateSchema, {
      id: "fitness",
      layer: "L6",
      command: ["depcruise", "src"],
      blocking: false,
    });
  });
});

describe("ScannerPinsSchema (product gates/scanners.json)", () => {
  const pin = () => ({
    name: "gitleaks",
    version: "8.30.0",
    url: "https://github.com/gitleaks/gitleaks/releases/download/v{version}/gitleaks_{platform}.tar.gz",
    sha256: { "darwin-arm64": SHA, "linux-x64": "b".repeat(64) },
    license: "MIT",
  });
  it("pins a checksum per platform", () => {
    expectValid(ScannerPinsSchema, { version: 1, scanners: [pin()] });
  });
  it.each([
    ["sha256", { sha256: {} }],
    ["sha256", { sha256: { "solaris-sparc": SHA } }],
    ["sha256.linux-x64", { sha256: { "linux-x64": "nope" } }],
    ["url", { url: "http://example.com/{platform}" }],
    ["url", { url: "https://example.com/gitleaks.tar.gz" }],
    ["license", { license: "" }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(ScannerPinSchema, { ...pin(), ...patch }, path);
  });
  it("rejects duplicate pins", () => {
    expectInvalid(ScannerPinsSchema, { version: 1, scanners: [pin(), pin()] }, "scanners");
  });
});
