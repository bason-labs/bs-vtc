/**
 * The automation triggers and read model (AD-27; D-bv, D-ca): which engine events raise an
 * automatic issue or PR for which target, the Lead's daily summary, and `GET /api/automation`
 * folded from the `upstream.*` events of every run.
 */
import { describe, expect, it } from "vitest";
import {
  AutomationReportSchema,
  automationFor,
  type AutomationSettings,
  type Scorecard,
  type VtcEvent,
} from "@vtc/shared";
import {
  AUTOMATION_OFF_NOTE,
  applyEvent,
  automationDailySummary,
  automationFacts,
  automationReportView,
  costRegressionFacts,
  type RunState,
} from "../../src/core/index.js";
import { emptyRunState } from "../../src/core/state.js";

let seq = 0;
const ev = (
  type: string,
  data: Record<string, unknown>,
  extra: Partial<VtcEvent> = {},
  ts = "2026-10-14T10:00:00.000Z",
): VtcEvent => ({ v: 1, seq: (seq += 1), ts, run: "r1", type, actor: "engine", data, ...extra });

const stateWith = (...events: VtcEvent[]): RunState => {
  const state = emptyRunState("r1", "2026-10-14T09:00:00.000Z");
  for (const e of events) applyEvent(state, e);
  return state;
};

const FINDING = {
  fingerprint: "5".repeat(64),
  source: "role",
  source_name: "spec_verifier",
  rule_id: "reset.expiry-not-checked",
  category: "security",
  kind: "implementation_deviation",
  title: "Expired reset tokens are accepted",
  severity: "medium",
  confidence: 0.8,
  location: { path: "src/t-2/reset.ts", symbol: "reset" },
  evidence: { type: "file_line", ref: "src/t-2/reset.ts:31" },
  req_ids: ["REQ-2.AC-1"],
  route: "out_of_scope",
  task: "T-2",
  round_first_seen: 1,
  round_last_seen: 1,
  status: "open",
};

