/**
 * Level-3 auto-merge (spec §6.7, D9; spine AD-23; §5 readings 104 and 105) with a fake
 * `RemoteMergeService`: the preflight at run start (no required checks → Level 2 with a reason
 * and an escalation), the checklist on the gated SHA, auto-merge bound to it, a moved head that
 * parks, the post-merge watch that downgrades through the ledger and records the escaped defect,
 * and `vtc pause` turning auto-merge off.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MERGE_LEVEL_LEDGER, type PullRequestRef } from "@vtc/shared";
import { cleanupDirs, git } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  passFinalReview,
  reportCoverage,
  SPEC_ONE,
  throughPlan,
  verdictPass,
  type Harness,
  type HarnessOptions,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  feature?: string;
  run: string;
  data: Record<string, unknown>;
}

const eventsOf = (h: Harness, run: string): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${run}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const runId = (h: Harness): string => h.engine.status({}).run.id;
const ofType = (h: Harness, type: string, run = runId(h)): Line[] =>
  eventsOf(h, run).filter((e) => e.type === type);

const level3 = (over: HarnessOptions = {}): Harness => {
  const h = createHarness({ project: { merge_level: 3 }, level3: true, ...over });
  reportCoverage(h);
  return h;
};

/** One task from plan to the end of its Final Review (the release runs in the background). */
const toRelease = async (h: Harness): Promise<void> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
  await verdictPass(
    h,
    only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
    "src/t-1/impl.ts",
  );
  await h.engine.settle();
  await passFinalReview(h);
};

const gatedSha = (h: Harness): string => {
  const report = ofType(h, "gate.result").findLast((e) => e.data.reason === "final_review");
  return String(report?.data.head);
};

describe("AD-23 rule 1: the Level-3 preflight at run start", () => {
  it("runs at Level 3 when the base enforces a required check", async () => {
    const h = level3();
    await toRelease(h);
    const run = runId(h);
    expect(ofType(h, "run.started", run)[0]?.data.merge_level).toBe(3);
    expect(ofType(h, "merge.preflight", run)[0]?.data).toMatchObject({
      configured_level: 3,
      effective_level: 3,
      ok: true,
      failed: [],
    });
    await h.release();
  });

  it("a base with no required status check starts the run at Level 2, with the reason and an escalation", async () => {
    const h = level3();
    h.remote3.rules = { ...h.remote3.rules, required_checks: [] };
    await toRelease(h);
    const run = runId(h);
    expect(ofType(h, "run.started", run)[0]?.data.merge_level).toBe(2);
    const preflight = ofType(h, "merge.preflight", run)[0]?.data;
    expect(preflight).toMatchObject({
      ok: false,
      failed: ["no_required_checks"],
      effective_level: 2,
    });
    expect(String(preflight?.detail)).toContain("required status check");
    const escalation = ofType(h, "escalation.opened", run)[0]?.data.escalation as {
      reason: string;
      detail: string;
    };
    expect(escalation.reason).toBe("blocked");
    expect(escalation.detail).toContain("runs at Level 2");
    // Level 2: the PR is marked ready and nothing is merged by VTC
    expect(h.remote3.calls.some((c) => c.startsWith("enable"))).toBe(false);
    expect(h.engine.status({ run }).run.finished_at).toBeDefined();
    await h.release();
  });

  it("without a RemoteMergeService the run starts at Level 2", async () => {
    const h = createHarness({ project: { merge_level: 3 } });
    await toRelease(h);
    expect(ofType(h, "merge.preflight")[0]?.data).toMatchObject({ ok: false, effective_level: 2 });
    expect(ofType(h, "run.started")[0]?.data.merge_level).toBe(2);
    await h.release();
  });

  it("gh not signed in fails the preflight before the policy is read", async () => {
    const h = level3();
    h.remote3.info = { github: true, ghAuthenticated: false };
    await toRelease(h);
    expect(ofType(h, "merge.preflight")[0]?.data).toMatchObject({ failed: ["gh_unauthenticated"] });
    expect(h.remote3.calls.filter((c) => c.startsWith("policy"))).toEqual([]);
    await h.release();
  });
});

