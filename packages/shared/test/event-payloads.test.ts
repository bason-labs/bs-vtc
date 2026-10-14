import { describe, expect, it } from "vitest";
import {
  CORE_EVENT_TYPES,
  EVENT_PAYLOAD_SCHEMAS,
  EventSchema,
  isEventOfType,
  parseSseEventId,
  readEventData,
  sseEventId,
  validateEventData,
  type CoreEventType,
  type EventDataInput,
} from "../src/index.js";
import {
  COMMIT,
  NOW,
  SHA,
  validEscalation,
  validFeature,
  validFinding,
  validGateReport,
  validTask,
  validTaskDraft,
} from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

/** Trace envelope of role events (§1.1 #3): prompt version, host and model. */
const trace = { prompt_sha: SHA, host: "claude-code", model: "claude-sonnet-5" } as const;

/** An automatic issue or PR in VTC's own repo (AD-27). */
const autoRepoUrl = "https://github.com/bason-labs/bs-vtc";
const autoItem = {
  target: { kind: "upstream", repo: "bason-labs/bs-vtc" },
  kind: "defect",
  fingerprint: "0123abcd4567ef89",
} as const;

/** One valid payload per core event type, plus the envelope fields that type requires. */
const examples: { [T in CoreEventType]: { data: EventDataInput<T>; envelope?: object } } = {
  "run.started": {
    data: {
      request: "Password reset\n\nUsers who forget their password reset it by email.",
      track: "feature",
      repo: "existing",
      has_ui: true,
      risk_hints: ["auth"],
      merge_level: 2,
      pipeline_config_hash: SHA,
    },
  },
  "run.phase_changed": { data: { from: "specify", to: "g1" } },
  "run.paused": { data: { reason: "vtc pause (kill switch)" } },
  "run.resumed": { data: { auto: true } },
  "run.finished": { data: { outcome: "done", summary: ".vtc/runs/r1/summary.md" } },
  "run.merge_level_changed": { data: { from: 2, to: 1, reason: "revert" } },
  "gate.approved": {
    data: { gates: ["G1"], frozen: [{ path: ".vtc/spec/spec.md", sha256: SHA }] },
  },
  "gate.rejected": { data: { gates: ["G2"], note: "Pick a cheaper datastore." } },
  "task.created": {
    data: { task: validTask(), intent: validTaskDraft().intent },
    envelope: { task: "T-7" },
  },
  "task.workspace_assigned": {
    data: { worktree: ".vtc/state/worktrees/T-7", branch: "vtc/T-7", baseline_revision: COMMIT },
    envelope: { task: "T-7" },
  },
  "task.session_updated": {
    data: { session_ref: { host: "claude-code", id: "sess-7" } },
    envelope: { task: "T-7" },
  },
  "contract.frozen": {
    data: { path: "contracts/auth.yaml", sha256: SHA },
    envelope: { task: "T-7" },
  },
  "task.status_changed": {
    data: { from: "fixing", to: "parked", round: 5, cap: 5, park_reason: "cap" },
    envelope: { task: "T-7" },
  },
  "feature.created": { data: { feature: validFeature() as never }, envelope: { feature: "F-1" } },
  "feature.task_added": { data: { task: "T-9" }, envelope: { feature: "F-1" } },
  "feature.status_changed": {
    data: { from: "integrating", to: "final_review", round: 0 },
    envelope: { feature: "F-1" },
  },
  "feature.pr_updated": {
    data: {
      pr: {
        url: "https://github.com/acme/app/pull/12",
        draft: false,
        state: "open",
        head_sha: COMMIT,
        ci: "green",
      },
    },
    envelope: { feature: "F-1" },
  },
  "branch.pushed": { data: { branch: "vtc/F-1", commit: COMMIT }, envelope: { feature: "F-1" } },
  "branch.push_failed": {
    data: { branch: "vtc/F-1", detail: "rejected: non-fast-forward" },
    envelope: { feature: "F-1" },
  },
  "feature.pr_failed": {
    data: { detail: "gh: could not create the pull request" },
    envelope: { feature: "F-1" },
  },
  "role.dispatched": {
    data: {
      action_id: "a-1",
      mode: "author",
      dispatch: "subagent",
      agent: "vtc-qa-author",
      pack: ".vtc/state/packs/a-1.md",
      resume: null,
    },
    envelope: { role: "qa", task: "T-7", ...trace },
  },
  "role.submitted": {
    data: {
      action_id: "a-1",
      exit: "done",
      verdicts: [{ subject: "T-7", verdict: "pass" }],
      findings: 0,
      questions: 1,
      session_ref: null,
    },
    envelope: { role: "qa", task: "T-7", ...trace, tokens: null, cost_usd: null },
  },
  "role.rejected": {
    data: { action_id: "a-1", reason: "write_scope", issues: ["src/other.ts is out of scope"] },
    envelope: { role: "engineer", task: "T-7" },
  },
  "role.failed": {
    data: { action_id: "a-1", kind: "error", message: "crashed", retryable: true },
    envelope: { role: "engineer", task: "T-7" },
  },
  "gate.result": { data: validGateReport() as never, envelope: { task: "T-7" } },
  "finding.recorded": { data: { finding: validFinding() as never }, envelope: { task: "T-7" } },
  "finding.status_changed": { data: { fingerprint: SHA, from: "open", to: "resolved" } },
  "escalation.opened": { data: { escalation: validEscalation() as never } },
  "escalation.answered": {
    data: { escalation: "E-4", answer: { option: "hint", who_should_have_caught: "qa" } },
  },
  "change_request.opened": {
    data: {
      escalation: "E-5",
      artifact: "interface_contract",
      frozen: { path: "contracts/auth.yaml", sha256: SHA },
      task: "T-7",
      summary: "Add a locale field to the reset request",
    },
  },
  "change_request.decided": {
    data: {
      escalation: "E-5",
      decision: "approved",
      frozen: { path: "contracts/auth.yaml", sha256: SHA },
      new_sha256: "b".repeat(64),
    },
  },
  "spec.clarified": {
    data: {
      path: ".vtc/spec/spec.md",
      old_sha256: SHA,
      new_sha256: "c".repeat(64),
      summary: "Reworded REQ-3.AC-2; meaning unchanged",
    },
  },
  "budget.updated": {
    data: { scope: "task", budget_usd: 5, spent_usd: 3.5 },
    envelope: { task: "T-7" },
  },
  "usage.updated": {
    data: {
      snapshot: {
        host: "codex",
        source: "app_server",
        windows: [
          {
            kind: "five_hour",
            label: "primary",
            window_minutes: 300,
            used_pct: 12,
            resets_at: NOW,
          },
        ],
        updated_at: NOW,
      },
    },
  },
  "limit.hit": {
    data: {
      host: "claude-code",
      window: "five_hour",
      model: null,
      resets_at: NOW,
      session_ref: { host: "claude-code", id: "s-1" },
      pending_action_ids: ["a-1"],
      auto_resume_at: "2026-10-13T13:02:00Z",
    },
  },
  "merge.completed": {
    data: { into: "vtc/F-1", commit: COMMIT, level: 2 },
    envelope: { task: "T-7" },
  },
  "incident.recorded": {
    data: { kind: "log_corruption", detail: "torn final line", invalid_lines: [12] },
  },
  // ---- contracts 4.5.0
  "gate.requested": {
    data: {
      gates: ["G2"],
      artifacts: [{ path: ".vtc/architecture/spine.md", sha256: SHA }],
      design_directions: ["calm-ledger", "night-market"],
      unverified_facts: ["f-0123456789abcdef"],
    },
  },
  "headless.preflight": {
    data: { host: "codex", purpose: "role", ok: false, failed: "auth", detail: "logged out" },
  },
  "headless.started": {
    data: {
      action_id: "a-7",
      pid: 4242,
      resume: null,
      wall_timeout_ms: 3_600_000,
      idle_timeout_ms: 600_000,
    },
    envelope: { role: "engineer", host: "codex" },
  },
  "headless.ended": {
    data: { action_id: "a-7", outcome: "error", cause: "idle", exit_code: 143, duration_ms: 1000 },
    envelope: { role: "engineer", host: "codex" },
  },
  "merge.preflight": {
    data: {
      configured_level: 3,
      effective_level: 2,
      ok: false,
      failed: ["no_required_checks"],
      policy: {
        base: "main",
        auto_merge_allowed: true,
        required_checks: [],
        merge_methods: ["squash"],
        merge_queue: false,
        requires_review: false,
        signatures_required: false,
      },
    },
  },
  "feature.checklist": {
    data: {
      ok: false,
      items: [
        "final_review",
        "reviewers",
        "coverage",
        "test_integrity",
        "risk_rules",
        "waivers",
        "remote_ci",
      ].map((id) => ({ id: id as "final_review", ok: id !== "remote_ci", detail: "x" })),
    },
    envelope: { feature: "F-1" },
  },
  "feature.auto_merge_enabled": {
    data: { pr_number: 12, head_sha: COMMIT, method: "squash", merge_queue: false },
    envelope: { feature: "F-1" },
  },
  "feature.auto_merge_disabled": {
    data: { reason: "head_moved", detail: "the PR head is no longer the gated commit" },
    envelope: { feature: "F-1" },
  },
  "feature.post_merge_ci": {
    data: {
      merge_commit: COMMIT,
      status: "red",
      runs: [{ name: "ci", conclusion: "failure", required: true }],
    },
    envelope: { feature: "F-1" },
  },
  "feature.reverted": {
    data: {
      merge_commit: COMMIT,
      revert: { commit: COMMIT, detected_by: "git_log" },
      detail: "This reverts commit",
    },
    envelope: { feature: "F-1" },
  },
  "final_review.step_finished": {
    data: { step: 5, status: "skipped", reason: "no browser" },
    envelope: { feature: "F-1" },
  },
  "research.fetched": {
    data: {
      scope: "_shared",
      result: {
        fetcher: "eol",
        fetcher_version: "1",
        url: "https://endoflife.date/api/v1/products/nodejs/releases/22",
        status: "ok",
        cache: "miss",
        http_status: 200,
        content_type: "application/json",
        content_sha256: SHA,
        bytes: 512,
        retrieved_at: NOW,
      },
    },
  },
  "fact.recorded": {
    data: {
      fact: {
        v: 1,
        id: "f-0123456789abcdef",
        subject: "nodejs@22",
        predicate: "eol_date",
        value: "2027-04-30",
        status: "verified",
        source: {
          fetcher: "eol",
          url: "https://endoflife.date/api/v1/products/nodejs/releases/22",
          retrieved_at: NOW,
          content_sha256: SHA,
          locator: { kind: "json_pointer", pointer: "/result/eolFrom" },
        },
        recorded_by: "engine",
        recorded_at: NOW,
      },
    },
  },
  "fact.verified": { data: { id: "f-0123456789abcdef", status: "stale" } },
  "fact.waived": { data: { id: "f-0123456789abcdef", reason: "pricing page needs a login" } },
  "lookback.dispatched": {
    data: { target_role: "engineer", target_host: "claude-code", train_failures: 6 },
  },
  "lookback.proposal_recorded": {
    data: { proposal: "p-1", path: ".vtc/lookback/proposals/engineer/proposal.json", changes: 2 },
  },
  "lookback.replay_finished": {
    data: { proposal: "p-1", verdict: "inconclusive", path: ".vtc/lookback/replays/p-1.json" },
  },
  "lookback.canary_assigned": {
    data: { arm: "candidate", candidate: SHA, baseline: "b".repeat(64) },
    envelope: { task: "T-7", role: "engineer" },
  },
  "lookback.canary_evaluated": {
    data: {
      role: "engineer",
      host: "claude-code",
      repo_key: "0123456789abcdef",
      candidate: SHA,
      baseline: "b".repeat(64),
      started_at: NOW,
      arms: {
        candidate: { dispatches: 3, escalations: 0, cap_hits: 0, tokens: 1000 },
        baseline: { dispatches: 4, escalations: 1, cap_hits: 0, tokens: 1200 },
      },
      verdict: "no_data",
      reason: "fewer than 5 dispatches in an arm",
    },
  },
  "lookback.rolled_back": {
    data: {
      target_role: "engineer",
      target_host: "claude-code",
      from: SHA,
      to: "b".repeat(64),
      reason: "tokens per dispatch up more than 20%",
    },
  },
  "lookback.escaped_defect": {
    data: { merge_commit: COMMIT, kind: "revert", tasks: ["T-7"] },
    envelope: { feature: "F-1" },
  },
  "lookback.unattributed": { data: { failures: 2, tasks: ["T-1", "T-2"] } },
  // automatic issues and PRs (AD-27, 5.0.0)
  "upstream.issue_opened": { data: { ...autoItem, number: 4, url: `${autoRepoUrl}/issues/4` } },
  "upstream.issue_updated": {
    data: { ...autoItem, number: 4, url: `${autoRepoUrl}/issues/4`, action: "commented" },
  },
  "upstream.issue_closed": {
    data: { ...autoItem, number: 4, url: `${autoRepoUrl}/issues/4`, reason: "quiet" },
  },
  "upstream.pr_opened": {
    data: {
      ...autoItem,
      number: 5,
      url: `${autoRepoUrl}/pull/5`,
      branch: "vtc/auto/defect/0123abcd",
      issue: 4,
      evidence: "partial",
    },
  },
  "upstream.pr_closed": {
    data: { ...autoItem, number: 5, url: `${autoRepoUrl}/pull/5`, reason: "superseded" },
  },
  "automation.skipped": {
    data: { reason: "rate_limit", kind: "defect", detail: "5 issues today" },
  },
};

