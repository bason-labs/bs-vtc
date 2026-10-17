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
import { SHA } from "../dev-samples";
import { firstSample, LEVEL3_VARIANTS, SAMPLE_EVENTS, variant } from "../golden-samples";

const { failedPreflight, failedChecklist, postMergeRed, reverted } = LEVEL3_VARIANTS;
const unchecked = variant(firstSample("final_review.step_finished"), 34, {
  status: "unchecked",
  reason: "hidden tests did not start",
  evidence: [],
});

describe("mergePreflight (merge.preflight, AD-23 rule 1)", () => {
  it("shows the golden run's passing preflight with its policy", () => {
    const p = mergePreflight(SAMPLE_EVENTS)!;
    expect(p).toMatchObject({ configured: 3, effective: 3, ok: true, fixes: [] });
    expect(p.policy).toEqual([
      "Base main",
      "Auto-merge allowed",
      "Required checks: ci",
      "Merge methods: squash",
    ]);
  });

  it("says the run merges at Level 2 and what to configure", () => {
    const p = mergePreflight([...SAMPLE_EVENTS, failedPreflight])!;
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
  const golden = featureLevel3(SAMPLE_EVENTS, "F-1");
  const model = featureLevel3([...SAMPLE_EVENTS, failedChecklist, postMergeRed, reverted], "F-1");

  it("shows the golden run's checklist, every item holding", () => {
    expect(golden.checklist?.ok).toBe(true);
    expect(golden.checklist?.items.map((i) => [i.id, i.ok])).toEqual([
      ["final_review", true],
      ["reviewers", true],
      ["coverage", true],
      ["test_integrity", true],
      ["risk_rules", true],
      ["waivers", true],
      ["remote_ci", true],
    ]);
    expect(golden.checklist?.items[2]?.detail).toBe("diff coverage 96% (floor 80%)");
  });

  it("shows the latest checklist with each item's evidence", () => {
    expect(model.checklist?.ok).toBe(false);
    expect(model.checklist?.items[0]).toMatchObject({ id: "final_review", ok: false });
    expect(model.checklist?.items[0]?.detail).toMatch(/visual skipped/);
    expect(model.checklist?.items[6]?.evidence).toEqual(["url: https://github.com/o/r/pull/12"]);
  });

  it("lists the auto-merge, post-merge CI and revert events newest first", () => {
    expect(golden.timeline.map((t) => [t.title, t.tone])).toEqual([
      ["Auto-merge turned off: the PR head moved past the gated commit", "warn"],
      ["Auto-merge enabled on PR #12", "accent"],
    ]);
    expect(golden.timeline[0]?.detail).toMatch(/dddddddddddd/);
    expect(golden.timeline[1]?.detail).toBe("squash, bound to the gated commit cccccccc");
    expect(model.timeline.map((t) => [t.title, t.tone]).slice(0, 2)).toEqual([
      ["Merge reverted on the base branch", "danger"],
      ["Base CI after the merge: red", "danger"],
    ]);
    expect(model.timeline[0]?.detail).toMatch(/ffffffff.*git log/);
    expect(model.timeline[1]?.detail).toBe("Failed required runs: ci / test");
  });

  it("ignores other features", () => {
    expect(featureLevel3(SAMPLE_EVENTS, "F-2")).toEqual({ checklist: null, timeline: [] });
  });
});

describe("finalReviewStepRows (final_review.step_finished, §6.7a)", () => {
  const rows = finalReviewStepRows(SAMPLE_EVENTS, "F-1");

  it("shows all seven steps, the latest result of each", () => {
    expect(rows.map((r) => r.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows[1]).toMatchObject({ name: "Full acceptance run", passed: true });
    expect(rows[1]?.evidence).toEqual(["file: .vtc/evidence/F-1/final-review/gates.json"]);
    expect(rows[0]).toMatchObject({ status: null, passed: false });
  });

  it("shows skipped and unchecked steps as not passed, with the reason", () => {
    expect(rows[4]).toMatchObject({
      name: "Visual QA on full user journeys",
      passed: false,
      reason:
        "the visual step ran on the project's own Playwright (toolchain project), which Level 3 does not count",
    });
    expect(rows[4]?.status?.label).toBe("Not passed: skipped");
    const later = finalReviewStepRows([...SAMPLE_EVENTS, unchecked], "F-1");
    expect(later[1]?.status).toMatchObject({ label: "Not passed: unchecked", tone: "danger" });
    expect(later[1]?.reason).toBe("hidden tests did not start");
  });

  it("takes a re-run's result over the earlier one", () => {
    const rerun = variant(firstSample("final_review.step_finished"), 35, {
      step: 5,
      status: "pass",
      reason: undefined,
    });
    expect(finalReviewStepRows([...SAMPLE_EVENTS, rerun], "F-1")[4]?.passed).toBe(true);
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
