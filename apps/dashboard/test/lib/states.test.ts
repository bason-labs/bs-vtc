import { describe, expect, it } from "vitest";
import {
  FeatureStatusSchema,
  ParkReasonSchema,
  PHASES,
  TaskStatusSchema,
  WorkflowNodeStateSchema,
} from "@vtc/shared";
import {
  featureStatusMeta,
  nodeStateMeta,
  PARK_REASON_LABELS,
  parkText,
  PHASE_LABELS,
  taskStatusMeta,
} from "@/lib/states";

describe("state labels cover every contract value", () => {
  it("node states", () => {
    for (const state of WorkflowNodeStateSchema.options) {
      expect(nodeStateMeta({ state, round: 1, cap: 4, park_reason: "cap" }).label).not.toBe("");
    }
  });
  it("task, feature, phase and park reasons", () => {
    for (const s of TaskStatusSchema.options)
      expect(taskStatusMeta({ status: s, round: 2, cap: 4 }).label).not.toBe("");
    for (const s of FeatureStatusSchema.options)
      expect(featureStatusMeta({ status: s, round: 1 }).label).not.toBe("");
    expect(Object.keys(PHASE_LABELS).sort()).toEqual([...PHASES].sort());
    expect(Object.keys(PARK_REASON_LABELS).sort()).toEqual([...ParkReasonSchema.options].sort());
  });
});

describe("nodeStateMeta", () => {
  it("shows looping with its round and cap", () => {
    expect(nodeStateMeta({ state: "looping", round: 2, cap: 4 })).toMatchObject({
      label: "Looping 2/4",
      tone: "warn",
    });
  });
  it("shows parked with its reason, and the risk rule that fired", () => {
    expect(nodeStateMeta({ state: "parked", park_reason: "cap" }).label).toBe("Parked: round cap");
    expect(
      nodeStateMeta({ state: "parked", park_reason: "risk_rule", risk_rule: "sensitive_area" })
        .label,
    ).toBe("Parked: risk rule (sensitive area)");
  });
  it("shows a usage-limit interruption as waiting for the limit, never as passed", () => {
    expect(nodeStateMeta({ state: "interrupted" })).toMatchObject({
      label: "Waiting for limit",
      tone: "warn",
    });
  });
  it("marks running as live", () => {
    expect(nodeStateMeta({ state: "running" })).toMatchObject({ live: true, tone: "accent" });
  });
});

describe("taskStatusMeta / featureStatusMeta / parkText", () => {
  it("shows fixing as n/cap and final review fixing as n/3", () => {
    expect(taskStatusMeta({ status: "fixing", round: 3, cap: 4 }).label).toBe("Fixing 3/4");
    expect(featureStatusMeta({ status: "fixing", round: 2 }).label).toBe("Fixing 2/3");
  });
  it("describes a park", () => {
    expect(parkText("gate_infra")).toBe("gate infrastructure");
    expect(parkText("risk_rule", "committed_secret")).toBe("risk rule (committed secret)");
  });
});
