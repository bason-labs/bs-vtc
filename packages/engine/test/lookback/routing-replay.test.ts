/**
 * Tier replays (D-cn; spine §5 reading 247(6)): Lookback plans a tier replay of a routing change
 * within the RETRO's trial budget (the same prompt version on both arms, arm `a` on the cell's
 * current start tier and arm `b` on the proposed one), keeps its graded trials in the replay ledger
 * across RETROs, grades it into a `RoutingReplayResult` with the paired sign test, and raises the
 * routing `config` fact only once the replay is graded, its trials' events show each ran on its
 * arm's tier, and it backs the change (`routingReplayBacks`). With no budget, or through engine
 * core's seam (`lookbackRoutingStep`), the fact carries the scorecard alone, as before; through the
 * seam, a change whose replay the budget had room for says in its detail that it was not replayed.
 */
import {
  engineRepoKey,
  LOOKBACK_HOME,
  LOOKBACK_LIMITS,
  ReplayInfraRowSchema,
  ReplayTrialRowSchema,
  ROUTING_FACT_METRICS,
  ROUTING_REPLAY_VERDICT_CODES,
  routingReplayId,
  routingReplayPath,
  RoutingReplayResultSchema,
  type ModelTier,
  type ReplayInfraOutcome,
  type RoutingTable,
  type VtcEvent,
} from "@vtc/shared";
import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type RoutingLookback } from "../../src/daemon/index.js";
import {
  assembleRoutingReplay,
  lookbackRoutingStep,
  planRoutingReplayTrials,
  readReplayLedger,
  recordRoutingReplayTrial,
  routingReplayCosts,
  routingReplayStep,
  routingReplayTrialTiers,
  traceSplit,
  type ReplayTrialRow,
  type RoutingReplayLaunch,
  type RoutingReplayTrial,
} from "../../src/lookback/index.js";
import { EFFECTIVE, EDITABLE_SHA, HOST, LOCKED_SHA, lockedShaFor, RunLog, tempDir } from "./log.js";

const DCM: RoutingTable = {
  v: 1,
  by_size: { S: "low", M: "mid", L: "top" },
  tagged_floor: "mid",
  high_floor: "top",
  high_risk_tags: ["auth", "payments", "data", "security", "migration"],
};

const BUNDLE = "9".repeat(64);
const OTHER = "8".repeat(64);
const now = new Date("2026-10-15T09:00:00.000Z");
const PACE = { failureTasks: 5, regressionTasks: 2 };
const K = LOOKBACK_LIMITS.replayTrials;

/** Action ids of run `r1` whose dispatches are held out (AD-21 rule 6), in order. */
const heldOut = (n: number, from = 1): string[] => {
  const ids: string[] = [];
  for (let i = from; ids.length < n && i < 10_000; i += 1) {
    const action = `act-${String(i)}`;
    if (traceSplit({ run: "r1", trace: action }) === "holdout") ids.push(action);
  }
  return ids;
};

/**
 * 12 S tasks (no tag) the Engineer started on Low, the first 7 escalating to Mid: the scorecard
 * backs Low -> Mid. Every first dispatch is held out, so a tier replay has 7 failures and 5
 * regression-set tasks to sample.
 */
const lowStarts = (roles: readonly string[] = ["engineer"]): VtcEvent[] => {
  const log = new RunLog();
  const ids = heldOut(12 * roles.length);
  roles.forEach((role, r) => {
    for (let i = 1; i <= 12; i += 1) {
      const n = 12 * r + i;
      const task = `T-${String(n)}`;
      log.taskCreated(task, "backend", [], { size: "S", risk: "low", riskTags: [] });
      log.dispatch(role, { task, tier: "low", tierReason: "rule", action: ids[n - 1] ?? "" });
      log.gate(task, i > 7);
      if (i <= 7) {
        log.dispatch(role, { task, tier: "mid", tierReason: "escalation" });
        log.gate(task, true);
      }
    }
  });
  return log.events;
};

/**
 * 10 M tasks started on Mid by the rule and 10 started on Low (a `routing.start: role` arm), every
 * one passing its first round: the scorecard backs a cheaper Mid -> Low start.
 */
const midStarts = (): VtcEvent[] => {
  const log = new RunLog();
  const ids = heldOut(10);
  for (let i = 1; i <= 10; i += 1) {
    const task = `T-${String(i)}`;
    log.taskCreated(task, "backend", [], { size: "M", risk: "low", riskTags: [] });
    log.dispatch("engineer", { task, tier: "mid", tierReason: "rule", action: ids[i - 1] ?? "" });
    log.gate(task, true);
  }
  for (let i = 11; i <= 20; i += 1) {
    const task = `T-${String(i)}`;
    log.taskCreated(task, "backend", [], { size: "M", risk: "low", riskTags: [] });
    log.dispatch("engineer", { task, tier: "low", tierReason: "role" });
    log.gate(task, true);
  }
  return log.events;
};

const LOW_MID = routingReplayId("engineer", "S", "none", "low", "mid");
const MID_LOW = routingReplayId("engineer", "M", "none", "mid", "low");

interface Setup {
  readonly root: string;
  readonly home: string;
  readonly repoKey: string;
  /** The tier replay trials' own events, as the caller logs them (`replayEvents`). */
  readonly trials: RunLog;
}

