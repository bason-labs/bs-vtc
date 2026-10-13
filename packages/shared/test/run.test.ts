import { describe, expect, it } from "vitest";
import { HumanGateStateSchema, PHASES, RunSchema } from "../src/index.js";
import { NOW, SHA } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

const run = () => ({
  id: "run-2026-10-13",
  track: "feature",
  repo: "existing",
  has_ui: true,
  risk_hints: ["auth"],
  phase: "build",
  gates: {
    G1: {
      status: "approved",
      frozen: [{ path: ".vtc/spec/spec.md", sha256: SHA }],
      decided_at: NOW,
    },
    G2: { status: "pending" },
  },
  paused: false,
  merge_level_effective: 2,
  started_at: NOW,
  pipeline_config_hash: SHA,
});

describe("PHASES", () => {
  it("is the §6.1 backbone in order", () => {
    expect(PHASES).toEqual([
      "intake",
      "discover",
      "specify",
      "g1",
      "design",
      "g2",
      "plan",
      "build",
      "integrate",
      "final_review",
      "release",
      "retro",
    ]);
  });
});

describe("RunSchema", () => {
  it("accepts a run in BUILD", () => {
    expectValid(RunSchema, run());
  });
  it.each([
    ["phase", { phase: "deploy" }],
    ["repo", { repo: "fork" }],
    ["merge_level_effective", { merge_level_effective: 4 }],
    ["pipeline_config_hash", { pipeline_config_hash: "x" }],
    ["gates.G2", { gates: { G1: { status: "pending" } } }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(RunSchema, { ...run(), ...patch }, path);
  });
});

describe("HumanGateStateSchema", () => {
  it("an approval freezes at least one artifact; pending has no decision time", () => {
    expectInvalid(HumanGateStateSchema, { status: "approved" }, "frozen");
    expectInvalid(HumanGateStateSchema, { status: "pending", decided_at: NOW }, "decided_at");
    expectValid(HumanGateStateSchema, { status: "rejected", decided_at: NOW });
  });
});