describe("automation triggers (D-bv)", () => {
  const facts = (e: VtcEvent, state = stateWith()) =>
    automationFacts(state, e).map((f) => [f.target, f.kind, f.errorClass]);

  it("VTC side: gate_infra and crash incidents, adapter parse failures, stuck loops, replay improve", () => {
    expect(facts(ev("incident.recorded", { kind: "gate_infra", detail: "x" }))).toEqual([
      ["upstream", "defect", "incident.gate_infra"],
    ]);
    expect(facts(ev("incident.recorded", { kind: "crash", detail: "x" }))).toEqual([
      ["upstream", "defect", "incident.crash"],
    ]);
    expect(facts(ev("incident.recorded", { kind: "kill", detail: "x" }))).toEqual([]);
    expect(
      facts(
        ev(
          "role.failed",
          {
            action_id: "a-1",
            kind: "error",
            message: "the role's final output is not a RoleResult: exit: invalid",
            retryable: true,
          },
          { role: "ba" },
        ),
      ),
    ).toEqual([["upstream", "defect", "adapter.parse_failure"]]);
    expect(
      facts(
        ev("role.failed", { action_id: "a-1", kind: "error", message: "boom", retryable: true }),
      ),
    ).toEqual([]);
    expect(
      facts(
        ev("lookback.replay_finished", {
          proposal: "p-1",
          verdict: "improve",
          path: ".vtc/lookback/replays/p-1.json",
          sha256: "e".repeat(64),
        }),
      ),
    ).toEqual([["upstream", "lookback", undefined]]);
    expect(
      facts(
        ev("lookback.replay_finished", {
          proposal: "p-1",
          verdict: "no_change",
          path: ".vtc/lookback/replays/p-1.json",
          sha256: "e".repeat(64),
        }),
      ),
    ).toEqual([]);
  });

  it("a stuck park is a project issue and VTC's own defect; a budget park is the human's", () => {
    const park = (reason: string) =>
      ev(
        "task.status_changed",
        { from: "building", to: "parked", round: 3, cap: 3, park_reason: reason },
        { task: "T-1" },
      );
    expect(facts(park("stuck"))).toEqual([
      ["project", "parked", undefined],
      ["upstream", "defect", "engine.stuck_loop"],
    ]);
    expect(facts(park("gate_infra"))).toEqual([["project", "parked", undefined]]);
    expect(facts(park("budget"))).toEqual([]);
    expect(facts(park("risk_rule"))).toEqual([]);
  });

  it("project side: red post-merge CI, reverts, escaped defects, out-of-scope findings", () => {
    expect(
      facts(
        ev(
          "feature.post_merge_ci",
          { merge_commit: "a".repeat(40), status: "red", runs: [] },
          { feature: "F-1" },
        ),
      ),
    ).toEqual([["project", "ci_failure", undefined]]);
    expect(
      facts(
        ev(
          "feature.post_merge_ci",
          { merge_commit: "a".repeat(40), status: "green", runs: [] },
          { feature: "F-1" },
        ),
      ),
    ).toEqual([]);
    expect(
      facts(
        ev(
          "feature.reverted",
          { merge_commit: "a".repeat(40), detail: "reverted" },
          { feature: "F-1" },
        ),
      ),
    ).toEqual([["project", "escaped_defect", undefined]]);
    expect(
      facts(
        ev(
          "lookback.escaped_defect",
          { merge_commit: "a".repeat(40), kind: "revert", tasks: ["T-1"] },
          { feature: "F-1" },
        ),
      ),
    ).toEqual([["project", "escaped_defect", undefined]]);
    expect(facts(ev("finding.recorded", { finding: FINDING }, { task: "T-2" }))).toEqual([
      ["project", "finding", undefined],
    ]);
    expect(
      facts(ev("finding.recorded", { finding: { ...FINDING, route: "patch" } }, { task: "T-2" })),
    ).toEqual([]);
  });

  it("Final Review leftovers: the feature findings a finished run left open", () => {
    const leftover = { ...FINDING, route: "defer", status: "deferred", feature: "F-1" };
    const { task: _task, ...featureFinding } = leftover;
    const state = stateWith(ev("finding.recorded", { finding: featureFinding }));
    expect(facts(ev("run.finished", { outcome: "delivered" }), state)).toEqual([
      ["project", "final_review", undefined],
    ]);
  });
});

describe("the daily summary (D-ca)", () => {
  it("counts what automation did with links, and is null when nothing happened", () => {
    const opened = ev("upstream.issue_opened", {
      target: { kind: "upstream", repo: "bason-labs/bs-vtc" },
      kind: "defect",
      fingerprint: "0123456789abcdef",
      number: 7,
      url: "https://github.com/bason-labs/bs-vtc/issues/7",
    });
    const skipped = ev("automation.skipped", { reason: "rate_limit", detail: "5 issues today" });
    const text = automationDailySummary([opened, skipped], "2026-10-14");
    expect(text).toBe(
      "Automation on 2026-10-14 (UTC): 1 issue(s) and 0 draft PR(s) opened, 0 issue update(s), 0 closed. Issues: #7 https://github.com/bason-labs/bs-vtc/issues/7. Skipped: rate_limit 1.",
    );
    expect(automationDailySummary([], "2026-10-14")).toBeNull();
  });
});