const event = (type: CoreEventType) => ({
  v: 1,
  seq: 1,
  ts: NOW,
  run: "r1",
  type,
  actor: "engine",
  ...(examples[type].envelope ?? {}),
  data: examples[type].data,
});

describe("EVENT_PAYLOAD_SCHEMAS", () => {
  it("covers exactly the core vocabulary", () => {
    expect(Object.keys(examples).sort()).toEqual([...CORE_EVENT_TYPES].sort());
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual([...CORE_EVENT_TYPES].sort());
  });
  it.each(CORE_EVENT_TYPES)("accepts a valid %s event", (type) => {
    expectValid(EventSchema, event(type));
  });
  /** At least one invalid payload per core event type (AD-3, AD-11). */
  const invalid: readonly (readonly [CoreEventType, object, string])[] = [
    ["run.started", { ...examples["run.started"].data, merge_level: 4 }, "data.merge_level"],
    ["run.started", { ...examples["run.started"].data, request: "" }, "data.request"],
    ["run.phase_changed", { from: null, to: "deploy" }, "data.to"],
    ["run.paused", { reason: "" }, "data.reason"],
    ["run.resumed", { auto: "yes" }, "data.auto"],
    ["run.finished", { outcome: "shipped" }, "data.outcome"],
    ["run.merge_level_changed", { from: 2, to: 2, reason: "revert" }, "data.to"],
    ["gate.approved", { gates: ["G1"], frozen: [] }, "data.frozen"],
    ["gate.rejected", { gates: ["G3"] }, "data.gates.0"],
    ["task.created", { task: { ...validTask(), cap: 9 } }, "data.task.cap"],
    ["task.created", { task: validTask() }, "data.intent"],
    [
      "task.created",
      {
        task: { ...validTask(), origin: "integration_fix", source_finding: SHA },
        intent: validTaskDraft().intent,
      },
      "data.intent",
    ],
    ["task.status_changed", { from: "fixing", to: "parked", round: 5, cap: 5 }, "data.park_reason"],
    ["task.status_changed", { from: "fixing", to: "built", round: 1, cap: 9 }, "data.cap"],
    ["task.status_changed", { from: "fixing", to: "shipped", round: 1, cap: 3 }, "data.to"],
    [
      "task.status_changed",
      { from: "verifying", to: "parked", round: 1, cap: 4, park_reason: "risk_rule" },
      "data.risk_rule",
    ],
    [
      "task.workspace_assigned",
      { worktree: "/abs/T-7", branch: "vtc/T-7", baseline_revision: COMMIT },
      "data.worktree",
    ],
    ["task.session_updated", { session_ref: { host: "cursor", id: "s" } }, "data.session_ref.host"],
    ["contract.frozen", { path: "contracts/auth.yaml", sha256: "abc" }, "data.sha256"],
    ["feature.created", { feature: { ...validFeature(), tasks: [] } }, "data.feature.tasks"],
    ["feature.task_added", { task: "F-1" }, "data.task"],
    ["feature.status_changed", { from: "building", to: "merged", round: 0 }, "data.to"],
    [
      "feature.status_changed",
      { from: "final_review", to: "parked", round: 1, park_reason: "cap", risk_rule: "large_diff" },
      "data.risk_rule",
    ],
    [
      "feature.pr_updated",
      { pr: { url: "nope", draft: true, state: "open", head_sha: COMMIT, ci: "unknown" } },
      "data.pr.url",
    ],
    ["branch.pushed", { branch: "main", commit: COMMIT }, "data.branch"],
    ["branch.push_failed", { branch: "vtc/F-1", detail: "" }, "data.detail"],
    ["feature.pr_failed", { detail: "x", url: "https://github.com/acme/app/pull/1" }, "data"],
    ["role.dispatched", { ...examples["role.dispatched"].data, dispatch: "cron" }, "data.dispatch"],
    ["role.dispatched", { ...examples["role.dispatched"].data, subject: "AC-2" }, "data.subject"],
    ["role.submitted", { ...examples["role.submitted"].data, findings: -1 }, "data.findings"],
    ["role.submitted", { ...examples["role.submitted"].data, exit: "built" }, "data.head"],
    [
      "role.submitted",
      { ...examples["role.submitted"].data, verdicts: [{ subject: "T-7", verdict: "PASS" }] },
      "data.verdicts.0.verdict",
    ],
    ["role.rejected", { action_id: "a-1", reason: "vibes" }, "data.reason"],
    [
      "role.failed",
      { action_id: "a-1", kind: "limit", message: "x", retryable: true },
      "data.kind",
    ],
    ["gate.result", { ...validGateReport(), verdict: "pass" }, "data.verdict"],
    ["finding.recorded", { finding: { ...validFinding(), route: "ignore" } }, "data.finding.route"],
    ["finding.status_changed", { fingerprint: SHA, from: "open", to: "gone" }, "data.to"],
    [
      "escalation.opened",
      { escalation: { ...validEscalation(), options: [] } },
      "data.escalation.options",
    ],
    [
      "escalation.answered",
      { escalation: "E-4", answer: { option: "hint" } },
      "data.answer.who_should_have_caught",
    ],
    [
      "change_request.opened",
      { ...examples["change_request.opened"].data, artifact: "spec" },
      "data.task",
    ],
    [
      "change_request.decided",
      { ...examples["change_request.decided"].data, decision: "rejected" },
      "data.new_sha256",
    ],
    ["spec.clarified", { ...examples["spec.clarified"].data, path: "../spec.md" }, "data.path"],
    ["budget.updated", { scope: "task", budget_usd: 0, spent_usd: 1 }, "data.budget_usd"],
    ["usage.updated", { snapshot: { host: "codex" } }, "data.snapshot.source"],
    ["limit.hit", { host: "claude-code" }, "data.window"],
    ["merge.completed", { into: "main", commit: "abc1234", level: 2 }, "data.commit"],
    ["incident.recorded", { kind: "crash", detail: "x", extra: 1 }, "data"],
    // ---- contracts 4.5.0
    ["gate.requested", { gates: ["G2"], artifacts: [] }, "data.artifacts"],
    ["headless.preflight", { host: "codex", purpose: "role", ok: false }, "data.failed"],
    [
      "headless.started",
      { ...examples["headless.started"].data, wall_timeout_ms: 0 },
      "data.wall_timeout_ms",
    ],
    ["headless.ended", { ...examples["headless.ended"].data, cause: "bored" }, "data.cause"],
    ["merge.preflight", { ...examples["merge.preflight"].data, ok: true }, "data.failed"],
    ["feature.checklist", { ok: true, items: [] }, "data.items"],
    [
      "feature.auto_merge_enabled",
      { ...examples["feature.auto_merge_enabled"].data, method: "admin" },
      "data.method",
    ],
    ["feature.auto_merge_disabled", { reason: "bored", detail: "x" }, "data.reason"],
    ["feature.post_merge_ci", { merge_commit: COMMIT, status: "amber" }, "data.status"],
    ["feature.reverted", { merge_commit: "abc", detail: "x" }, "data.merge_commit"],
    ["final_review.step_finished", { step: 5, status: "skipped" }, "data.reason"],
    ["research.fetched", { scope: "client-Bad Name", result: {} }, "data.scope"],
    [
      "fact.recorded",
      { fact: { ...examples["fact.recorded"].data.fact, source: null } },
      "data.fact.source",
    ],
    ["fact.verified", { id: "fact-1", status: "verified" }, "data.id"],
    ["fact.waived", { id: "f-0123456789abcdef", reason: "" }, "data.reason"],
    [
      "lookback.dispatched",
      { target_role: "engineer", target_host: "vim", train_failures: 6 },
      "data.target_host",
    ],
    [
      "lookback.proposal_recorded",
      { ...examples["lookback.proposal_recorded"].data, changes: 4 },
      "data.changes",
    ],
    [
      "lookback.replay_finished",
      { ...examples["lookback.replay_finished"].data, verdict: "improved" },
      "data.verdict",
    ],
    ["lookback.canary_assigned", { arm: "both", candidate: SHA, baseline: SHA }, "data.arm"],
    [
      "lookback.canary_evaluated",
      { ...examples["lookback.canary_evaluated"].data, verdict: "maybe" },
      "data.verdict",
    ],
    [
      "lookback.rolled_back",
      { ...examples["lookback.rolled_back"].data, from: "abc" },
      "data.from",
    ],
    ["lookback.escaped_defect", { merge_commit: COMMIT, kind: "flaky" }, "data.kind"],
    ["lookback.unattributed", { failures: 0, tasks: [] }, "data.failures"],
    [
      "upstream.issue_opened",
      { ...examples["upstream.issue_opened"].data, kind: "nope" },
      "data.kind",
    ],
    [
      "upstream.issue_updated",
      { ...examples["upstream.issue_updated"].data, action: "deleted" },
      "data.action",
    ],
    [
      "upstream.issue_closed",
      { ...examples["upstream.issue_closed"].data, reason: "spam" },
      "data.reason",
    ],
    [
      "upstream.pr_opened",
      { ...examples["upstream.pr_opened"].data, branch: "main" },
      "data.branch",
    ],
    [
      "upstream.pr_closed",
      { ...examples["upstream.pr_closed"].data, fingerprint: "short" },
      "data.fingerprint",
    ],
    ["automation.skipped", { reason: "because", detail: "x" }, "data.reason"],
  ];
  it("has an invalid case for every core type", () => {
    expect(new Set(invalid.map(([type]) => type))).toEqual(new Set(CORE_EVENT_TYPES));
  });
  it.each(invalid)("rejects an invalid %s payload (%j)", (type, data, path) => {
    expectInvalid(EventSchema, { ...event(type), data }, path);
  });
  it("requires the envelope fields of task, feature and role events", () => {
    const { task: _t, ...noTask } = event("task.status_changed") as Record<string, unknown>;
    expectInvalid(EventSchema, noTask, "task");
    const { role: _r, ...noRole } = event("role.dispatched") as Record<string, unknown>;
    expectInvalid(EventSchema, noRole, "role");
    const { feature: _f, ...noFeature } = event("feature.created") as Record<string, unknown>;
    expectInvalid(EventSchema, noFeature, "feature");
    for (const type of [
      "feature.task_added",
      "branch.pushed",
      "branch.push_failed",
      "feature.pr_failed",
    ] as const) {
      const { feature: _g, ...rest } = event(type) as Record<string, unknown>;
      expectInvalid(EventSchema, rest, "feature");
    }
  });
  it("requires the trace fields of role runs (§1.1 #3): prompt version, host, model, spend", () => {
    for (const field of ["prompt_sha", "host", "model"]) {
      for (const type of ["role.dispatched", "role.submitted"] as const) {
        const { [field]: _gone, ...rest } = event(type) as Record<string, unknown>;
        expectInvalid(EventSchema, rest, field);
      }
    }
    for (const field of ["tokens", "cost_usd"]) {
      const { [field]: _gone, ...rest } = event("role.submitted") as Record<string, unknown>;
      expectInvalid(EventSchema, rest, field);
    }
    // null spend is allowed (unknown or unpriced), absence is not
    expectValid(EventSchema, event("role.submitted"));
  });
  it("downgrades a level-2 run without a remote (no_remote) and records config changes", () => {
    expect(
      validateEventData("run.merge_level_changed", { from: 2, to: 1, reason: "no_remote" }).ok,
    ).toBe(true);
    for (const kind of ["config_changed", "checkout_write"]) {
      expect(
        validateEventData("incident.recorded", { kind, detail: "project.yaml changed" }).ok,
      ).toBe(true);
    }
  });
  it("a built result records the snapshot commit it refers to (§6.3 steps 4–5)", () => {
    const built = { ...examples["role.submitted"].data, exit: "built", head: COMMIT };
    expect(validateEventData("role.submitted", built).ok).toBe(true);
  });
  it("leaves unknown event types open", () => {
    expect(validateEventData("research.cached", { anything: [1, 2] })).toEqual({
      ok: true,
      data: { anything: [1, 2] },
    });
    expectValid(EventSchema, { ...event("run.paused"), type: "lookback.scored", data: { x: 1 } });
  });
  it("reads a typed payload with defaults applied", () => {
    const parsed = expectValid(EventSchema, event("gate.approved"));
    expect(isEventOfType(parsed, "gate.approved")).toBe(true);
    if (isEventOfType(parsed, "gate.approved")) {
      expect(readEventData(parsed).waived_facts).toEqual([]);
    }
    expect(isEventOfType(parsed, "run.paused")).toBe(false);
  });
});

describe("SSE ids", () => {
  it("formats and parses <run>:<seq>", () => {
    expect(sseEventId("run-1", 42)).toBe("run-1:42");
    expect(parseSseEventId("run-1:42")).toEqual({ run: "run-1", seq: 42 });
    expect(parseSseEventId("2026.10.13:7")).toEqual({ run: "2026.10.13", seq: 7 });
  });
  it.each(["", "run-1", ":4", "run-1:0", "run-1:-1", "run-1:x", "../a:1", "run-1:01"])(
    "rejects %j",
    (id) => {
      expect(parseSseEventId(id)).toBeNull();
    },
  );
  it("refuses to format an invalid id", () => {
    expect(() => sseEventId("a/b", 1)).toThrow();
    expect(() => sseEventId("r1", 0)).toThrow();
  });
});
