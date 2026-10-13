import { describe, expect, it } from "vitest";
import {
  TaskDetailSchema,
  WorkflowGraphSchema,
  type TaskDetail,
  type WorkflowNode,
} from "@vtc/shared";
import { nodeDrawerModel } from "@/lib/flows/drawer";
import { readFixture } from "../../fixtures";

const detail = (): TaskDetail => TaskDetailSchema.parse(readFixture("task-T-2"));
const node = (id: string): WorkflowNode =>
  WorkflowGraphSchema.parse(readFixture("graph-task-T-2")).nodes.find((n) => n.id === id)!;

describe("nodeDrawerModel", () => {
  it("gives a role node its own findings, the task round and the role", () => {
    const m = nodeDrawerModel(node("spec-verifier"), detail());
    expect(m.role).toBe("spec_verifier");
    expect(m.round).toBe("4/4");
    expect(m.findings.map((f) => f.rule_id)).toEqual(["reset.expiry-not-checked"]);
    expect(m.evidence).toEqual(["file_line: src/t-2/reset.ts:31"]);
  });
  it("gives a role node with no findings none", () => {
    expect(nodeDrawerModel(node("engineer"), detail()).findings).toEqual([]);
  });
  it("gives the loop guard every open finding, its own round/cap and the escalation", () => {
    const m = nodeDrawerModel(node("loop-guard"), detail());
    expect(m.round).toBe("4/4");
    expect(m.findings).toHaveLength(1);
    expect(m.escalations.map((e) => e.id)).toEqual(["E-1"]);
    expect(m.parked).toBe("round cap");
  });
  it("gives gate nodes tool findings and gate reports", () => {
    const m = nodeDrawerModel(node("gates"), detail());
    expect(m.findings).toEqual([]);
    expect(m.gateReports).toEqual([]);
  });
  it("points at the transcript without serving it (it stays in .vtc/state/)", () => {
    const t1 = TaskDetailSchema.parse(readFixture("task-T-1"));
    const m = nodeDrawerModel({ ...node("engineer"), task: "T-1" }, t1);
    expect(m.transcript).toEqual({
      session: "claude-code session sess-t1",
      location: ".vtc/state/",
    });
    expect(nodeDrawerModel(node("engineer"), detail()).transcript.session).toBeNull();
  });
  it("works before the task detail has loaded", () => {
    const m = nodeDrawerModel(node("loop-guard"), null);
    expect(m.round).toBe("4/4");
    expect(m.findings).toEqual([]);
  });
});