describe("GET /api/automation (AutomationReport)", () => {
  const settings: AutomationSettings = automationFor(
    {},
    { upstream: { repo: "bason-labs/bs-vtc", share: true } },
    { githubRemote: false, ghLoggedIn: true, paused: false },
  );
  const target = { kind: "project", repo: "acme/app" };

  it("folds the upstream.* events of every run into items, newest first, with the skips and notes", () => {
    const events = [
      ev(
        "upstream.issue_opened",
        {
          target,
          kind: "ci_failure",
          fingerprint: "0123456789abcdef",
          number: 3,
          url: "https://github.com/acme/app/issues/3",
        },
        {},
        "2026-10-14T10:00:00.000Z",
      ),
      ev(
        "upstream.pr_opened",
        {
          target,
          kind: "ci_failure",
          fingerprint: "0123456789abcdef",
          number: 4,
          url: "https://github.com/acme/app/pull/4",
          branch: "vtc/auto/ci_failure/01234567",
          issue: 3,
          evidence: "partial",
        },
        { run: "r2" },
        "2026-10-14T11:00:00.000Z",
      ),
      ev(
        "upstream.issue_opened",
        {
          target: { kind: "upstream", repo: "bason-labs/bs-vtc" },
          kind: "defect",
          fingerprint: "fedcba9876543210",
          number: 9,
          url: "https://github.com/bason-labs/bs-vtc/issues/9",
        },
        {},
        "2026-10-14T09:00:00.000Z",
      ),
      ev(
        "upstream.issue_closed",
        {
          target: { kind: "upstream", repo: "bason-labs/bs-vtc" },
          kind: "defect",
          fingerprint: "fedcba9876543210",
          number: 9,
          url: "https://github.com/bason-labs/bs-vtc/issues/9",
          reason: "quiet",
        },
        {},
        "2026-10-14T09:30:00.000Z",
      ),
      ev("automation.skipped", { reason: "paused", kind: "parked", detail: "paused" }),
    ];
    const report = automationReportView(events, settings);
    expect(AutomationReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      issues: false,
      prs: false,
      upstream: true,
      upstream_repo: "bason-labs/bs-vtc",
      evidence_hosting: "branch",
      notes: ["automatic issues and PRs are off: this project has no GitHub remote"],
    });
    expect(report.items).toEqual([
      {
        target,
        kind: "ci_failure",
        fingerprint: "0123456789abcdef",
        issue: { number: 3, url: "https://github.com/acme/app/issues/3", state: "open" },
        pr: {
          number: 4,
          url: "https://github.com/acme/app/pull/4",
          state: "draft",
          evidence: "partial",
        },
        first_at: "2026-10-14T10:00:00.000Z",
        last_at: "2026-10-14T11:00:00.000Z",
      },
      {
        target: { kind: "upstream", repo: "bason-labs/bs-vtc" },
        kind: "defect",
        fingerprint: "fedcba9876543210",
        issue: { number: 9, url: "https://github.com/bason-labs/bs-vtc/issues/9", state: "closed" },
        pr: null,
        first_at: "2026-10-14T09:00:00.000Z",
        last_at: "2026-10-14T09:30:00.000Z",
      },
    ]);
    expect(report.skipped).toEqual([
      { at: "2026-10-14T10:00:00.000Z", reason: "paused", kind: "parked", detail: "paused" },
    ]);
  });

  it("without automation wiring, everything is off with a note", () => {
    const report = automationReportView([], null);
    expect(report).toMatchObject({
      issues: false,
      prs: false,
      upstream: false,
      notes: [AUTOMATION_OFF_NOTE],
      items: [],
      skipped: [],
    });
  });
});

describe("project facts name a stable problem (D-bv, D-bx dedupe)", () => {
  const one = (e: VtcEvent, state = stateWith()) => {
    const [fact] = automationFacts(state, e).filter((f) => f.target === "project");
    if (fact === undefined) throw new Error("no project fact");
    return fact;
  };

  it("a parked task is keyed by its run, task and reason, and titled with the task", () => {
    const state = stateWith();
    state.tasks.set("T-1", {
      id: "T-1",
      title: "Reset tokens expire",
      feature: "F-1",
    } as unknown as Parameters<typeof state.tasks.set>[1]);
    const fact = one(
      ev(
        "task.status_changed",
        { from: "building", to: "parked", round: 3, cap: 3, park_reason: "stuck" },
        { task: "T-1" },
      ),
      state,
    );
    expect(fact.ruleId).toBe("parked/stuck/r1/T-1");
    expect(fact.title).toMatch(/^Task T-1 parked \(stuck\)/);
  });

  it("red CI, a revert and an escaped defect of one merge share the merge; a finding is keyed by its fingerprint", () => {
    const merge = "a".repeat(40);
    expect(
      one(
        ev(
          "feature.post_merge_ci",
          { merge_commit: merge, status: "red", runs: [] },
          { feature: "F-1" },
        ),
      ),
    ).toMatchObject({
      ruleId: `post_merge_ci/${merge}`,
      title: expect.stringContaining("aaaaaaaaaaaa") as string,
    });
    const reverted = one(
      ev("feature.reverted", { merge_commit: merge, detail: "reverted" }, { feature: "F-1" }),
    );
    const escaped = one(
      ev(
        "lookback.escaped_defect",
        { merge_commit: merge, kind: "revert", tasks: ["T-1"] },
        { feature: "F-1" },
      ),
    );
    expect(reverted.ruleId).toBe(`escaped_defect/${merge}`);
    expect(escaped.ruleId).toBe(reverted.ruleId);
    const finding = one(ev("finding.recorded", { finding: FINDING }, { task: "T-2" }));
    expect(finding).toMatchObject({
      ruleId: `finding/${FINDING.fingerprint}`,
      path: "src/t-2/reset.ts",
      title: "security finding: Expired reset tokens are accepted",
    });
  });
});

