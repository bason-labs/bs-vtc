/**
 * The drift baseline (D-cr; spine §5 reading 226): besides the version before it, a prompt version
 * is compared with its own window `LOOKBACK_LIMITS.driftWindowDays` days earlier, so a model or host
 * update that degrades an unchanged prompt raises a cost regression, marked `time_window`.
 */
import { LOOKBACK_LIMITS, UpstreamReportSchema, type VtcEvent } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import type { AutomationFact } from "../../src/core/index.js";
import { upstreamModuleFact } from "../../src/daemon/upstream-bridge.js";
import {
  attributeRun,
  computeScorecards,
  costRegressions,
  costReportFields,
  DRIFT_BASELINE_SUFFIX,
  isRoleFailure,
  lookbackRunEndFacts,
  lookbackTargets,
  routingProposals,
} from "../../src/lookback/index.js";
import { evaluateTrigger } from "../../src/upstream/index.js";
import { EFFECTIVE, HOST, lockedShaFor, RunLog } from "./log.js";

const BUNDLE = "9".repeat(64);
const now = new Date("2026-10-15T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** `n` successful Engineer tasks of the unchanged prompt in one run starting at `start`. */
const runAt = (
  run: string,
  start: string,
  n: number,
  each: { tokens: number; cost: number; fail?: number; escalate?: number },
): VtcEvent[] => {
  const log = new RunLog(run, start);
  for (let i = 1; i <= n; i += 1) {
    const task = `T-${String(i)}`;
    log.dispatch("engineer", { task, tokens: each.tokens, cost: each.cost });
    log.gate(task, i > (each.fail ?? 0));
    if (i <= (each.escalate ?? 0)) log.escalate(task);
  }
  return log.events;
};

const regressionsOf = (history: VtcEvent[]) =>
  costRegressions({
    scorecards: computeScorecards({
      events: history,
      attributions: [],
      lockedShaFor,
      graderBundleSha: BUNDLE,
      now,
    }),
    history,
    lockedShaFor,
  });

describe("the drift baseline (D-cr)", () => {
  it("flags an unchanged prompt whose latest window costs more than its own earlier window", () => {
    expect(LOOKBACK_LIMITS.driftWindowDays).toBe(14);
    const history = [
      ...runAt("r1", "2026-09-01T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1 }),
      ...runAt("r2", "2026-09-20T10:00:00.000Z", 12, { tokens: 1500, cost: 0.2 }),
    ];
    const found = regressionsOf(history);
    expect(
      found.map((r) => [r.baseline_kind, r.metric, r.baseline_value, r.current_value, r.delta_pct]),
    ).toEqual([
      ["time_window", "tokens_per_success", 1000, 1500, 50],
      ["time_window", "cost_per_task", 0.1, 0.2, 100],
    ]);
    const [first] = found;
    expect(first).toMatchObject({
      role: "engineer",
      host: HOST,
      baseline: { effective_sha256: EFFECTIVE },
      current: { effective_sha256: EFFECTIVE },
      n: { baseline: 12, current: 12 },
    });
    // the windows the issue names: the latest 14 days and the 14 days before them
    const to = Date.parse(first?.windows?.current.to ?? "");
    expect(Date.parse(first?.windows?.current.from ?? "")).toBe(to - 14 * DAY);
    expect(first?.windows?.baseline).toEqual({
      from: new Date(to - 28 * DAY).toISOString(),
      to: new Date(to - 14 * DAY).toISOString(),
    });
    expect(first?.since).toBe(first?.windows?.current.from);
    expect(first?.traces.every((t) => t.run === "r2")).toBe(true);
  });

  it("counts a quality drop as a rise in tokens per success", () => {
    const r1 = runAt("r1", "2026-09-01T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1 });
    // the same tokens, but half the tasks fail their round gate: the role's failures
    const r2 = runAt("r2", "2026-09-20T10:00:00.000Z", 24, { tokens: 1000, cost: 0.1, fail: 12 });
    const history = [...r1, ...r2];
    const attributions = [r1, r2].flatMap(
      (events) => attributeRun({ events, lockedShaFor, now }).attributions,
    );
    expect(attributions.filter(isRoleFailure)).toHaveLength(12);
    const found = costRegressions({
      scorecards: computeScorecards({
        events: history,
        attributions,
        lockedShaFor,
        graderBundleSha: BUNDLE,
        now,
      }),
      history,
      lockedShaFor,
      attributions,
    });
    expect(
      found.map((r) => [r.baseline_kind, r.metric, r.baseline_value, r.current_value]),
    ).toEqual([["time_window", "tokens_per_success", 1000, 2000]]);
  });

  it("stays quiet for a steady prompt, a thin earlier window or one under another grader", () => {
    const steady = [
      ...runAt("r1", "2026-09-01T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1 }),
      ...runAt("r2", "2026-09-20T10:00:00.000Z", 12, { tokens: 1100, cost: 0.11 }),
    ];
    expect(regressionsOf(steady)).toEqual([]);
    const thin = [
      ...runAt("r1", "2026-09-01T10:00:00.000Z", LOOKBACK_LIMITS.minScorecardN - 1, {
        tokens: 1000,
        cost: 0.1,
      }),
      ...runAt("r2", "2026-09-20T10:00:00.000Z", 12, { tokens: 3000, cost: 0.3 }),
    ];
    expect(regressionsOf(thin)).toEqual([]);
    // both windows inside the latest 14 days: nothing to compare
    const recent = [
      ...runAt("r1", "2026-09-15T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1 }),
      ...runAt("r2", "2026-09-20T10:00:00.000Z", 12, { tokens: 3000, cost: 0.3 }),
    ];
    expect(regressionsOf(recent)).toEqual([]);
  });

  it("says which baseline in the report fields, and stays a valid upstream report", () => {
    const history = [
      ...runAt("r1", "2026-09-01T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1 }),
      ...runAt("r2", "2026-09-20T10:00:00.000Z", 12, { tokens: 1500, cost: 0.2 }),
    ];
    const [regression] = regressionsOf(history);
    if (regression === undefined) throw new Error("none");
    const fields = costReportFields(regression);
    expect(fields.metrics).toMatchObject({
      "tokens_per_success.baseline": 1000,
      "tokens_per_success.current": 1500,
      "baseline.time_window": 1,
      "baseline.window_days": 14,
    });
    expect(fields.prompt_sha).toBe(EFFECTIVE);
    const report = {
      v: 1,
      fingerprint: "0123456789abcdef",
      vtc_version: "0.5.0",
      occurrences: 1,
      first_seen: now.toISOString(),
      last_seen: now.toISOString(),
      ...fields,
    };
    expect(UpstreamReportSchema.safeParse(report).success).toBe(true);
  });

  it("makes the drifting version a lookback target aimed at tokens", () => {
    const history = [
      ...runAt("r1", "2026-09-01T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1 }),
      ...runAt("r2", "2026-09-20T10:00:00.000Z", 12, { tokens: 1500, cost: 0.2 }),
    ];
    const chosen = lookbackTargets({
      attributions: [],
      fresh: new Set(),
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      costRegressions: regressionsOf(history),
    });
    expect(chosen.targets.map((t) => [t.role, t.base.effective_sha256, t.cost.length])).toEqual([
      ["engineer", EFFECTIVE, 2],
    ]);
  });

  it("catches a quality drop without attributed failures: escalations at the rollback ratio", () => {
    const history = [
      ...runAt("r1", "2026-09-01T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1, escalate: 2 }),
      ...runAt("r2", "2026-09-20T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1, escalate: 4 }),
    ];
    const found = regressionsOf(history);
    expect(found.map((r) => [r.baseline_kind, r.metric, r.delta_pct])).toEqual([
      ["time_window", "escalations_per_100", 100],
    ]);
    // a quality rate is an upstream fact, not a lookback target aimed at tokens
    const chosen = lookbackTargets({
      attributions: [],
      fresh: new Set(),
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      costRegressions: found,
    });
    expect(chosen.targets).toEqual([]);
    // below the ratio: quiet
    const mild = [
      ...runAt("r1", "2026-09-01T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1, escalate: 3 }),
      ...runAt("r2", "2026-09-20T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1, escalate: 5 }),
    ];
    expect(regressionsOf(mild)).toEqual([]);
  });
});

describe("the run-end automation facts (AD-27 issue -> PR path)", () => {
  const drifting = [
    ...runAt("r1", "2026-09-01T10:00:00.000Z", 12, { tokens: 1000, cost: 0.1 }),
    ...runAt("r2", "2026-09-20T10:00:00.000Z", 12, { tokens: 1500, cost: 0.2 }),
  ];
  const at = now.toISOString();

  it("maps a drift regression to a cost fact the upstream module takes, cost per task left out", () => {
    const facts = lookbackRunEndFacts(
      "r2",
      { costRegressions: regressionsOf(drifting), routing: routingProposals(emptyCard) },
      at,
    );
    expect(facts).toMatchObject([
      {
        target: "upstream",
        kind: "cost",
        run: "r2",
        source: "lookback.drift",
        role: "engineer",
        host: HOST,
        promptSha: EFFECTIVE,
        baselinePromptSha: `${EFFECTIVE}${DRIFT_BASELINE_SUFFIX}`,
        metric: "tokens_per_success",
        baseline: 1000,
        current: 1500,
      },
    ]);
    const item = evaluateTrigger(upstreamFact(facts[0]), { vtcVersion: "0.5.0" });
    expect(item).toMatchObject({ target: "upstream", kind: "cost" });
  });

  it("gives a drift of V and a later version's regression against V distinct fingerprints", () => {
    const [drift] = lookbackRunEndFacts(
      "r2",
      { costRegressions: regressionsOf(drifting), routing: routingProposals(emptyCard) },
      at,
    );
    if (drift === undefined) throw new Error("no drift fact");
    // engine core's previous-version fact (`costRegressionFacts`) of W against V
    const later: AutomationFact = {
      target: "upstream",
      kind: "cost",
      run: "r3",
      source: "lookback.scorecards",
      at,
      role: "engineer",
      host: HOST,
      promptSha: "c".repeat(64),
      baselinePromptSha: EFFECTIVE,
      metric: "tokens_per_success",
      baseline: 1000,
      current: 1500,
      detail: "engineer: tokens_per_success went up against its previous prompt version",
    };
    const a = evaluateTrigger(upstreamFact(drift), { vtcVersion: "0.5.0" });
    const b = evaluateTrigger(upstreamFact(later), { vtcVersion: "0.5.0" });
    expect(a?.fingerprint).toBeDefined();
    expect(b?.fingerprint).toBeDefined();
    expect(a?.fingerprint).not.toBe(b?.fingerprint);
    // the same drift seen at the next run's end dedupes onto the same issue
    const [again] = lookbackRunEndFacts(
      "r3",
      { costRegressions: regressionsOf(drifting), routing: routingProposals(emptyCard) },
      at,
    );
    expect(evaluateTrigger(upstreamFact(again), { vtcVersion: "0.5.0" })?.fingerprint).toBe(
      a?.fingerprint,
    );
  });

  it("maps each routing change to a config improvement fact", () => {
    const facts = lookbackRunEndFacts(
      "r2",
      { costRegressions: [], routing: routingProposals(escalatingCard) },
      at,
    );
    expect(facts).toMatchObject([
      {
        target: "upstream",
        kind: "config",
        run: "r2",
        source: "lookback.routing",
        role: "engineer",
        subject: "routing.engineer.S.none",
      },
    ]);
    const item = evaluateTrigger(upstreamFact(facts[0]), { vtcVersion: "0.5.0" });
    expect(item).toMatchObject({ target: "upstream", kind: "config" });
  });
});

const emptyCard = {
  v: 1 as const,
  grader_bundle_sha: BUNDLE,
  window: { from: now.toISOString(), to: now.toISOString() },
  cells: [],
  written_at: now.toISOString(),
};

const escalatingCard = {
  ...emptyCard,
  cells: [
    {
      role: "engineer",
      host: HOST,
      size: "S" as const,
      risk: "none" as const,
      start_tier: "low" as const,
      start_reason: "rule" as const,
      tasks: 12,
      metrics: {},
      escalated: { value: 0.9, ci_low: null, ci_high: null, n: 12 },
      cost_per_task_usd: { value: 0.1, ci_low: null, ci_high: null, n: 12 },
    },
  ],
};

/** The upstream module's fact for an engine fact, as the daemon's bridge maps it. */
const upstreamFact = (fact: AutomationFact | undefined) => {
  const mapped = fact === undefined ? null : upstreamModuleFact(fact);
  if (mapped === null) throw new Error("the bridge does not take the fact");
  return mapped;
};