describe("AD-23 rules 2–3: the checklist and auto-merge bound to the gated SHA", () => {
  it("evaluates the checklist, enables auto-merge on the gated SHA, ships and finishes", async () => {
    const h = level3();
    await toRelease(h);
    const run = runId(h);
    const sha = gatedSha(h);
    const checklist = ofType(h, "feature.checklist", run)[0]?.data as {
      ok: boolean;
      items: { id: string; ok: boolean }[];
    };
    expect(checklist.ok).toBe(true);
    expect(checklist.items.map((i) => i.id)).toEqual([
      "final_review",
      "reviewers",
      "coverage",
      "test_integrity",
      "risk_rules",
      "waivers",
      "remote_ci",
    ]);
    expect(h.remote3.calls).toContain(`enable vtc/F-1 ${sha.slice(0, 7)} squash`);
    expect(ofType(h, "feature.auto_merge_enabled", run)[0]?.data).toEqual({
      pr_number: 7,
      head_sha: sha,
      method: "squash",
      merge_queue: false,
    });
    const status = h.engine.status({ run });
    expect(status.features[0]).toMatchObject({ status: "shipped", pr: { state: "merged" } });
    expect(status.run.finished_at).toBeDefined();
    await h.release();
  });

  it("waits for pending required checks, then merges", async () => {
    const h = level3();
    h.remote3.checks = [[{ name: "ci", state: "pending" }], [{ name: "ci", state: "success" }]];
    await toRelease(h);
    expect(h.remote3.calls.filter((c) => c.startsWith("checks"))).toHaveLength(2);
    expect(h.engine.status({ run: runId(h) }).features[0]?.status).toBe("shipped");
    await h.release();
  });

  it("a red required check fails the checklist and parks the feature, the PR left for review", async () => {
    const h = level3();
    h.remote3.checks = [[{ name: "ci", state: "failure" }]];
    await toRelease(h);
    const run = runId(h);
    const checklist = ofType(h, "feature.checklist", run)[0]?.data as {
      ok: boolean;
      items: { id: string; ok: boolean }[];
    };
    expect(checklist.ok).toBe(false);
    expect(checklist.items.find((i) => i.id === "remote_ci")?.ok).toBe(false);
    expect(h.remote3.calls.some((c) => c.startsWith("enable"))).toBe(false);
    const status = h.engine.status({ run });
    expect(status.features[0]).toMatchObject({ status: "parked", park_reason: "blocked" });
    expect(status.run.finished_at).toBeUndefined();
    await h.release();
  });

  it("answering the park retries the auto-merge once the human fixed the cause", async () => {
    const h = level3();
    h.remote3.checks = [[{ name: "ci", state: "failure" }]];
    await toRelease(h);
    const run = runId(h);
    const escalation = ofType(h, "escalation.opened", run).at(-1)?.data.escalation as {
      id: string;
    };
    h.remote3.checks = [[{ name: "ci", state: "success" }]];
    await h.engine.answer(
      {
        escalation: escalation.id,
        answer: { option: "clarify", text: "CI fixed", who_should_have_caught: "none" },
      },
      CLAUDE,
    );
    await h.engine.settle();
    const status = h.engine.status({ run });
    expect(status.features[0]?.status).toBe("shipped");
    expect(status.run.finished_at).toBeDefined();
    await h.release();
  });

  it("required checks still pending after the timeout park the feature", async () => {
    const h = level3();
    h.remote3.checks = [[{ name: "ci", state: "pending" }]];
    await toRelease(h);
    const feature = h.engine.status({ run: runId(h) }).features[0];
    expect(feature).toMatchObject({ status: "parked", park_reason: "blocked" });
    const escalation = ofType(h, "escalation.opened").at(-1)?.data.escalation as { detail: string };
    expect(escalation.detail).toContain("still pending");
    await h.release();
  });

  it("a head that moves after auto-merge was enabled parks the feature", async () => {
    const h = level3();
    h.remote3.mergeOnEnable = false;
    const enable = h.remote3.enableAutoMerge.bind(h.remote3);
    h.remote3.enableAutoMerge = async (request) => {
      const pr = await enable(request);
      h.prs.current = { ...(h.prs.current as PullRequestRef), head_sha: "d".repeat(40) };
      return pr;
    };
    await toRelease(h);
    const run = runId(h);
    // GitHub keeps auto-merge on after a push: VTC turns it off before it parks
    expect(h.remote3.calls).toContain("disable vtc/F-1");
    expect(ofType(h, "feature.auto_merge_disabled", run).at(-1)?.data).toMatchObject({
      reason: "head_moved",
    });
    expect(h.engine.status({ run }).features[0]).toMatchObject({
      status: "parked",
      park_reason: "blocked",
    });
    await h.release();
  });

  it("a moved head whose auto-merge cannot be turned off parks with what the human must do", async () => {
    const h = level3();
    h.remote3.mergeOnEnable = false;
    const enable = h.remote3.enableAutoMerge.bind(h.remote3);
    h.remote3.enableAutoMerge = async (request) => {
      const pr = await enable(request);
      h.prs.current = { ...(h.prs.current as PullRequestRef), head_sha: "d".repeat(40) };
      return pr;
    };
    h.remote3.disableAutoMerge = () => Promise.reject(new Error("gh: HTTP 502"));
    await toRelease(h);
    const run = runId(h);
    expect(ofType(h, "feature.auto_merge_disabled", run)).toEqual([]);
    expect(h.engine.status({ run }).features[0]?.status).toBe("parked");
    const escalation = ofType(h, "escalation.opened", run).at(-1)?.data.escalation as {
      detail: string;
    };
    expect(escalation.detail).toContain("could NOT turn its auto-merge off");
    expect(escalation.detail).toContain("--disable-auto");
    await h.release();
  });

  it("a PR GitHub merged at a head other than the gated SHA is never marked shipped", async () => {
    const h = level3();
    const enable = h.remote3.enableAutoMerge.bind(h.remote3);
    h.remote3.enableAutoMerge = async (request) => {
      const pr = await enable(request);
      // the head moved and merged between two polls
      h.prs.current = { ...(h.prs.current as PullRequestRef), head_sha: "d".repeat(40) };
      return pr;
    };
    await toRelease(h);
    const run = runId(h);
    const status = h.engine.status({ run });
    expect(status.features[0]).toMatchObject({
      status: "parked",
      park_reason: "blocked",
      pr: { state: "merged" },
    });
    expect(status.run.finished_at).toBeUndefined();
    const escalation = ofType(h, "escalation.opened", run).at(-1)?.data.escalation as {
      detail: string;
    };
    expect(escalation.detail).toContain("not at the commit Final Review verified");
    await h.release();
  });

  it("a pause that lands while auto-merge is being enabled still turns it off", async () => {
    const h = level3();
    h.remote3.mergeOnEnable = false;
    const enable = h.remote3.enableAutoMerge.bind(h.remote3);
    h.remote3.enableAutoMerge = async (request) => {
      // vtc pause runs while gh is enabling auto-merge: the feature's PR is not yet recorded as
      // enabled, so the pause's own sweep skips it
      await h.engine.pause({});
      return enable(request);
    };
    await toRelease(h);
    expect(h.remote3.calls.filter((c) => c === "disable vtc/F-1")).toHaveLength(1);
    expect(h.remote3.calls.indexOf("disable vtc/F-1")).toBeGreaterThan(
      h.remote3.calls.findIndex((c) => c.startsWith("enable")),
    );
    expect(ofType(h, "feature.auto_merge_disabled").at(-1)?.data).toMatchObject({
      reason: "paused",
    });
    expect(h.prs.current?.auto_merge).toBe("disabled");
    await h.release();
  });

  it("vtc pause turns off the pending auto-merge VTC enabled", async () => {
    const h = level3();
    h.remote3.mergeOnEnable = false;
    let wake: () => void = () => undefined;
    let waiting: () => void = () => undefined;
    const asleep = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    h.sleeper = () =>
      new Promise((resolve) => {
        wake = resolve;
        waiting();
      });
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    await verdictPass(
      h,
      only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
      "src/t-1/impl.ts",
    );
    await h.engine.settle().catch(() => undefined);
    void passFinalReview(h);
    await asleep; // auto-merge is enabled and the engine waits for the merge
    await h.engine.pause({});
    expect(h.remote3.calls).toContain("disable vtc/F-1");
    expect(ofType(h, "feature.auto_merge_disabled").at(-1)?.data).toMatchObject({
      reason: "paused",
    });
    h.sleeper = null;
    wake();
    await h.engine.settle();
    expect(h.engine.status({}).run.finished_at).toBeUndefined();
    await h.release();
  });
});

