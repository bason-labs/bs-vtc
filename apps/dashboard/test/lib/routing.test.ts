import { describe, expect, it } from "vitest";
import {
  ModelTierSchema,
  TaskDetailSchema,
  TierHintReasonSchema,
  TierReasonSchema,
  type RoleRunSummary,
  type TaskDetail,
} from "@vtc/shared";
import {
  roleRunTier,
  taskRouting,
  TIER_HINT_REASON_LABELS,
  TIER_LABELS,
  TIER_REASON_LABELS,
  tierHintView,
} from "@/lib/routing";
import { readFixture } from "../fixtures";

/**
 * The starting tier of each role run and why (H-9, D-cm; spine §5 reading 218(6)): the task view
 * reads `RoleRunSummary.tier` / `tier_reason` / `tier_clamped` and the task's Planner hint.
 */
const golden = (): TaskDetail => TaskDetailSchema.parse(readFixture("task-T-1"));

/** The golden T-1 with its role runs changed, checked against the contract. */
const withRuns = (
  runs: readonly Partial<RoleRunSummary>[],
  task: Partial<TaskDetail["task"]> = {},
): TaskDetail => {
  const base = golden();
  const [first] = base.role_runs;
  if (first === undefined) throw new Error("the golden T-1 has no role run");
  return TaskDetailSchema.parse({
    ...base,
    task: { ...base.task, ...task },
    role_runs: runs.map((r, i) => ({ ...first, action_id: `a-${String(i + 1)}`, ...r })),
  });
};

describe("tier labels", () => {
  it("names every tier, tier reason and hint reason", () => {
    for (const t of ModelTierSchema.options) expect(TIER_LABELS[t]).not.toBe("");
    for (const r of TierReasonSchema.options) expect(TIER_REASON_LABELS[r]).not.toBe("");
    for (const r of TierHintReasonSchema.options) expect(TIER_HINT_REASON_LABELS[r]).not.toBe("");
  });
});

describe("roleRunTier", () => {
  it("says the tier a run started on and why", () => {
    const [run] = withRuns([{ tier: "low", tier_reason: "rule" }]).role_runs;
    expect(roleRunTier(run!)).toEqual({
      tier: "Low",
      reason: TIER_REASON_LABELS.rule,
      clamped: null,
    });
  });

  it("says when the project's routing clamped it", () => {
    const [run] = withRuns([
      { tier: "mid", tier_reason: "planner_hint", tier_clamped: true },
    ]).role_runs;
    expect(roleRunTier(run!)).toMatchObject({
      tier: "Mid",
      reason: TIER_REASON_LABELS.planner_hint,
      clamped: "clamped by project routing",
    });
    const [unclamped] = withRuns([
      { tier: "top", tier_reason: "escalation", tier_clamped: false },
    ]).role_runs;
    expect(roleRunTier(unclamped!)?.clamped).toBeNull();
  });

  it("shows nothing for a run logged before 5.4.0 (no tier)", () => {
    expect(roleRunTier(golden().role_runs[0]!)).toBeNull();
  });
});

describe("tierHintView", () => {
  it("shows the Planner's hint with its reason code and detail", () => {
    expect(
      tierHintView({
        tier: "top",
        reason: "concurrency",
        detail: "The token refresh races the logout.",
      }),
    ).toEqual({
      tier: "Top",
      code: "concurrency",
      reason: TIER_HINT_REASON_LABELS.concurrency,
      detail: "The token refresh races the logout.",
    });
    expect(tierHintView({ tier: "low", reason: "docs_or_config" })?.detail).toBeNull();
    expect(tierHintView(undefined)).toBeNull();
  });
});

describe("taskRouting", () => {
  it("lists every run with a tier in dispatch order, and the hint", () => {
    const detail = withRuns(
      [
        { tier: "mid", tier_reason: "escalation", dispatched_at: "2026-10-13T10:00:00.000Z" },
        {},
        { tier: "low", tier_reason: "rule", dispatched_at: "2026-10-13T09:00:00.000Z" },
        {
          role: "qa",
          mode: "author",
          tier: "mid",
          tier_reason: "rule",
          tier_clamped: true,
          dispatched_at: "2026-10-13T09:30:00.000Z",
        },
      ],
      { tier_hint: { tier: "low", reason: "mechanical" } },
    );
    const routing = taskRouting(detail);
    expect(routing.runs.map((r) => [r.action, r.role, r.tier.tier])).toEqual([
      ["a-3", "engineer", "Low"],
      ["a-4", "qa (author)", "Mid"],
      ["a-1", "engineer", "Mid"],
    ]);
    expect(routing.runs[1]?.tier.clamped).toBe("clamped by project routing");
    expect(routing.hint?.code).toBe("mechanical");
  });

  it("is empty for a task with neither a hint nor a routed run", () => {
    expect(taskRouting(golden())).toEqual({ hint: null, runs: [] });
  });
});
