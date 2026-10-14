import { describe, expect, it } from "vitest";
import {
  AutoMergeStateSchema,
  MergePreflightFailureSchema,
  PullRequestRefSchema,
  RequiredCheckStateSchema,
} from "@vtc/shared";
import { pullRequestModel } from "@/lib/feature";
import {
  AUTO_MERGE_STATES,
  featureLevel3,
  finalReviewStepRows,
  mergePreflight,
  PREFLIGHT_FIXES,
  REQUIRED_CHECK_STATES,
} from "@/lib/level3";
import { LEVEL3_EVENTS, SHA, w3Event } from "../wave3-fixtures";

describe("mergePreflight (merge.preflight, AD-23 rule 1)", () => {
  it("says the run merges at Level 2 and what to configure", () => {
    const p = mergePreflight(LEVEL3_EVENTS)!;
    expect(p).toMatchObject({ configured: 3, effective: 2, ok: false });
    expect(p.fixes).toEqual([
      PREFLIGHT_FIXES.no_required_checks,
      PREFLIGHT_FIXES.auto_merge_disallowed,
    ]);
    expect(p.policy).toEqual([
      "Base main",
      "Auto-merge not allowed",
      "No required checks",
      "Merge methods: squash",
    ]);
  });

  it("is null without a preflight, and names every failure", () => {
    expect(mergePreflight([])).toBeNull();
    for (const f of MergePreflightFailureSchema.options) expect(PREFLIGHT_FIXES[f]).not.toBe("");
  });
});

describe("featureLevel3", () => {
  const model = featureLevel3(LEVEL3_EVENTS, "F-1");

  it("shows the latest safe-to-auto-merge checklist with each item's evidence", () => {
    expect(model.checklist?.ok).toBe(false);
    expect(model.checklist?.items.map((i) => [i.id, i.ok])).toEqual([
      ["final_review", false],
      ["reviewers", true],
      ["coverage", true],
      ["test_integrity", true],
      ["risk_rules", true],
      ["waivers", true],
      ["remote_ci", true],
    ]);
    expect(model.checklist?.items[0]?.detail).toMatch(/visual skipped/);
    expect(model.checklist?.items[6]?.evidence).toEqual(["url: https://github.com/o/r/pull/7"]);
  });

  it("lists the auto-merge, post-merge CI and revert events newest first", () => {
    expect(model.timeline.map((t) => [t.title, t.tone])).toEqual([
      ["Merge reverted on the base branch", "danger"],
      ["Base CI after the merge: red", "danger"],
      ["Auto-merge turned off: the PR head moved past the gated commit", "warn"],
      ["Auto-merge enabled on PR #7", "accent"],
    ]);
    expect(model.timeline[0]?.detail).toMatch(/dddddddd.*git log/);
    expect(model.timeline[1]?.detail).toBe("Failed required runs: ci / test");
    expect(model.timeline[3]?.detail).toBe("squash, bound to the gated commit bbbbbbbb");
  });

  it("ignores other features", () => {
    expect(featureLevel3(LEVEL3_EVENTS, "F-2")).toEqual({ checklist: null, timeline: [] });
  });
});

describe("finalReviewStepRows (final_review.step_finished, §6.7a)", () => {
  const rows = finalReviewStepRows(LEVEL3_EVENTS, "F-1");

  it("shows all seven steps, the latest result of each", () => {
    expect(rows.map((r) => r.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows[0]).toMatchObject({ name: "Full gates", passed: true });
    expect(rows[0]?.evidence).toEqual(["file: .vtc/evidence/F-1/gates.json"]);
    expect(rows[2]).toMatchObject({ status: null, passed: false });
  });

  it("shows skipped and unchecked steps as not passed, with the reason", () => {
    expect(rows[4]).toMatchObject({
      name: "Visual QA on full user journeys",
      passed: false,
      reason: "no browser for the visual gates",
    });
    expect(rows[4]?.status?.label).toBe("Not passed: skipped");
    expect(rows[1]?.status).toMatchObject({ label: "Not passed: unchecked", tone: "danger" });
  });

  it("takes a re-run's result over the earlier one", () => {
    const rerun = w3Event(
      90,
      "final_review.step_finished",
      { step: 5, status: "pass" },
      {
        feature: "F-1",
      },
    );
    expect(finalReviewStepRows([...LEVEL3_EVENTS, rerun], "F-1")[4]?.passed).toBe(true);
  });
});

describe("pullRequestModel (Level 3 fields of PullRequestRef)", () => {
  const base = {
    url: "https://github.com/o/r/pull/7",
    draft: false,
    state: "open",
    head_sha: SHA("b"),
    ci: "pending",
  };
  const pr = PullRequestRefSchema.parse({
    ...base,
    number: 7,
    auto_merge: "awaiting_review",
    required_checks: [
      { name: "ci / test", state: "success" },
      { name: "ci / lint", state: "pending" },
    ],
    merge_state_status: "BLOCKED",
  });

  it("shows the PR number, auto-merge state, required checks and GitHub's merge state", () => {
    const m = pullRequestModel(pr);
    expect(m.number).toBe("#7");
    expect(m.autoMerge?.label).toBe("Awaiting an approving review");
    expect(m.requiredChecks.map((c) => [c.name, c.status.label])).toEqual([
      ["ci / test", "Success"],
      ["ci / lint", "Pending"],
    ]);
    expect(m.mergeState).toBe("BLOCKED");
  });

  it("names every auto-merge and required-check state", () => {
    for (const s of AutoMergeStateSchema.options) expect(AUTO_MERGE_STATES[s].label).not.toBe("");
    for (const s of RequiredCheckStateSchema.options)
      expect(REQUIRED_CHECK_STATES[s].label).not.toBe("");
  });

  it("leaves the Level 3 fields empty for an older PR record", () => {
    const m = pullRequestModel(PullRequestRefSchema.parse(base));
    expect(m).toMatchObject({
      number: null,
      autoMerge: null,
      requiredChecks: [],
      mergeState: null,
    });
  });
});