describe("cost regressions from Lookback's scorecards (D-bv)", () => {
  const sha = (c: string) => c.repeat(64);
  const card = (
    effective: string,
    from: string,
    metrics: Scorecard["metrics"],
    role = "engineer",
  ): Scorecard => ({
    v: 1,
    prompt: {
      role,
      host: "claude-code",
      locked_sha256: sha("1"),
      editable_sha256: effective,
      effective_sha256: effective,
    },
    grader_bundle_sha: sha("9"),
    window: { from, to: "2026-10-14T00:00:00.000Z" },
    metrics,
    breakdown: [],
    written_at: "2026-10-14T00:00:00.000Z",
  });
  const m = (value: number | null) => ({ value, ci_low: null, ci_high: null, n: 20 });
  const meta = { run: "r1", at: "2026-10-14T12:00:00.000Z" };

  it("compares each role's newest version with the one before it, beyond LOOKBACK_LIMITS", () => {
    const facts = costRegressionFacts(
      [
        card(sha("b"), "2026-10-10T00:00:00.000Z", {
          tokens_per_success: m(13000),
          escalations_per_100: m(4),
          cap_hits_per_100: m(1),
        }),
        card(sha("a"), "2026-10-01T00:00:00.000Z", {
          tokens_per_success: m(10000),
          escalations_per_100: m(2),
          cap_hits_per_100: m(1),
        }),
      ],
      meta,
    );
    expect(facts.map((f) => [f.target, f.kind, f.metric, f.baseline, f.current])).toEqual([
      ["upstream", "cost", "tokens_per_success", 10000, 13000],
      ["upstream", "cost", "escalations_per_100", 2, 4],
    ]);
    expect(facts[0]).toMatchObject({
      role: "engineer",
      host: "claude-code",
      promptSha: sha("b"),
      baselinePromptSha: sha("a"),
      run: "r1",
      source: "lookback.scorecards",
      at: meta.at,
    });
  });

  it("raises nothing within the limits, with too little data, or with one version", () => {
    expect(
      costRegressionFacts(
        [
          card(sha("b"), "2026-10-10T00:00:00.000Z", { tokens_per_success: m(11900) }),
          card(sha("a"), "2026-10-01T00:00:00.000Z", { tokens_per_success: m(10000) }),
        ],
        meta,
      ),
    ).toEqual([]);
    expect(
      costRegressionFacts(
        [
          card(sha("b"), "2026-10-10T00:00:00.000Z", { tokens_per_success: m(null) }),
          card(sha("a"), "2026-10-01T00:00:00.000Z", { tokens_per_success: m(10000) }),
        ],
        meta,
      ),
    ).toEqual([]);
    expect(
      costRegressionFacts(
        [card(sha("a"), "2026-10-01T00:00:00.000Z", { tokens_per_success: m(10000) })],
        meta,
      ),
    ).toEqual([]);
    // two roles never compare with each other
    expect(
      costRegressionFacts(
        [
          card(sha("b"), "2026-10-10T00:00:00.000Z", { tokens_per_success: m(50000) }, "qa"),
          card(sha("a"), "2026-10-01T00:00:00.000Z", { tokens_per_success: m(10000) }),
        ],
        meta,
      ),
    ).toEqual([]);
  });
});
