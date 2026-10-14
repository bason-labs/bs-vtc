/**
 * What Lookback feeds engine core and the upstream module (spine §5 readings 190, 196 and 198):
 * - D-bv cost regression: a role's quality per token (`tokens_per_success`) or cost per task worse
 *   than its baseline version's beyond `LOOKBACK_LIMITS.maxTokenRisePct`, with a lookback target
 *   aimed at tokens (still at most three changes to the editable section);
 * - D-cd new agent: recurring attributed failures in a discipline or stack with no fitting
 *   specialist, or escalations naming a role that does not exist; evidence-only (`needs-eval`);
 * - D-cb: a replay verdict `improve` is what opens the bs-vtc PR.
 * Each comes with the VTC-side fields of an `UpstreamReport` (D-by: no project data).
 */
import {
  AUTO_LABELS,
  effectivePromptSha,
  LOOKBACK_LIMITS,
  sha256Hex,
  UpstreamReportSchema,
  type Attribution,
  type ReplayResult,
} from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  attributeRun,
  computeScorecards,
  costRegressions,
  costReportFields,
  improvementReportFields,
  lookbackAtRunEnd,
  lookbackTargets,
  newAgentReportFields,
  newAgentSignals,
  promptVersionRef,
  renderLookbackInput,
  traceSlug,
  traceSplit,
  type InstalledRole,
} from "../../src/lookback/index.js";
import { EFFECTIVE, EDITABLE_SHA, HOST, LOCKED, lockedShaFor, RunLog, tempDir } from "./log.js";

const now = new Date("2026-10-15T09:00:00.000Z");
const BUNDLE = "9".repeat(64);
const NEW_EDITABLE = "Explain every step in detail before acting.";
const NEW = {
  effective: effectivePromptSha(LOCKED, NEW_EDITABLE),
  editable: sha256Hex(NEW_EDITABLE),
};
const OLD = { effective: EFFECTIVE, editable: EDITABLE_SHA };
const reportBase = {
  v: 1,
  fingerprint: "0123456789abcdef",
  vtc_version: "0.5.0",
  occurrences: 1,
  first_seen: now.toISOString(),
  last_seen: now.toISOString(),
} as const;

/** `n` successful Engineer tasks per version: the old one first, then the new one. */
const twoVersions = (
  n: number,
  old: { tokens: number; cost: number },
  next: { tokens: number; cost: number },
): RunLog => {
  const log = new RunLog("r1");
  for (let i = 1; i <= 2 * n; i += 1) {
    const task = `T-${String(i)}`;
    const v = i <= n ? old : next;
    log.dispatch("engineer", {
      task,
      tokens: v.tokens,
      cost: v.cost,
      prompt: i <= n ? OLD : NEW,
    });
    log.gate(task, true);
  }
  return log;
};

const cardsOf = (log: RunLog, bundle = BUNDLE) =>
  computeScorecards({
    events: log.events,
    attributions: [],
    lockedShaFor,
    graderBundleSha: bundle,
    now,
  });

