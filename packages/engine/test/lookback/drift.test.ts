/**
 * The drift baseline (D-cr; spine §5 reading 226): besides the version before it, a prompt version
 * is compared with its own window `LOOKBACK_LIMITS.driftWindowDays` days earlier, so a model or host
 * update that degrades an unchanged prompt raises a cost regression, marked `time_window`.
 */
import { LOOKBACK_LIMITS, UpstreamReportSchema, type VtcEvent } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  attributeRun,
  computeScorecards,
  costRegressions,
  costReportFields,
  isRoleFailure,
  lookbackTargets,
} from "../../src/lookback/index.js";
import { EFFECTIVE, HOST, lockedShaFor, RunLog } from "./log.js";

const BUNDLE = "9".repeat(64);
const now = new Date("2026-10-15T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** `n` successful Engineer tasks of the unchanged prompt in one run starting at `start`. */
const runAt = (
  run: string,
  start: string,
  n: number,
  each: { tokens: number; cost: number; fail?: number },
): VtcEvent[] => {
  const log = new RunLog(run, start);
  for (let i = 1; i <= n; i += 1) {
    const task = `T-${String(i)}`;
    log.dispatch("engineer", { task, tokens: each.tokens, cost: each.cost });
    log.gate(task, i > (each.fail ?? 0));
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
});
