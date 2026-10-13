import { describe, expect, it } from "vitest";
import { FeatureSchema, type Feature } from "@vtc/shared";
import { finalReviewSteps, pullRequestModel } from "@/lib/feature";

const feature = (over: Partial<Feature> = {}): Feature =>
  FeatureSchema.parse({
    id: "F-1",
    title: "Password reset",
    status: "building",
    tasks: ["T-1", "T-2"],
    integration_branch: "vtc/F-1",
    round: 0,
    budget_usd: 10,
    final_review_budget_usd: 1.5,
    spent_usd: 5.6,
    ...over,
  });

const states = (f: Feature) => finalReviewSteps(f).steps.map((s) => `${s.key}:${s.state}`);

describe("finalReviewSteps (§6.7a feature states)", () => {
  it("marks steps before the current one done", () => {
    expect(states(feature({ status: "final_review", round: 1 }))).toEqual([
      "building:done",
      "integrating:done",
      "final_review:current",
      "ready_to_ship:todo",
      "shipped:todo",
    ]);
  });
  it("shows a fix round as part of Final Review, with n/3", () => {
    const model = finalReviewSteps(feature({ status: "fixing", round: 2 }));
    expect(model.steps[2]).toMatchObject({ state: "current", label: "Final Review ⇄ fixing 2/3" });
    expect(model.round).toBe("2/3");
  });
  it("marks everything done once shipped", () => {
    expect(states(feature({ status: "shipped", round: 1 })).every((s) => s.endsWith(":done"))).toBe(
      true,
    );
  });
  it("shows a park with its reason and does not guess the stage", () => {
    const model = finalReviewSteps(feature({ status: "parked", park_reason: "cap", round: 3 }));
    expect(model.parked).toBe("Parked: round cap");
    expect(model.steps.some((s) => s.state === "current")).toBe(false);
  });
});

describe("pullRequestModel", () => {
  const pr = {
    url: "https://github.com/acme/app/pull/7",
    draft: true,
    state: "open" as const,
    head_sha: "b".repeat(40),
    ci: "pending" as const,
  };
  it("shows a Level-2 draft PR until Final Review passes", () => {
    expect(pullRequestModel(pr)).toMatchObject({
      stateLabel: "Draft",
      ciLabel: "CI pending",
      head: "bbbbbbb",
    });
  });
  it("shows ready, merged and closed PRs and CI results", () => {
    expect(pullRequestModel({ ...pr, draft: false, ci: "green" })).toMatchObject({
      stateLabel: "Ready for review",
      ciTone: "ok",
    });
    expect(
      pullRequestModel({
        ...pr,
        draft: false,
        state: "merged",
        merge_commit: "c".repeat(40),
        ci: "green",
      }),
    ).toMatchObject({ stateLabel: "Merged", mergeCommit: "ccccccc" });
    expect(pullRequestModel({ ...pr, state: "closed", ci: "red" })).toMatchObject({
      stateLabel: "Closed",
      ciTone: "danger",
    });
    expect(pullRequestModel({ ...pr, ci: "unknown" }).ciLabel).toBe("CI unknown");
  });
  it("links only http(s) URLs, never a script URL", () => {
    expect(pullRequestModel(pr).url).toBe("https://github.com/acme/app/pull/7");
    expect(pullRequestModel({ ...pr, url: "javascript:alert(1)" }).url).toBeNull();
  });
});