describe("cost regression (D-bv)", () => {
  it("flags tokens per success and cost per task worse than the baseline version beyond the limit", () => {
    const log = twoVersions(12, { tokens: 1000, cost: 0.1 }, { tokens: 1500, cost: 0.2 });
    const found = costRegressions({ scorecards: cardsOf(log), history: log.events, lockedShaFor });
    expect(
      found.map((r) => [r.metric, r.baseline_value, r.current_value, Math.round(r.delta_pct)]),
    ).toEqual([
      ["tokens_per_success", 1000, 1500, 50],
      ["cost_per_task", 0.1, 0.2, 100],
    ]);
    const [first] = found;
    expect(first).toMatchObject({
      role: "engineer",
      host: HOST,
      baseline: { effective_sha256: OLD.effective },
      current: { effective_sha256: NEW.effective },
      n: { baseline: 12, current: 12 },
    });
  });

  it("names the current version's costliest train-split dispatches the proposal may cite", () => {
    const log = twoVersions(12, { tokens: 1000, cost: 0.1 }, { tokens: 1500, cost: 0.2 });
    const [regression] = costRegressions({
      scorecards: cardsOf(log),
      history: log.events,
      lockedShaFor,
    });
    const traces = regression?.traces ?? [];
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.length).toBeLessThanOrEqual(10);
    for (const t of traces) {
      expect(traceSplit(t)).toBe("train");
      expect(t.tokens).toBe(1500);
      expect(t.id).toBe(traceSlug(t));
    }
  });

  it("stays quiet within the limit, below the scorecard minimum n, or across grader bundles", () => {
    const within = twoVersions(
      12,
      { tokens: 1000, cost: 0.1 },
      { tokens: 1000 * (1 + LOOKBACK_LIMITS.maxTokenRisePct / 100), cost: 0.1 },
    );
    expect(
      costRegressions({ scorecards: cardsOf(within), history: within.events, lockedShaFor }),
    ).toEqual([]);
    const thin = twoVersions(
      LOOKBACK_LIMITS.minScorecardN - 1,
      { tokens: 1000, cost: 0.1 },
      { tokens: 3000, cost: 0.3 },
    );
    expect(
      costRegressions({ scorecards: cardsOf(thin), history: thin.events, lockedShaFor }),
    ).toEqual([]);
    const log = twoVersions(12, { tokens: 1000, cost: 0.1 }, { tokens: 1500, cost: 0.2 });
    const cards = cardsOf(log);
    const mixed = cards.map((c) =>
      c.prompt.effective_sha256 === NEW.effective ? { ...c, grader_bundle_sha: "8".repeat(64) } : c,
    );
    expect(costRegressions({ scorecards: mixed, history: log.events, lockedShaFor })).toEqual([]);
  });

  it("aims a lookback target at tokens once per version, under the weekly window and budget", () => {
    const log = twoVersions(12, { tokens: 1000, cost: 0.1 }, { tokens: 1500, cost: 0.2 });
    const regressions = costRegressions({
      scorecards: cardsOf(log),
      history: log.events,
      lockedShaFor,
    });
    const chosen = lookbackTargets({
      attributions: [],
      fresh: new Set(),
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      costRegressions: regressions,
    });
    expect(
      chosen.targets.map((t) => [t.role, t.base.effective_sha256, t.train_failures, t.cost.length]),
    ).toEqual([["engineer", NEW.effective, 0, 2]]);
    // a lookback run already dispatched for the target since the version started: not again
    const since = regressions[0]?.since ?? "";
    expect(
      lookbackTargets({
        attributions: [],
        fresh: new Set(),
        weeklyRemainingPct: 80,
        budgetAvailable: true,
        costRegressions: regressions,
        lookbackDispatched: [{ role: "engineer", host: HOST, ts: since }],
      }).targets,
    ).toEqual([]);
    expect(
      lookbackTargets({
        attributions: [],
        fresh: new Set(),
        weeklyRemainingPct: 5,
        budgetAvailable: true,
        costRegressions: regressions,
      }),
    ).toEqual({ targets: [], skipped: "weekly_window" });
  });

  it("tells the lookback role to aim at tokens within three changes to the editable section", () => {
    const log = twoVersions(12, { tokens: 1000, cost: 0.1 }, { tokens: 1500, cost: 0.2 });
    const regressions = costRegressions({
      scorecards: cardsOf(log),
      history: log.events,
      lockedShaFor,
    });
    const [target] = lookbackTargets({
      attributions: [],
      fresh: new Set(),
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      costRegressions: regressions,
    }).targets;
    if (target === undefined) throw new Error("no target");
    const input = renderLookbackInput({
      target,
      texts: { locked: LOCKED, editable: NEW_EDITABLE },
      attributions: new Map(),
      history: log.events,
    });
    expect(input).toContain("## Cost regression (aim: tokens)");
    const [first] = target.cost[0]?.traces ?? [];
    expect(input).toContain(`### ${first?.id ?? "?"}`);
    expect(input).toContain("- tokens 1500");
    expect(input).toContain("tokens_per_success: 1000 -> 1500 (+50%)");
    expect(input).toContain("`target_metric` `tokens_per_success`");
    expect(input).toContain("at most 3 changes");
  });

  it("reports VTC-side fields only", () => {
    const log = twoVersions(12, { tokens: 1000, cost: 0.1 }, { tokens: 1500, cost: 0.2 });
    const [regression] = costRegressions({
      scorecards: cardsOf(log),
      history: log.events,
      lockedShaFor,
    });
    if (regression === undefined) throw new Error("none");
    const fields = costReportFields(regression);
    expect(fields).toEqual({
      kind: "cost",
      role: "engineer",
      host: HOST,
      prompt_sha: NEW.effective,
      metrics: {
        "tokens_per_success.baseline": 1000,
        "tokens_per_success.current": 1500,
        "tokens_per_success.delta_pct": 50,
        "n.baseline": 12,
        "n.current": 12,
      },
    });
    expect(UpstreamReportSchema.safeParse({ ...reportBase, ...fields }).success).toBe(true);
  });

  it("comes out of the run end with the scorecards", async () => {
    const log = twoVersions(12, { tokens: 1000, cost: 0.1 }, { tokens: 1500, cost: 0.2 });
    const end = await lookbackAtRunEnd({
      projectRoot: await tempDir("cost-end"),
      events: log.events,
      history: log.events,
      lockedShaFor,
      graderBundleSha: BUNDLE,
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      now,
    });
    expect(end.costRegressions.map((r) => r.metric)).toEqual([
      "tokens_per_success",
      "cost_per_task",
    ]);
    expect(end.targets.map((t) => t.cost.length)).toEqual([2]);
    expect(end.events.map((e) => e.type)).toEqual(["lookback.dispatched"]);
  });
});