const setup = async (name: string): Promise<Setup> => {
  const root = await tempDir(`routing-replay-${name}`);
  const home = await tempDir(`routing-replay-home-${name}`);
  return { root, home, repoKey: engineRepoKey(root), trials: new RunLog("replays") };
};

const step = (
  s: Setup,
  history: readonly VtcEvent[],
  extra: {
    trialBudget?: number;
    replayEvents?: readonly VtcEvent[];
    graderBundleSha?: string;
    pace?: { failureTasks: number; regressionTasks: number };
  } = {},
) =>
  routingReplayStep({
    table: DCM,
    projectRoot: s.root,
    history,
    graderBundleSha: extra.graderBundleSha ?? BUNDLE,
    now,
    lockedShaFor,
    vtcHome: s.home,
    pace: extra.pace ?? PACE,
    replayEvents: extra.replayEvents ?? s.trials.events,
    ...(extra.trialBudget === undefined ? {} : { trialBudget: extra.trialBudget }),
  });

/** The trial's `role.dispatched.replay`. */
const refOf = (proposal: string, t: RoutingReplayTrial) => ({
  proposal,
  task: t.task,
  arm: t.arm,
  trial: t.trial,
  tier: t.tier,
});

/**
 * Runs `trials` (each one's dispatch logged on its arm's tier, or where `ranOn` says) and records
 * them in the ledger as graded: `passed` decides each one.
 */
const grade = async (
  s: Setup,
  proposal: string,
  trials: readonly RoutingReplayTrial[],
  passed: (t: RoutingReplayTrial) => boolean,
  options: {
    prompt?: string;
    tokens?: (t: RoutingReplayTrial) => number;
    ranOn?: (t: RoutingReplayTrial) => ModelTier;
  } = {},
): Promise<void> => {
  for (const trial of trials) {
    s.trials.dispatch("engineer", {
      task: "T-1",
      tier: options.ranOn?.(trial) ?? trial.tier,
      replay: refOf(proposal, trial),
    });
    await recordRoutingReplayTrial(s.home, {
      repoKey: s.repoKey,
      proposal,
      prompt: options.prompt ?? EFFECTIVE,
      graderBundleSha: BUNDLE,
      trial,
      record: {
        kind: "graded",
        passed: passed(trial),
        tokens: options.tokens?.(trial) ?? 1000,
        readDenied: true,
      },
      at: now,
    });
  }
};

/** Records `times` attempts of `trial` that measured nothing (`outcome`). */
const unmeasured = async (
  s: Setup,
  proposal: string,
  trial: RoutingReplayTrial,
  outcome: ReplayInfraOutcome,
  times = 3,
): Promise<void> => {
  for (let i = 0; i < times; i += 1)
    await recordRoutingReplayTrial(s.home, {
      repoKey: s.repoKey,
      proposal,
      prompt: EFFECTIVE,
      graderBundleSha: BUNDLE,
      trial,
      record: { kind: "unmeasured", outcome },
      at: now,
    });
};

/** Launches every trial of the replay through as many RETROs as it takes, grading each. */
const runToEnd = async (
  s: Setup,
  history: readonly VtcEvent[],
  passed: (t: RoutingReplayTrial) => boolean,
  pace?: { failureTasks: number; regressionTasks: number },
): Promise<RoutingReplayTrial[]> => {
  const all: RoutingReplayTrial[] = [];
  for (let retro = 0; retro < 10; retro += 1) {
    const out = await step(s, history, {
      trialBudget: 24,
      ...(pace === undefined ? {} : { pace }),
    });
    const [launch] = out.replays;
    if (launch === undefined) break;
    await grade(s, launch.proposal, launch.trials, passed);
    all.push(...launch.trials);
    if (launch.remaining === 0) break;
  }
  return all;
};

/** Arm `b` (the higher tier) fixes every failure task; both arms pass the regression set. */
const higherFixes = (t: RoutingReplayTrial): boolean => t.regressionSet || t.arm === "b";

const resultOf = async (s: Setup, id: string) =>
  RoutingReplayResultSchema.parse(
    JSON.parse(await readFile(join(s.root, routingReplayPath(id)), "utf8")) as unknown,
  );

