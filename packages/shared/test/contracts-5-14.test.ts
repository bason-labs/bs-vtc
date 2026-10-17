/**
 * Contracts 5.14.0 (MINOR; spine §5 reading 271): autopilot. A run on autopilot is asked for on
 * `start` or in the project config, recorded on `run.started`, and the engine's own decisions are
 * marked on `escalation.answered` and `gate.approved`; `status` counts them.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  EVENT_PAYLOAD_SCHEMAS,
  ProjectConfigSchema,
  StartInputSchema,
  StatusResultSchema,
} from "../src/index.js";

describe("contracts 5.14.0", () => {
  it("is MINOR over 5.13.0", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });

  it("start and the project config take autopilot; absent is off", () => {
    const start = {
      request: "Fix it",
      track: "quick_fix",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    };
    expect(StartInputSchema.parse({ ...start, autopilot: true }).autopilot).toBe(true);
    expect(StartInputSchema.parse(start).autopilot).toBeUndefined();
    expect(StartInputSchema.safeParse({ ...start, autopilot: "yes" }).success).toBe(false);
    expect(ProjectConfigSchema.parse({ version: 1, autopilot: true }).autopilot).toBe(true);
    expect(ProjectConfigSchema.parse({ version: 1 }).autopilot).toBeUndefined();
  });

  it("the run and the engine's decisions say autopilot, only as true", () => {
    const answered = EVENT_PAYLOAD_SCHEMAS["escalation.answered"];
    const answer = { option: "web", who_should_have_caught: "none" };
    expect(answered.safeParse({ escalation: "E-1", answer, autopilot: true }).success).toBe(true);
    expect(answered.safeParse({ escalation: "E-1", answer, autopilot: false }).success).toBe(false);
    const approved = EVENT_PAYLOAD_SCHEMAS["gate.approved"];
    const frozen = [{ path: ".vtc/spec/a.md", sha256: "a".repeat(64) }];
    expect(approved.safeParse({ gates: ["G1", "G2"], frozen, autopilot: true }).success).toBe(true);
    expect(EVENT_PAYLOAD_SCHEMAS["run.started"].shape.autopilot.safeParse(true).success).toBe(true);
  });

  it("status counts the decisions", () => {
    const shape = StatusResultSchema.shape.autopilot;
    expect(shape.safeParse({ decisions: 2 }).success).toBe(true);
    expect(shape.safeParse({ decisions: -1 }).success).toBe(false);
  });
});