const ROLES: InstalledRole[] = [
  { id: "engineer", kind: "core" },
  { id: "qa", kind: "core" },
  { id: "spec_verifier", kind: "core" },
  { id: "engineer_backend", kind: "engineer_profile", discipline: "backend" },
];

/**
 * Failing Engineer tasks of `discipline` (`stack`), each round gate failed. The dispatched role is
 * `engineer` whether or not a profile ran it (§5.2a, reading 38).
 */
const failing = (log: RunLog, from: number, n: number, discipline: string, stack: string[]) => {
  for (let i = from; i < from + n; i += 1) {
    const task = `T-${String(i)}`;
    log.taskCreated(task, discipline, stack);
    log.dispatch("engineer", { task });
    log.gate(task, false);
  }
};

const attributed = (log: RunLog): Attribution[] =>
  attributeRun({ events: log.events, lockedShaFor, now }).attributions;

describe("new agent (D-cd)", () => {
  it("proposes a specialist for a discipline with recurring failures and no engineer profile", () => {
    const log = new RunLog();
    failing(log, 1, LOOKBACK_LIMITS.minTrainFailures, "web3", ["solidity"]);
    failing(log, 20, LOOKBACK_LIMITS.minTrainFailures, "backend", []);
    const signals = newAgentSignals({
      attributions: attributed(log),
      history: log.events,
      roles: ROLES,
    });
    expect(signals).toEqual([
      expect.objectContaining({
        kind: "new_agent",
        basis: "discipline_failures",
        proposed_role: "engineer_web3",
        discipline: "web3",
        stack_packs: ["solidity"],
        failures: LOOKBACK_LIMITS.minTrainFailures,
        escalations: 0,
        evidence_only: true,
        labels: [AUTO_LABELS.needsEval],
      }),
    ]);
    expect(signals[0]?.traces).toHaveLength(LOOKBACK_LIMITS.minTrainFailures);
  });

  it("stays quiet below the threshold", () => {
    const log = new RunLog();
    failing(log, 1, LOOKBACK_LIMITS.minTrainFailures - 1, "web3", []);
    expect(
      newAgentSignals({ attributions: attributed(log), history: log.events, roles: ROLES }),
    ).toEqual([]);
  });

  it("proposes a stack specialist when a specialist's failures recur on a stack none covers", () => {
    const log = new RunLog();
    failing(log, 1, LOOKBACK_LIMITS.minTrainFailures, "backend", ["elixir"]);
    const signals = newAgentSignals({
      attributions: attributed(log),
      history: log.events,
      roles: ROLES,
    });
    expect(signals.map((s) => [s.basis, s.proposed_role, s.discipline, s.stack_packs])).toEqual([
      ["stack_failures", "engineer_elixir", "backend", ["elixir"]],
    ]);
    const covered = newAgentSignals({
      attributions: attributed(log),
      history: log.events,
      roles: [
        ...ROLES,
        {
          id: "engineer_elixir",
          kind: "engineer_profile",
          discipline: "backend",
          stack_packs: ["elixir"],
        },
      ],
    });
    expect(covered).toEqual([]);
  });

  it("proposes the role escalations keep naming when no such role is installed", () => {
    const log = new RunLog();
    log.escalate("T-1", "accessibility_auditor", "blocked");
    log.escalate("T-2", "accessibility_auditor", "blocked");
    log.escalate("T-3", "qa", "blocked");
    log.escalate("T-4", "none", "blocked");
    const signals = newAgentSignals({ attributions: [], history: log.events, roles: ROLES });
    expect(signals.map((s) => [s.basis, s.proposed_role, s.escalations])).toEqual([
      ["missing_role", "accessibility_auditor", 2],
    ]);
  });

  it("reports VTC-side fields only", () => {
    const log = new RunLog();
    failing(log, 1, LOOKBACK_LIMITS.minTrainFailures, "web3", ["solidity"]);
    const [signal] = newAgentSignals({
      attributions: attributed(log),
      history: log.events,
      roles: ROLES,
    });
    if (signal === undefined) throw new Error("none");
    const fields = newAgentReportFields(signal);
    expect(fields).toEqual({
      kind: "new_agent",
      role: "engineer_web3",
      metrics: { failures: LOOKBACK_LIMITS.minTrainFailures, escalations: 0 },
    });
    expect(UpstreamReportSchema.safeParse({ ...reportBase, ...fields }).success).toBe(true);
  });

  it("comes out of the run end when the installed roles are given", async () => {
    const log = new RunLog();
    failing(log, 1, LOOKBACK_LIMITS.minTrainFailures, "web3", []);
    const end = await lookbackAtRunEnd({
      projectRoot: await tempDir("agent-end"),
      events: log.events,
      history: log.events,
      lockedShaFor,
      graderBundleSha: BUNDLE,
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      now,
      roles: ROLES,
    });
    expect(end.newAgents.map((s) => s.proposed_role)).toEqual(["engineer_web3"]);
  });
});