describe("planning a tier replay (D-cn, reading 247(6))", () => {
  it("interleaves the arms, arm a on the current tier and arm b on the proposed one", () => {
    const tasks = [
      { trace: "a-1", run: "r1", task: "T-1", regressionSet: false },
      { trace: "a-2", run: "r1", task: "T-2", regressionSet: true },
    ];
    const trials = planRoutingReplayTrials({ tasks, from: "low", to: "mid", k: 2 });
    expect(trials.map((t) => [t.task, t.arm, t.trial, t.tier, t.regressionSet])).toEqual([
      ["r1:T-1", "a", 1, "low", false],
      ["r1:T-1", "b", 1, "mid", false],
      ["r1:T-2", "a", 1, "low", true],
      ["r1:T-2", "b", 1, "mid", true],
      ["r1:T-1", "b", 2, "mid", false],
      ["r1:T-1", "a", 2, "low", false],
      ["r1:T-2", "b", 2, "mid", true],
      ["r1:T-2", "a", 2, "low", true],
    ]);
    // the recorded dispatch each trial runs again
    expect(trials[0]).toMatchObject({ run: "r1", trace: "a-1" });
    expect(planRoutingReplayTrials({ tasks, from: "mid", to: "low" })).toHaveLength(
      tasks.length * K * 2,
    );
  });

  it("fits engine core's RoutingLookback seam with lookbackRoutingStep", () => {
    // a compile-time check: the seam passes neither tier replay launches nor their events
    const seam: RoutingLookback = lookbackRoutingStep;
    expect(seam).toBe(lookbackRoutingStep);
  });

  it("plans the replay within the RETRO's trial budget and withholds the fact until it is graded", async () => {
    const s = await setup("plan");
    const out = await step(s, lowStarts(), { trialBudget: 24 });
    expect(out.cells).toEqual([]);
    expect(out.replays).toHaveLength(1);
    const [launch] = out.replays as RoutingReplayLaunch[];
    expect(launch).toMatchObject({
      proposal: LOW_MID,
      subject: "routing.engineer.S.none",
      role: "engineer",
      host: HOST,
      grader: "gates",
      prompt: {
        role: "engineer",
        host: HOST,
        locked_sha256: LOCKED_SHA,
        editable_sha256: EDITABLE_SHA,
        effective_sha256: EFFECTIVE,
      },
    });
    // 5 failures and 2 regression-set tasks, k trials, two arms: whole pairs within the budget
    const total = (PACE.failureTasks + PACE.regressionTasks) * K * 2;
    expect(launch?.trials).toHaveLength(24);
    expect(launch?.remaining).toBe(total - 24);
    for (const t of launch?.trials ?? []) expect(t.tier).toBe(t.arm === "a" ? "low" : "mid");
    // failures first, the first held-out ones in log order
    expect(launch?.trials[0]).toMatchObject({ task: "r1:T-1", arm: "a", regressionSet: false });
    expect(new Set(launch?.trials.map((t) => t.task))).toEqual(
      new Set(["r1:T-1", "r1:T-2", "r1:T-3", "r1:T-4", "r1:T-5", "r1:T-8", "r1:T-9"]),
    );
  });

  it("continues across RETROs: graded trials are not planned again", async () => {
    const s = await setup("continue");
    const history = lowStarts();
    const first = (await step(s, history, { trialBudget: 24 })).replays[0];
    if (first === undefined) throw new Error("no replay");
    await grade(s, LOW_MID, first.trials, higherFixes);
    const second = await step(s, history, { trialBudget: 24 });
    expect(second.cells).toEqual([]);
    const [next] = second.replays;
    expect(next?.trials).toHaveLength(42 - 24);
    expect(next?.remaining).toBe(0);
    const firstKeys = new Set(first.trials.map((t) => `${t.task}/${t.arm}/${String(t.trial)}`));
    for (const t of next?.trials ?? [])
      expect(firstKeys.has(`${t.task}/${t.arm}/${String(t.trial)}`)).toBe(false);
    // the ledger rows carry the arm's tier, the same prompt as baseline and candidate
    const rows = (await readReplayLedger(s.home)).trials({
      repoKey: s.repoKey,
      proposal: LOW_MID,
      baseline: EFFECTIVE,
      candidate: EFFECTIVE,
      graderBundleSha: BUNDLE,
    });
    expect(rows.size).toBe(24);
    for (const row of rows.values()) expect(row.tier).toBe(row.arm === "a" ? "low" : "mid");
    const text = await readFile(join(s.home, LOOKBACK_HOME.replayTrialsFile), "utf8");
    for (const line of text.trim().split("\n"))
      expect(ReplayTrialRowSchema.safeParse(JSON.parse(line)).success).toBe(true);
  });

  it("raises the fact once graded when the replay backs the change, with its verdict", async () => {
    const s = await setup("backed");
    const history = lowStarts();
    const trials = await runToEnd(s, history, higherFixes);
    expect(trials).toHaveLength(42);
    const out = await step(s, history, { trialBudget: 24 });
    expect(out.replays).toEqual([]);
    expect(out.cells).toHaveLength(1);
    const [cell] = out.cells;
    expect(cell).toMatchObject({ role: "engineer", size: "S", risk: "none" });
    expect(cell?.metrics).toMatchObject({
      [ROUTING_FACT_METRICS.fromTier]: 0,
      [ROUTING_FACT_METRICS.toTier]: 1,
      [ROUTING_FACT_METRICS.replayPlanned]: 1,
      [ROUTING_FACT_METRICS.replayVerdict]: ROUTING_REPLAY_VERDICT_CODES.improve,
      [ROUTING_FACT_METRICS.replayTrials]: 42,
    });
    expect(cell?.detail).toContain("tier replay");
    expect(cell?.detail).toContain("improve");
    const result = await resultOf(s, LOW_MID);
    expect(result).toMatchObject({
      v: 1,
      id: LOW_MID,
      subject: "routing.engineer.S.none",
      role: "engineer",
      host: HOST,
      prompt: EFFECTIVE,
      tiers: { a: "low", b: "mid" },
      grader_bundle_sha: BUNDLE,
      grader: "gates",
      k: K,
      verdict: "improve",
      tokens_delta_pct: 0,
      // every trial of both arms reported the same cost
      cost_delta_pct: 0,
      isolation: "read_denied",
    });
    expect(result.per_task).toHaveLength(7);
    expect(result.sign_test).toMatchObject({ n_discordant: 5, wins_b: 5 });
  });

  it("raises no fact for the window when the replay does not back the change", async () => {
    const s = await setup("unbacked");
    const history = lowStarts();
    // Mid does no better than Low: a higher start needs `improve`
    await runToEnd(s, history, () => true);
    const out = await step(s, history, { trialBudget: 24 });
    expect(out.cells).toEqual([]);
    expect(out.replays).toEqual([]);
    expect((await resultOf(s, LOW_MID)).verdict).toBe("no_change");
    // and with no budget the graded verdict still decides: no scorecard-alone fact
    const broke = await step(s, history, { trialBudget: 0 });
    expect(broke.cells).toEqual([]);
    // an absent budget counts as none: the graded verdict decides too
    const unbudgeted = await step(s, history);
    expect(unbudgeted.cells).toEqual([]);
    expect(unbudgeted.replays).toEqual([]);
  });

  it("backs a cheaper start whose arm holds quality (no_change)", async () => {
    const s = await setup("cheaper");
    const history = midStarts();
    const first = await step(s, history, { trialBudget: 100 });
    expect(first.cells).toEqual([]);
    const [launch] = first.replays;
    expect(launch?.proposal).toBe(MID_LOW);
    // no task failed on Mid: the regression set only
    expect(launch?.trials).toHaveLength(PACE.regressionTasks * K * 2);
    for (const t of launch?.trials ?? []) expect(t.tier).toBe(t.arm === "a" ? "mid" : "low");
    await grade(s, MID_LOW, launch?.trials ?? [], () => true);
    const [cell, ...rest] = (await step(s, history, { trialBudget: 100 })).cells;
    expect(rest).toEqual([]);
    expect(cell?.metrics).toMatchObject({
      [ROUTING_FACT_METRICS.fromTier]: 1,
      [ROUTING_FACT_METRICS.toTier]: 0,
      [ROUTING_FACT_METRICS.replayVerdict]: ROUTING_REPLAY_VERDICT_CODES.no_change,
      [ROUTING_FACT_METRICS.replayTrials]: PACE.regressionTasks * K * 2,
    });
  });

  it("refuses a cheaper start whose arm regresses", async () => {
    const s = await setup("cheaper-regress");
    const history = midStarts();
    const [launch] = (await step(s, history, { trialBudget: 100 })).replays;
    await grade(s, MID_LOW, launch?.trials ?? [], (t) => t.arm === "a");
    const out = await step(s, history, { trialBudget: 100 });
    expect(out.cells).toEqual([]);
    expect((await resultOf(s, MID_LOW)).verdict).toBe("regress");
  });

  it("with no trial budget, raises the fact on the scorecard alone (replay_planned 0)", async () => {
    const s = await setup("no-budget");
    for (const budget of [undefined, 0]) {
      const out = await step(s, lowStarts(), budget === undefined ? {} : { trialBudget: budget });
      expect(out.replays).toEqual([]);
      expect(out.cells).toHaveLength(1);
      expect(out.cells[0]?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
      expect(out.cells[0]?.metrics).not.toHaveProperty(ROUTING_FACT_METRICS.replayVerdict);
      expect(out.cells[0]?.metrics).not.toHaveProperty(ROUTING_FACT_METRICS.replayTrials);
      expect(out.cells[0]?.detail).toContain("No tier replay backs it");
    }
    // a budget too small for one pair plans nothing either
    expect((await step(s, lowStarts(), { trialBudget: 1 })).cells[0]?.metrics).toMatchObject({
      [ROUTING_FACT_METRICS.replayPlanned]: 0,
    });
  });

  it("keeps a replay in progress waiting, with no fact, when this RETRO has no budget left", async () => {
    const s = await setup("waiting");
    const history = lowStarts();
    const first = await step(s, history, { trialBudget: 2 });
    const [launch] = first.replays;
    expect(launch?.trials).toHaveLength(2);
    // the trials that wait are logged as automation.skipped trial_cap
    expect(first.skipped.map((e) => [e.type, e.data.reason, e.data.kind])).toEqual([
      ["automation.skipped", "trial_cap", "lookback"],
    ]);
    expect(first.skipped[0]?.data.detail).toContain("40 tier replay trials of 1 routing change");
    await grade(s, LOW_MID, launch?.trials ?? [], higherFixes);
    for (const budget of [0, undefined]) {
      const out = await step(s, history, budget === undefined ? {} : { trialBudget: budget });
      expect(out.cells).toEqual([]);
      expect(out.replays).toEqual([]);
      expect(out.skipped.map((e) => e.data.reason)).toEqual(["trial_cap"]);
    }
  });

  it("through the seam, launches and grades no tier replay, and says when one was due (reading 247(6) not met)", async () => {
    const s = await setup("seam");
    const history = lowStarts();
    const seam = (trialBudget?: number) =>
      lookbackRoutingStep({
        table: DCM,
        projectRoot: s.root,
        history,
        graderBundleSha: BUNDLE,
        now,
        lockedShaFor,
        vtcHome: s.home,
        pace: PACE,
        ...(trialBudget === undefined ? {} : { trialBudget }),
      });
    // no budget, or one too small for a pair: no replay was due
    for (const budget of [undefined, 0, 1]) {
      const cells = await seam(budget);
      expect(cells).toHaveLength(1);
      expect(cells[0]?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
      expect(cells[0]?.detail).toContain("No tier replay backs it");
      expect(cells[0]?.detail).not.toContain("247(6)");
    }
    // a budget with room for the replay: the fact still goes out on the scorecard alone (the seam
    // cannot launch), and its detail tells the human the replay the reading asks for did not run
    const [due, ...others] = await seam(24);
    expect(others).toEqual([]);
    expect(due?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
    expect(due?.metrics).not.toHaveProperty(ROUTING_FACT_METRICS.replayVerdict);
    expect(due?.detail).toContain("A tier replay fit this RETRO's trial budget");
    expect(due?.detail).toContain("spine reading 247(6) is not met");
    // nothing launched through the seam: the ledger holds no row of the replay
    await expect(readFile(join(s.home, LOOKBACK_HOME.replayTrialsFile), "utf8")).rejects.toThrow();
    // a replay the ledger holds every trial of: the seam has no trial events to grade it on
    await runToEnd(s, history, () => true);
    const [cell, ...rest] = await seam(24);
    expect(rest).toEqual([]);
    expect(cell?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
    expect(cell?.metrics).not.toHaveProperty(ROUTING_FACT_METRICS.replayVerdict);
    await expect(readFile(join(s.root, routingReplayPath(LOW_MID)), "utf8")).rejects.toThrow();
  });

  it("starts over under another prompt version or grader bundle", async () => {
    const s = await setup("stale");
    const history = lowStarts();
    const [launch] = (await step(s, history, { trialBudget: 24 })).replays;
    // graded for another version of the Engineer's prompt
    await grade(s, LOW_MID, launch?.trials ?? [], higherFixes, { prompt: OTHER });
    const again = (await step(s, history, { trialBudget: 24 })).replays[0];
    expect(again?.trials).toEqual(launch?.trials);
    // graded under this bundle, read under another
    await grade(s, LOW_MID, launch?.trials ?? [], higherFixes);
    const rebundled = (await step(s, history, { trialBudget: 24, graderBundleSha: OTHER }))
      .replays[0];
    expect(rebundled?.trials).toEqual(launch?.trials);
  });

  /** The ledger's infra rows (attempts that measured nothing), as written. */
  const infraRows = async (s: Setup) =>
    (await readFile(join(s.home, LOOKBACK_HOME.replayTrialsFile), "utf8"))
      .trim()
      .split("\n")
      .map((line) => ReplayInfraRowSchema.safeParse(JSON.parse(line)))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []));

  it("falls back to the scorecard when a trial keeps measuring nothing", async () => {
    const s = await setup("infra");
    const history = lowStarts();
    const [launch] = (await step(s, history, { trialBudget: 24 })).replays;
    const stuck = launch?.trials.find((t) => t.arm === "b");
    if (stuck === undefined) throw new Error("no trial");
    await unmeasured(s, LOW_MID, stuck, "gate_infra");
    // each attempt is kept with its arm's tier, the one prompt as baseline and candidate
    const rows = await infraRows(s);
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(row).toMatchObject({
        proposal: LOW_MID,
        task: stuck.task,
        arm: "b",
        tier: "mid",
        baseline: EFFECTIVE,
        candidate: EFFECTIVE,
        outcome: "gate_infra",
      });
    const out = await step(s, history, { trialBudget: 24 });
    expect(out.replays).toEqual([]);
    expect(out.cells[0]?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
    // gate_infra is not a plugin lock: nothing to log
    expect(out.skipped).toEqual([]);
  });

  it("logs automation.skipped plugin_locked when a plugin lock stops the replay", async () => {
    const s = await setup("locked");
    const history = lowStarts();
    const [launch] = (await step(s, history, { trialBudget: 24 })).replays;
    const [stuck] = launch?.trials ?? [];
    if (stuck === undefined) throw new Error("no trial");
    await unmeasured(s, LOW_MID, stuck, "plugin_locked");
    for (const row of await infraRows(s))
      expect(row).toMatchObject({
        arm: "a",
        tier: "low",
        baseline: EFFECTIVE,
        candidate: EFFECTIVE,
      });
    const out = await step(s, history, { trialBudget: 24 });
    expect(out.replays).toEqual([]);
    expect(out.cells[0]?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
    expect(out.skipped.map((e) => e.data.reason)).toEqual(["plugin_locked"]);
    expect(out.skipped[0]?.data.detail).toContain(LOW_MID);
  });

  it("falls back to the scorecard, and launches no more, when a ledger row has another tier than its arm", async () => {
    const s = await setup("row-tier");
    const history = lowStarts();
    const [launch] = (await step(s, history, { trialBudget: 24 })).replays;
    const [first, ...rest] = launch?.trials ?? [];
    if (first === undefined) throw new Error("no trial");
    // the trial ran on Top, not on its arm's Low: a later row of the right tier would not count
    await grade(s, LOW_MID, [{ ...first, tier: "top" }], higherFixes);
    await grade(s, LOW_MID, [first, ...rest], higherFixes);
    for (let retro = 0; retro < 2; retro += 1) {
      const out = await step(s, history, { trialBudget: 24 });
      expect(out.replays).toEqual([]);
      expect(out.cells).toHaveLength(1);
      expect(out.cells[0]?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
      expect(out.cells[0]?.metrics).not.toHaveProperty(ROUTING_FACT_METRICS.replayVerdict);
    }
  });

  it("refuses to grade a replay one of whose trials ran clamped, on a fallback model or on another tier", async () => {
    const s = await setup("clamped");
    const history = lowStarts();
    const trials = await runToEnd(s, history, higherFixes);
    const armB = trials.find((t) => t.arm === "b");
    if (armB === undefined) throw new Error("no arm b");
    const ref = refOf(LOW_MID, armB);
    const offTier = (dispatch: (log: RunLog) => void): VtcEvent[] => {
      const log = new RunLog("again");
      dispatch(log);
      return [...s.trials.events, ...log.events];
    };
    const runs: VtcEvent[][] = [
      // the project's max_tier kept arm b on Low, though its rows say Mid
      offTier((log) =>
        log.dispatch("engineer", { task: "T-1", tier: "low", tierClamped: true, replay: ref }),
      ),
      // the host refused Mid's model: the trial ran on the host default (D-cx)
      offTier((log) =>
        log.dispatch("engineer", {
          task: "T-1",
          tier: "mid",
          modelFallback: { requested: "claude-sonnet-5", reason: "model_refused" },
          replay: ref,
        }),
      ),
      // core ignored the arm's tier: it ran on the recorded one
      offTier((log) => log.dispatch("engineer", { task: "T-1", tier: "low", replay: ref })),
      // a tier replay's dispatch with no tier is an anomaly, never trusted
      offTier((log) => log.dispatch("engineer", { task: "T-1", replay: ref })),
    ];
    for (const replayEvents of runs) {
      const out = await step(s, history, { trialBudget: 24, replayEvents });
      expect(out.replays).toEqual([]);
      expect(out.cells).toHaveLength(1);
      expect(out.cells[0]?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
    }
    await expect(readFile(join(s.root, routingReplayPath(LOW_MID)), "utf8")).rejects.toThrow();
    // the same trials, every one on its arm's tier, grade as before
    const graded = await step(s, history, { trialBudget: 24 });
    expect(graded.cells[0]?.metrics[ROUTING_FACT_METRICS.replayVerdict]).toBe(
      ROUTING_REPLAY_VERDICT_CODES.improve,
    );
  });

  it("does not grade a replay whose graded trials the events do not show on their arm's tier", async () => {
    const s = await setup("uncovered");
    const history = lowStarts();
    // the ledger holds every trial, all graded as if each arm ran on its tier: arm b no better
    // (both arms on one model would look like this), which would back nothing here, but a
    // cheaper change would read it as `no_change` and claim the replay's backing
    await runToEnd(s, history, higherFixes);
    const [firstTrial] = s.trials.events.filter((e) => e.type === "role.dispatched");
    const partial = s.trials.events.filter(
      (e) =>
        e.run !== firstTrial?.run ||
        (e.data as { action_id?: string }).action_id !==
          (firstTrial.data as { action_id?: string }).action_id,
    );
    for (const replayEvents of [[], partial]) {
      const out = await step(s, history, { trialBudget: 24, replayEvents });
      expect(out.replays).toEqual([]);
      expect(out.cells).toHaveLength(1);
      expect(out.cells[0]?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
      expect(out.cells[0]?.metrics).not.toHaveProperty(ROUTING_FACT_METRICS.replayVerdict);
    }
    // a replay part way through stops too: its trials could not be told on-tier at its end
    const t = await setup("uncovered-running");
    const [launch] = (await step(t, history, { trialBudget: 2 })).replays;
    await grade(t, LOW_MID, launch?.trials ?? [], higherFixes);
    const stopped = await step(t, history, { trialBudget: 24, replayEvents: [] });
    expect(stopped.replays).toEqual([]);
    expect(stopped.cells[0]?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
    // with every trial's events it goes on
    expect((await step(t, history, { trialBudget: 24 })).replays[0]?.trials).toHaveLength(24);
  });

  it("reopens a graded replay while a bucket below its pace cap gains a held-out task", async () => {
    const s = await setup("reopen");
    // 7 failures and 5 regression-set tasks, then an 8th failure: below a cap of 10 failures
    const pace = { failureTasks: 10, regressionTasks: 2 };
    const before = lowStarts();
    const log = new RunLog();
    const ids = heldOut(13);
    for (let i = 1; i <= 13; i += 1) {
      const task = `T-${String(i)}`;
      log.taskCreated(task, "backend", [], { size: "S", risk: "low", riskTags: [] });
      log.dispatch("engineer", { task, tier: "low", tierReason: "rule", action: ids[i - 1] ?? "" });
      const fails = i <= 7 || i === 13;
      log.gate(task, !fails);
      if (fails) {
        log.dispatch("engineer", { task, tier: "mid", tierReason: "escalation" });
        log.gate(task, true);
      }
    }
    const after = log.events;
    expect(after.slice(0, before.length)).toEqual(before);
    await runToEnd(s, before, higherFixes, pace);
    const graded = await step(s, before, { trialBudget: 24, pace });
    expect(graded.cells[0]?.metrics[ROUTING_FACT_METRICS.replayTrials]).toBe((7 + 2) * K * 2);
    const written = await readFile(join(s.root, routingReplayPath(LOW_MID)), "utf8");
    // the new failure joins the sample: the fact waits for its trials, the result stays
    const reopened = await step(s, after, { trialBudget: 24, pace });
    expect(reopened.cells).toEqual([]);
    const [launch] = reopened.replays;
    expect(launch?.trials).toHaveLength(K * 2);
    expect(new Set(launch?.trials.map((t) => t.task))).toEqual(new Set(["r1:T-13"]));
    expect(await readFile(join(s.root, routingReplayPath(LOW_MID)), "utf8")).toBe(written);
    await grade(s, LOW_MID, launch?.trials ?? [], higherFixes);
    const regraded = await step(s, after, { trialBudget: 24, pace });
    expect(regraded.cells[0]?.metrics[ROUTING_FACT_METRICS.replayTrials]).toBe((8 + 2) * K * 2);
  });

  it("carries the scorecard alone for a role whose id is too long for a replay id", async () => {
    // "routing-" + 45 + "-s-none-low-mid": 68 characters, more than a slug's 64
    const long = `engineer_${"x".repeat(36)}`;
    const s = await setup("long-role");
    const out = await step(s, lowStarts([long]), { trialBudget: 24 });
    expect(out.replays).toEqual([]);
    expect(out.cells.map((c) => c.role)).toEqual([long]);
    expect(out.cells[0]?.metrics[ROUTING_FACT_METRICS.replayPlanned]).toBe(0);
  });

  it("moves a shared cell only when every role's replay backs it", async () => {
    const roles = ["engineer", "engineer_backend"];
    const runAll = async (
      s: Setup,
      passed: (role: string) => (t: RoutingReplayTrial) => boolean,
    ) => {
      for (let retro = 0; retro < 10; retro += 1) {
        const out = await step(s, lowStarts(roles), { trialBudget: 48 });
        if (out.replays.length === 0) return out;
        for (const launch of out.replays)
          await grade(s, launch.proposal, launch.trials, passed(launch.role));
      }
      throw new Error("the replays never finished");
    };
    // the Engineer's replay backs Low -> Mid, the backend Engineer's does no better on Mid
    const split = await runAll(await setup("shared-split"), (role) =>
      role === "engineer" ? higherFixes : () => true,
    );
    expect(split.cells).toEqual([]);
    const both = await runAll(await setup("shared-both"), () => higherFixes);
    expect(both.cells.map((c) => [c.role, c.metrics[ROUTING_FACT_METRICS.shared]])).toEqual([
      ["engineer", 1],
      ["engineer_backend", 1],
    ]);
    for (const c of both.cells)
      expect(c.metrics[ROUTING_FACT_METRICS.replayVerdict]).toBe(
        ROUTING_REPLAY_VERDICT_CODES.improve,
      );
  });

  it("does not rewrite an unchanged result at a later RETRO", async () => {
    const s = await setup("stable");
    const history = lowStarts();
    await runToEnd(s, history, higherFixes);
    await step(s, history, { trialBudget: 24 });
    const path = join(s.root, routingReplayPath(LOW_MID));
    const before = await stat(path);
    const text = await readFile(path, "utf8");
    await routingReplayStep({
      table: DCM,
      projectRoot: s.root,
      history,
      graderBundleSha: BUNDLE,
      now: new Date(now.getTime() + 86_400_000),
      lockedShaFor,
      vtcHome: s.home,
      pace: PACE,
      trialBudget: 24,
      replayEvents: s.trials.events,
    });
    expect(await readFile(path, "utf8")).toBe(text);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it("replaces a symlink at the result's path without reading through it", async () => {
    const s = await setup("result-link");
    const history = lowStarts();
    await runToEnd(s, history, higherFixes);
    const path = join(s.root, routingReplayPath(LOW_MID));
    const elsewhere = join(s.home, "elsewhere.json");
    await writeFile(elsewhere, "kept\n");
    await mkdir(dirname(path), { recursive: true });
    await symlink(elsewhere, path);
    await step(s, history, { trialBudget: 24 });
    expect((await lstat(path)).isFile()).toBe(true);
    expect((await resultOf(s, LOW_MID)).verdict).toBe("improve");
    expect(await readFile(elsewhere, "utf8")).toBe("kept\n");
  });
});

describe("grading a tier replay (RoutingReplayResult)", () => {
  const tasks = [
    { trace: "a-1", run: "r1", task: "T-1", regressionSet: false },
    { trace: "a-2", run: "r1", task: "T-2", regressionSet: true },
  ];
  const planned = planRoutingReplayTrials({ tasks, from: "mid", to: "low", k: 1 });
  const key = (t: { task: string; arm: string; trial: number }) =>
    `${t.task}\n${t.arm}\n${String(t.trial)}`;
  const row = (t: RoutingReplayTrial, tier: ModelTier, tokens: number): ReplayTrialRow => ({
    repo_key: "a".repeat(16),
    proposal: MID_LOW,
    baseline: EFFECTIVE,
    candidate: EFFECTIVE,
    task: t.task,
    arm: t.arm,
    trial: t.trial,
    grader_bundle_sha: BUNDLE,
    tier,
    passed: true,
    tokens,
    read_denied: false,
    graded_at: now.toISOString(),
  });
  const input = (rows: ReadonlyMap<string, ReplayTrialRow>) => ({
    id: MID_LOW,
    subject: "routing.engineer.M.none",
    target: { role: "engineer", host: HOST },
    prompt: EFFECTIVE,
    tiers: { a: "mid" as const, b: "low" as const },
    grader: "gates" as const,
    graderBundleSha: BUNDLE,
    planned,
    rows,
    now,
  });

  it("counts a row only for its arm's tier, and says how many trials are missing", () => {
    const rows = new Map(planned.map((t) => [key(t), row(t, t.tier, 100)]));
    const first = planned[0];
    if (first === undefined) throw new Error("no trial");
    rows.set(key(first), row(first, "top", 100));
    expect(assembleRoutingReplay(input(rows))).toEqual({ complete: false, missing: 1 });
  });

  it("measures tokens and, where both arms are priced, cost of arm b against arm a", () => {
    const rows = new Map(
      planned.map((t) => [key(t), row(t, t.tier, t.arm === "a" ? 1000 : 500)] as const),
    );
    const costs = new Map<string, number | null>(
      planned.map((t) => [key(t), t.arm === "a" ? 0.4 : 0.1]),
    );
    const done = assembleRoutingReplay({ ...input(rows), costs });
    if (!done.complete) throw new Error("incomplete");
    expect(done.trials).toBe(4);
    expect(done.result).toMatchObject({
      tiers: { a: "mid", b: "low" },
      tokens_delta_pct: -50,
      verdict: "no_change",
      isolation: "paths_only",
    });
    expect(done.result.cost_delta_pct).toBeCloseTo(-75);
    // one unpriced trial leaves the cost unknown
    const unpriced = new Map(costs);
    const last = planned.at(-1);
    if (last === undefined) throw new Error("no trial");
    unpriced.set(key(last), null);
    const partial = assembleRoutingReplay({ ...input(rows), costs: unpriced });
    expect(partial.complete && partial.result.cost_delta_pct).toBeNull();
  });

  it("tells the trials that ran on their arm's tier from those that did not", () => {
    const log = new RunLog();
    const ref = (task: string, tier?: ModelTier) => ({
      proposal: MID_LOW,
      task,
      arm: "b" as const,
      trial: 1,
      ...(tier === undefined ? {} : { tier }),
    });
    log.dispatch("engineer", { task: "T-1", tier: "low", replay: ref("r1:ok", "low") });
    log.dispatch("engineer", { task: "T-1", tier: "mid", replay: ref("r1:other", "low") });
    log.dispatch("engineer", {
      task: "T-1",
      tier: "low",
      tierClamped: true,
      replay: ref("r1:clamped", "low"),
    });
    // no arm tier: core ran it on the recorded tier, as a prompt replay
    log.dispatch("engineer", { task: "T-1", tier: "mid", replay: ref("r1:untiered") });
    // no dispatched tier: a tier replay is 5.7.0 or later, so this is never trusted
    log.dispatch("engineer", { task: "T-1", replay: ref("r1:unknown", "low") });
    log.dispatch("engineer", {
      task: "T-1",
      tier: "low",
      modelFallback: { requested: "claude-haiku-5", reason: "model_refused" },
      replay: ref("r1:fallback", "low"),
    });
    // another replay's trial is not this one's
    log.dispatch("engineer", {
      task: "T-1",
      tier: "top",
      replay: { ...ref("r1:theirs", "low"), proposal: LOW_MID },
    });
    const tiers = routingReplayTrialTiers(log.events, MID_LOW);
    expect([...tiers.onTier]).toEqual(["r1:ok\nb\n1"]);
    expect([...tiers.offTier].sort()).toEqual(
      [
        "r1:clamped\nb\n1",
        "r1:fallback\nb\n1",
        "r1:other\nb\n1",
        "r1:unknown\nb\n1",
        "r1:untiered\nb\n1",
      ].sort(),
    );
  });

  it("reads each trial's cost from the replay trial events", () => {
    const log = new RunLog();
    log.dispatch("engineer", {
      task: "T-1",
      cost: 0.25,
      replay: { proposal: MID_LOW, task: "r1:T-1", arm: "a", trial: 1, tier: "mid" },
    });
    log.dispatch("engineer", {
      task: "T-1",
      cost: null,
      replay: { proposal: MID_LOW, task: "r1:T-1", arm: "b", trial: 1, tier: "low" },
    });
    // a retried trial: its last submission counts
    log.dispatch("engineer", {
      task: "T-1",
      cost: 0.05,
      replay: { proposal: MID_LOW, task: "r1:T-1", arm: "b", trial: 1, tier: "low" },
    });
    // another replay's trial is not this one's
    log.dispatch("engineer", {
      task: "T-1",
      cost: 9,
      replay: { proposal: LOW_MID, task: "r1:T-1", arm: "a", trial: 1, tier: "low" },
    });
    expect(routingReplayCosts(log.events, MID_LOW)).toEqual(
      new Map([
        ["r1:T-1\na\n1", 0.25],
        ["r1:T-1\nb\n1", 0.05],
      ]),
    );
  });
});
