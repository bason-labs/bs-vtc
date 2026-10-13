import { describe, expect, it } from "vitest";
import { EscalationListSchema, type Escalation } from "@vtc/shared";
import { escalationModel, sortEscalations } from "@/lib/escalations";
import { readFixture } from "../fixtures";

const golden = (): Escalation =>
  EscalationListSchema.parse(readFixture("escalations")).escalations[0]!;

describe("escalationModel", () => {
  it("describes scope, reason, options with the recommended one, evidence and blocked tasks", () => {
    const m = escalationModel(golden());
    expect(m.scope).toBe("Task T-2");
    expect(m.reason).toBe("round cap");
    expect(m.options).toEqual([
      { id: "hint", label: "Give the Engineer a hint", effect: "hint", recommended: true },
      {
        id: "budget",
        label: "Raise the budget 1.5x",
        effect: "raise budget ×1.5",
        recommended: false,
      },
    ]);
    expect(m.evidence).toEqual(["file_line: src/t-2/reset.ts:31"]);
    expect(m.blocks).toEqual(["T-2"]);
    expect(m.answer).toBeNull();
  });
  it("shows the answer once given", () => {
    const answered: Escalation = {
      ...golden(),
      answer: { option: "hint", text: "check expiry", who_should_have_caught: "qa" },
      answered_at: "2026-10-13T10:00:00.000Z",
    };
    expect(escalationModel(answered).answer).toEqual({
      option: "Give the Engineer a hint",
      text: "check expiry",
      caughtBy: "qa",
      at: "2026-10-13T10:00:00.000Z",
    });
  });
  it("names run-phase and feature scopes and risk rules", () => {
    const e = golden();
    expect(escalationModel({ ...e, task: undefined, phase: "specify" }).scope).toBe(
      "Run phase Specify",
    );
    expect(escalationModel({ ...e, task: undefined, feature: "F-1" }).scope).toBe("Feature F-1");
    expect(escalationModel({ ...e, task: "T-1", feature: "F-1" }).scope).toBe(
      "Task T-1 · Feature F-1",
    );
    expect(escalationModel({ ...e, reason: "risk_rule", risk_rule: "db_migration" }).reason).toBe(
      "risk rule (db migration)",
    );
  });
});

describe("sortEscalations", () => {
  it("lists open ones first (oldest first), then answered (newest first)", () => {
    const e = golden();
    const open2 = { ...e, id: "E-2", created_at: "2026-10-13T09:50:00.000Z" };
    const done = (id: string, at: string): Escalation => ({
      ...e,
      id,
      answer: { option: "hint", who_should_have_caught: "none" },
      answered_at: at,
    });
    const sorted = sortEscalations([
      done("E-3", "2026-10-13T10:00:00.000Z"),
      open2,
      done("E-4", "2026-10-13T11:00:00.000Z"),
      e,
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["E-1", "E-2", "E-4", "E-3"]);
  });
});