describe("an improve verdict opens the bs-vtc PR (D-cb)", () => {
  const result = (verdict: ReplayResult["verdict"]): ReplayResult => ({
    v: 1,
    proposal: "p-1",
    role: "engineer",
    host: HOST,
    baseline: OLD.effective,
    candidate: NEW.effective,
    grader_bundle_sha: BUNDLE,
    k: 3,
    per_task: [{ task: "r1:T-1", a: [false], b: [true], regression_set: false }],
    aa_flip_rate: 0.1,
    sign_test: { n_discordant: 6, wins_b: 6, p: 0.015625 },
    tokens_delta_pct: -4,
    verdict,
    finished_at: now.toISOString(),
    isolation: "read_denied",
    grader: "verdict",
  });

  it("reports the replay's evidence for an improve, and nothing otherwise", () => {
    const fields = improvementReportFields(result("improve"));
    expect(fields).toEqual({
      kind: "lookback",
      role: "engineer",
      host: HOST,
      prompt_sha: NEW.effective,
      metrics: {
        "replay.k": 3,
        "replay.tasks": 1,
        "replay.n_discordant": 6,
        "replay.wins_b": 6,
        "replay.p": 0.015625,
        "replay.aa_flip_rate": 0.1,
        "replay.tokens_delta_pct": -4,
        "replay.read_denied": 1,
        "replay.verdict_graded": 1,
      },
    });
    expect(UpstreamReportSchema.safeParse({ ...reportBase, ...fields }).success).toBe(true);
    for (const verdict of ["regress", "no_change", "inconclusive"] as const)
      expect(improvementReportFields(result(verdict))).toBeNull();
  });
});

describe("the train split stays the lookback role's only view", () => {
  it("keeps held-out traces out of a cost-aimed target", () => {
    const log = twoVersions(12, { tokens: 1000, cost: 0.1 }, { tokens: 1500, cost: 0.2 });
    const base = promptVersionRef({
      role: "engineer",
      host: HOST,
      locked: LOCKED,
      editable: NEW_EDITABLE,
    });
    const heldOut: Attribution = {
      v: 1,
      trace: "x-1",
      run: "r1",
      prompt: base,
      outcome: "failure",
      blamed_role: "engineer",
      method: "tree",
      rule: "test_fails",
      confidence: 1,
      split: "holdout",
      evidence: [],
      attributed_at: now.toISOString(),
    };
    const regressions = costRegressions({
      scorecards: cardsOf(log),
      history: log.events,
      lockedShaFor,
    });
    const [target] = lookbackTargets({
      attributions: [heldOut],
      fresh: new Set(),
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      costRegressions: regressions,
    }).targets;
    expect(target?.traces).toEqual([]);
  });
});