describe("the engine's shutdown during a Level-3 wait", () => {
  it("stops the wait at once, leaves the auto-merge on GitHub and the feature ready to ship", async () => {
    const h = level3();
    h.remote3.mergeOnEnable = false;
    let waiting: () => void = () => undefined;
    const asleep = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    // a wait that would last the whole merge timeout unless the shutdown cuts it short
    h.sleeper = () =>
      new Promise(() => {
        waiting();
      });
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    await verdictPass(
      h,
      only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
      "src/t-1/impl.ts",
    );
    await h.engine.settle().catch(() => undefined);
    void passFinalReview(h).catch(() => undefined);
    await asleep;
    await h.engine.shutdown();
    expect(h.remote3.calls.some((c) => c.startsWith("disable"))).toBe(false);
    const status = h.engine.status({});
    expect(status.features[0]?.status).toBe("ready_to_ship");
    expect(status.run.finished_at).toBeUndefined();
    await h.release();
  });
});

describe("AD-23 rules 4–5: the post-merge watch and the ledger", () => {
  it("a red required base run downgrades through the ledger and records the escaped defect", async () => {
    const h = level3();
    await toRelease(h);
    const run = runId(h);
    h.remote3.baseRunList = [{ name: "ci", conclusion: "failure", required: true }];
    await h.engine.watchMerged();
    await h.engine.settle();
    expect(ofType(h, "feature.post_merge_ci", run)[0]?.data).toMatchObject({
      merge_commit: "c".repeat(40),
      status: "red",
    });
    expect(ofType(h, "run.merge_level_changed", run).at(-1)?.data).toEqual({
      from: 3,
      to: 2,
      reason: "post_merge_ci_failure",
    });
    expect(ofType(h, "lookback.escaped_defect", run)[0]).toMatchObject({
      feature: "F-1",
      data: { merge_commit: "c".repeat(40), kind: "post_merge_ci_failure", tasks: ["T-1"] },
    });
    const ledger = readFileSync(join(h.repo, MERGE_LEVEL_LEDGER), "utf8").trim().split("\n");
    expect(ledger.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      expect.objectContaining({
        kind: "downgrade",
        cap: 2,
        reason: "post_merge_ci_failure",
        feature: "F-1",
      }),
    ]);
    // once: a second poll records nothing new
    await h.engine.watchMerged();
    expect(readFileSync(join(h.repo, MERGE_LEVEL_LEDGER), "utf8").trim().split("\n")).toHaveLength(
      1,
    );
    // project.yaml is never edited; the next run starts capped at Level 2, without a preflight
    expect(readFileSync(join(h.repo, ".vtc/project.yaml"), "utf8")).toContain('"merge_level": 3');
    git(h.repo, "add", "-A");
    git(h.repo, "commit", "-qm", "ledger");
    await h.engine.start(
      { request: "Next", track: "feature", repo: "existing", has_ui: false, risk_hints: [] },
      CLAUDE,
    );
    const next = runId(h);
    expect(next).not.toBe(run);
    expect(ofType(h, "run.started", next)[0]?.data.merge_level).toBe(2);
    expect(ofType(h, "merge.preflight", next)).toEqual([]);
    await h.release();
  });

  it("a revert downgrades too, and green CI downgrades nothing", async () => {
    const h = level3();
    await toRelease(h);
    const run = runId(h);
    h.remote3.baseRunList = [{ name: "ci", conclusion: "success", required: true }];
    await h.engine.watchMerged();
    expect(ofType(h, "feature.post_merge_ci", run).at(-1)?.data).toMatchObject({ status: "green" });
    expect(existsSync(join(h.repo, MERGE_LEVEL_LEDGER))).toBe(false);
    h.remote3.reverts = [{ commit: "e".repeat(40), detected_by: "git_log" }];
    await h.engine.watchMerged();
    expect(ofType(h, "feature.reverted", run)[0]?.data).toMatchObject({
      merge_commit: "c".repeat(40),
      revert: { commit: "e".repeat(40), detected_by: "git_log" },
    });
    expect(ofType(h, "lookback.escaped_defect", run)[0]?.data).toMatchObject({ kind: "revert" });
    expect(readFileSync(join(h.repo, MERGE_LEVEL_LEDGER), "utf8")).toContain('"reason":"revert"');
    await h.release();
  });

  it("the watch ends after the window", async () => {
    const h = level3();
    await toRelease(h);
    h.advance(25 * 3_600_000);
    h.remote3.baseRunList = [{ name: "ci", conclusion: "failure", required: true }];
    await h.engine.watchMerged();
    expect(h.remote3.calls.filter((c) => c.startsWith("runs"))).toEqual([]);
    expect(existsSync(join(h.repo, MERGE_LEVEL_LEDGER))).toBe(false);
    await h.release();
  });
});
