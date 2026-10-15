/**
 * Replays at RETRO under D-cg (spine §5 reading 201; AD-21 rules 6 and 8): which proposals a grader
 * can score (`replayGraderFor`), the Lead host's weekly window, the Lookback budget and the per-RETRO
 * trial cap (`LOOKBACK_LIMITS.maxTrialsPerRetro`), each limit reported as an `automation.skipped`
 * reason; the trial ledger that carries graded trials across RETROs; and the replay result with
 * its grader (reading 202) and its isolation (reading 178).
 */
import { LOOKBACK_LIMITS, ReplayResultSchema, validateEventData, type HostId } from "@vtc/shared";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleReplay,
  finishReplay,
  planRetroReplays,
  promptVersionRef,
  readReplayInfra,
  readReplayLedger,
  readReplayTrials,
  recordReplayInfra,
  recordReplayTrial,
  REPLAY_MAX_INFRA_ATTEMPTS,
  REPLAY_TRIALS_FILE,
  replayIsolation,
  replayLimitReason,
  replaySkippedEvent,
  replayTrialKey,
  type ReplayTrialRow,
} from "../../src/lookback/index.js";
import { EDITABLE, HOST, LOCKED, tempDir } from "./log.js";

const REPO = "0123456789abcdef";
const BUNDLE = "9".repeat(64);
const now = new Date("2026-10-15T09:00:00.000Z");
const baseline = promptVersionRef({
  role: "engineer",
  host: HOST,
  locked: LOCKED,
  editable: EDITABLE,
});
const candidate = promptVersionRef({
  role: "engineer",
  host: HOST,
  locked: LOCKED,
  editable: "Write the failing test first.",
});

const SHAS = { baseline: baseline.effective_sha256, candidate: candidate.effective_sha256 };
const SCOPE = { repoKey: REPO, proposal: "p-1", graderBundleSha: BUNDLE, ...SHAS };

interface T {
  readonly task: string;
  readonly arm: "a" | "b" | "aa";
  readonly trial: number;
  readonly regressionSet: boolean;
}

/** The full plan of a replay: `tasks` × k trials × the arms (with an A/A arm when `aa`). */
const plan = (tasks: string[], aa: boolean, k = 3): T[] => {
  const out: T[] = [];
  for (let trial = 1; trial <= k; trial += 1)
    for (const [i, task] of tasks.entries()) {
      out.push({ task, arm: "a", trial, regressionSet: i % 2 === 1 });
      out.push({ task, arm: "b", trial, regressionSet: i % 2 === 1 });
      if (aa) out.push({ task, arm: "aa", trial, regressionSet: i % 2 === 1 });
    }
  return out;
};

const pending = (
  proposal: string,
  trials: T[],
  role = "engineer",
  changesFiles = true,
  host: HostId = HOST,
  recordedAt = "2026-10-01T09:00:00.000Z",
) => ({ proposal, role, host, changesFiles, trials, recordedAt });

const open = { weeklyRemainingPct: 80, budgetAvailable: true };

describe("replay limits (D-cg)", () => {
  it("names the weekly window first, then the budget, as automation.skipped reasons", () => {
    expect(replayLimitReason({ weeklyRemainingPct: 80, budgetAvailable: true })).toBeNull();
    expect(replayLimitReason({ weeklyRemainingPct: null, budgetAvailable: true })).toBe(
      "weekly_window",
    );
    expect(
      replayLimitReason({
        weeklyRemainingPct: LOOKBACK_LIMITS.minWeeklyRemainingPct - 1,
        budgetAvailable: false,
      }),
    ).toBe("weekly_window");
    expect(replayLimitReason({ weeklyRemainingPct: 80, budgetAvailable: false })).toBe("budget");
  });
});

describe("a replay arm whose plugin did not load (reading 201)", () => {
  it("is logged as automation.skipped plugin_locked", () => {
    const event = replaySkippedEvent(
      "plugin_locked",
      "a managed-settings lock kept the installed vtc plugin for trial 3 of p-1",
    );
    expect(event).toMatchObject({
      type: "automation.skipped",
      data: { reason: "plugin_locked", kind: "lookback" },
    });
    expect(validateEventData("automation.skipped", event.data).ok).toBe(true);
  });
});

describe("planning a RETRO's replays (D-cg, D-ch)", () => {
  it("replays what a grader can score: gates for file-writing roles, verdict for verdict roles", () => {
    const planned = planRetroReplays({
      ...open,
      pending: [
        pending("p-eng", plan(["r1:T-1"], false, 1)),
        pending("p-sv", plan(["r1:T-2"], false, 1), "spec_verifier", false),
        pending("p-sec", plan(["r1:T-3"], false, 1), "security", false),
      ],
      graded: () => new Set(),
    });
    expect(planned.launch.map((r) => [r.proposal, r.grader])).toEqual([
      ["p-eng", "gates"],
      ["p-sv", "verdict"],
    ]);
    expect(planned.unreplayable).toEqual([
      {
        proposal: "p-sec",
        reason: "no grader can score security: it changes no file and is not a verdict-graded role",
      },
    ]);
  });

  it("launches nothing when the weekly window or the budget says wait, and says why once", () => {
    for (const [limits, reason] of [
      [{ weeklyRemainingPct: 5, budgetAvailable: true }, "weekly_window"],
      [{ weeklyRemainingPct: 80, budgetAvailable: false }, "budget"],
    ] as const) {
      const planned = planRetroReplays({
        ...limits,
        pending: [pending("p-1", plan(["r1:T-1"], true)), pending("p-2", plan(["r1:T-2"], true))],
        graded: () => new Set(),
      });
      expect(planned.launch).toEqual([]);
      expect(planned.skipped.map((e) => e.data.reason)).toEqual([reason]);
      const [event] = planned.skipped;
      expect(event?.type).toBe("automation.skipped");
      expect(validateEventData("automation.skipped", event?.data ?? {}).ok).toBe(true);
    }
  });

  it("launches at most maxTrialsPerRetro trials, in whole pairs, and the rest wait with trial_cap", () => {
    expect(LOOKBACK_LIMITS.maxTrialsPerRetro).toBe(24);
    // 2 tasks x 3 trials x 3 arms = 18 trials each
    const first = plan(["r1:T-1", "r1:T-2"], true);
    const second = plan(["r1:T-3", "r1:T-4"], true);
    const planned = planRetroReplays({
      ...open,
      // at most half the weekly window left: the base cap (D-cq)
      weeklyRemainingPct: LOOKBACK_LIMITS.boostAboveWeeklyPct,
      pending: [pending("p-1", first), pending("p-2", second)],
      graded: () => new Set(),
    });
    expect(planned.launch.map((r) => [r.proposal, r.trials.length, r.remaining])).toEqual([
      ["p-1", 18, 0],
      ["p-2", 6, 12],
    ]);
    expect(planned.launch[1]?.trials).toEqual(second.slice(0, 6));
    expect(planned.skipped.map((e) => e.data.reason)).toEqual(["trial_cap"]);
    expect(planned.skipped[0]?.data.detail).toContain("12 replay trials");
    expect(validateEventData("automation.skipped", planned.skipped[0]?.data ?? {}).ok).toBe(true);
  });

  it("launches up to the boosted cap while more than half the weekly window is left (D-cq)", () => {
    expect(LOOKBACK_LIMITS.maxTrialsPerRetroBoosted).toBe(36);
    // three replays of 18 trials: two fit under 36
    const replays = [1, 2, 3].map((i) =>
      pending(`p-${String(i)}`, plan([`r1:T-${String(2 * i - 1)}`, `r1:T-${String(2 * i)}`], true)),
    );
    const boosted = planRetroReplays({
      weeklyRemainingPct: LOOKBACK_LIMITS.boostAboveWeeklyPct + 1,
      budgetAvailable: true,
      pending: replays,
      graded: () => new Set(),
    });
    expect(boosted.launch.map((r) => [r.proposal, r.trials.length, r.remaining])).toEqual([
      ["p-1", 18, 0],
      ["p-2", 18, 0],
    ]);
    expect(boosted.skipped[0]?.data.detail).toContain("at most 36");
    const base = planRetroReplays({
      weeklyRemainingPct: LOOKBACK_LIMITS.boostAboveWeeklyPct,
      budgetAvailable: true,
      pending: replays,
      graded: () => new Set(),
    });
    expect(base.launch.map((r) => [r.proposal, r.trials.length])).toEqual([
      ["p-1", 18],
      ["p-2", 6],
    ]);
  });

  it("takes the trial caps from the user's lookback config (D-cq)", () => {
    const replays = [pending("p-1", plan(["r1:T-1", "r1:T-2"], true))];
    const user = { lookback: { max_trials_per_retro: 6, max_trials_per_retro_boosted: 9 } };
    for (const [weeklyRemainingPct, trials] of [
      [40, 6],
      [80, 9],
    ] as const) {
      const planned = planRetroReplays({
        weeklyRemainingPct,
        budgetAvailable: true,
        user,
        pending: replays,
        graded: () => new Set(),
      });
      expect(planned.launch[0]?.trials.length).toBe(trials);
    }
    // a lower boost threshold boosts sooner
    const sooner = planRetroReplays({
      weeklyRemainingPct: 40,
      budgetAvailable: true,
      user: { lookback: { ...user.lookback, boost_above_weekly_pct: 30 } },
      pending: replays,
      graded: () => new Set(),
    });
    expect(sooner.launch[0]?.trials.length).toBe(9);
  });

  it("takes an explicit cap over the pace, as engine core's daemon passes one (D-cq)", () => {
    const replays = [pending("p-1", plan(["r1:T-1", "r1:T-2"], true))];
    // engine core's runner: `cap: lookbackPaceFor(undefined, pct).maxTrialsPerRetro`
    const planned = planRetroReplays({
      ...open,
      user: { lookback: { max_trials_per_retro: 6, max_trials_per_retro_boosted: 9 } },
      cap: 3,
      pending: replays,
      graded: () => new Set(),
    });
    expect(planned.launch[0]?.trials.length).toBe(3);
    expect(planned.skipped[0]?.data.detail).toContain("at most 3");
    // a cap below one whole group launches nothing; every trial waits
    const none = planRetroReplays({ ...open, cap: 0, pending: replays, graded: () => new Set() });
    expect(none.launch).toEqual([]);
    expect(none.skipped.map((e) => e.data.reason)).toEqual(["trial_cap"]);
  });

  it("fills the cap oldest replay first, whatever order the caller passes", () => {
    const older = plan(["r1:T-1", "r1:T-2"], true);
    const newer = plan(["r1:T-3", "r1:T-4"], true);
    const planned = planRetroReplays({
      ...open,
      weeklyRemainingPct: 40,
      pending: [
        pending("p-new", newer, "engineer", true, HOST, "2026-10-09T09:00:00.000Z"),
        pending("p-old", older, "engineer", true, HOST, "2026-10-02T09:00:00.000Z"),
      ],
      graded: () => new Set(),
    });
    expect(planned.launch.map((r) => [r.proposal, r.trials.length, r.remaining])).toEqual([
      ["p-old", 18, 0],
      ["p-new", 6, 12],
    ]);
  });

  it("never splits a task's paired trial across RETROs", () => {
    // pairs of 2 (no A/A arm): a cap of 5 launches two whole pairs
    const planned = planRetroReplays({
      ...open,
      user: { lookback: { max_trials_per_retro: 5, max_trials_per_retro_boosted: 5 } },
      pending: [pending("p-1", plan(["r1:T-1", "r1:T-2"], false))],
      graded: () => new Set(),
    });
    expect(planned.launch[0]?.trials.length).toBe(4);
    expect(planned.launch[0]?.remaining).toBe(8);
  });

  it("continues where the last RETRO stopped: graded trials are not run again", () => {
    const second = plan(["r1:T-3", "r1:T-4"], true);
    const done = new Set(second.slice(0, 6).map(replayTrialKey));
    const planned = planRetroReplays({
      ...open,
      pending: [pending("p-2", second)],
      graded: (proposal) => (proposal === "p-2" ? done : new Set()),
    });
    expect(planned.launch[0]?.trials).toEqual(second.slice(6));
    expect(planned.launch[0]?.remaining).toBe(0);
    expect(planned.skipped).toEqual([]);
  });

  it("finishes a fully graded replay even when the weekly window or the budget says wait", () => {
    const done = plan(["r1:T-1"], false, 1);
    const open2 = plan(["r1:T-2"], false, 1);
    for (const limits of [
      { weeklyRemainingPct: 5, budgetAvailable: true },
      { weeklyRemainingPct: 80, budgetAvailable: false },
    ]) {
      const planned = planRetroReplays({
        ...limits,
        pending: [pending("p-1", done), pending("p-2", open2)],
        graded: (proposal) => new Set(proposal === "p-1" ? done.map(replayTrialKey) : []),
      });
      expect(planned.launch).toEqual([
        {
          proposal: "p-1",
          role: "engineer",
          host: HOST,
          grader: "gates",
          trials: [],
          remaining: 0,
        },
      ]);
      expect(planned.skipped.map((e) => e.data.detail)).toEqual([
        expect.stringContaining("1 replay wait"),
      ]);
    }
  });

  it("reports a replay with no planned trial as unreplayable instead of stalling it", () => {
    const planned = planRetroReplays({
      ...open,
      pending: [
        pending("p-sv", [], "spec_verifier", false),
        pending("p-eng", []),
        pending("p-ok", plan(["r1:T-1"], false, 1)),
      ],
      graded: () => new Set(),
    });
    expect(planned.launch.map((r) => r.proposal)).toEqual(["p-ok"]);
    expect(planned.unreplayable).toEqual([
      {
        proposal: "p-sv",
        reason: "the baseline has no held-out task with a recorded outcome to replay",
      },
      { proposal: "p-eng", reason: "the baseline has no held-out task to replay" },
    ]);
  });

  it("stops a replay one of whose trials measured nothing too often, logging plugin_locked once", () => {
    const trials = plan(["r1:T-1"], false, 1);
    const [first] = trials;
    if (first === undefined) throw new Error("no trial");
    const attempts = (n: number, outcome: "plugin_locked" | "gate_infra" | "no_outcome") =>
      new Map([[replayTrialKey(first), { attempts: n, outcome }]]);
    const below = planRetroReplays({
      ...open,
      pending: [pending("p-1", trials)],
      graded: () => new Set(),
      infra: () => attempts(REPLAY_MAX_INFRA_ATTEMPTS - 1, "plugin_locked"),
    });
    expect(below.launch[0]?.trials).toEqual(trials);
    const locked = planRetroReplays({
      ...open,
      pending: [pending("p-1", trials)],
      graded: () => new Set(),
      infra: () => attempts(REPLAY_MAX_INFRA_ATTEMPTS, "plugin_locked"),
    });
    expect(locked.launch).toEqual([]);
    expect(locked.unreplayable[0]?.reason).toContain("managed-settings lock");
    expect(locked.skipped.map((e) => e.data.reason)).toEqual(["plugin_locked"]);
    expect(validateEventData("automation.skipped", locked.skipped[0]?.data ?? {}).ok).toBe(true);
    const infra = planRetroReplays({
      ...open,
      pending: [pending("p-1", trials)],
      graded: () => new Set(),
      infra: () => attempts(REPLAY_MAX_INFRA_ATTEMPTS, "gate_infra"),
    });
    expect(infra.unreplayable[0]?.reason).toContain("gate_infra");
    expect(infra.skipped).toEqual([]);
    // a verdict trial whose replayed dispatch lost its recorded outcome is not a gate failure
    const noOutcome = planRetroReplays({
      ...open,
      pending: [pending("p-1", trials, "spec_verifier", false)],
      graded: () => new Set(),
      infra: () => attempts(REPLAY_MAX_INFRA_ATTEMPTS, "no_outcome"),
    });
    expect(noOutcome.unreplayable[0]?.reason).toContain("no longer has a recorded outcome");
    expect(noOutcome.unreplayable[0]?.reason).not.toContain("gate");
    expect(noOutcome.skipped).toEqual([]);
  });

  it("hands back a fully graded replay with no trial to run, so it can be finished", () => {
    const trials = plan(["r1:T-1"], false, 1);
    const planned = planRetroReplays({
      ...open,
      pending: [pending("p-1", trials)],
      graded: () => new Set(trials.map(replayTrialKey)),
    });
    expect(planned.launch).toEqual([
      { proposal: "p-1", role: "engineer", host: HOST, grader: "gates", trials: [], remaining: 0 },
    ]);
  });
});

describe("the replay trial ledger (D-cg)", () => {
  const row = (over: Partial<ReplayTrialRow> = {}): ReplayTrialRow => ({
    repo_key: REPO,
    proposal: "p-1",
    ...SHAS,
    task: "r1:T-1",
    arm: "a",
    trial: 1,
    passed: true,
    tokens: 1000,
    read_denied: true,
    grader_bundle_sha: BUNDLE,
    graded_at: now.toISOString(),
    ...over,
  });

  it("keeps graded trials under the VTC home, per project, proposal and grader bundle", async () => {
    const vtcHome = await tempDir("ledger");
    await recordReplayTrial(vtcHome, row());
    await recordReplayTrial(vtcHome, row({ arm: "b", passed: false }));
    await recordReplayTrial(vtcHome, row({ repo_key: "fedcba9876543210" }));
    await recordReplayTrial(vtcHome, row({ proposal: "p-2" }));
    await recordReplayTrial(vtcHome, row({ grader_bundle_sha: "8".repeat(64), arm: "aa" }));
    // a trial graded twice keeps its first grade
    await recordReplayTrial(vtcHome, row({ passed: false }));
    const rows = await readReplayTrials(vtcHome, SCOPE);
    expect([...rows.values()].map((r) => [r.arm, r.passed])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("never lends one candidate's grades to another proposal that reuses its id", async () => {
    const vtcHome = await tempDir("ledger-reuse");
    const other = promptVersionRef({
      role: "engineer",
      host: HOST,
      locked: LOCKED,
      editable: "Skip the tests.",
    });
    // the first p-1 (candidate) graded T-1; a later p-1 with another candidate must start over
    await recordReplayTrial(vtcHome, row({ passed: true, arm: "b" }));
    const reused = await readReplayTrials(vtcHome, {
      ...SCOPE,
      candidate: other.effective_sha256,
    });
    expect(reused.size).toBe(0);
    const otherBase = await readReplayTrials(vtcHome, {
      ...SCOPE,
      baseline: other.effective_sha256,
    });
    expect(otherBase.size).toBe(0);
    expect((await readReplayTrials(vtcHome, SCOPE)).size).toBe(1);
  });

  it("counts a trial's attempts that measured nothing apart from its grades", async () => {
    const vtcHome = await tempDir("ledger-infra");
    const infra = {
      repo_key: REPO,
      proposal: "p-1",
      ...SHAS,
      task: "r1:T-1",
      arm: "a" as const,
      trial: 1,
      grader_bundle_sha: BUNDLE,
      at: now.toISOString(),
    };
    await recordReplayInfra(vtcHome, { ...infra, outcome: "gate_infra" });
    await recordReplayInfra(vtcHome, { ...infra, outcome: "plugin_locked" });
    await recordReplayInfra(vtcHome, { ...infra, proposal: "p-2", outcome: "plugin_locked" });
    expect((await readReplayTrials(vtcHome, SCOPE)).size).toBe(0);
    expect([...(await readReplayInfra(vtcHome, SCOPE))]).toEqual([
      [replayTrialKey(infra), { attempts: 2, outcome: "plugin_locked" }],
    ]);
  });

  it("creates the ledger owner-only", async () => {
    const vtcHome = await tempDir("ledger-mode");
    await recordReplayTrial(vtcHome, row());
    expect((await stat(join(vtcHome, REPLAY_TRIALS_FILE))).mode & 0o777).toBe(0o600);
  });

  it("reads a newer vtc's row without the fields it does not know, instead of dropping it", async () => {
    const vtcHome = await tempDir("ledger-newer");
    const path = join(vtcHome, REPLAY_TRIALS_FILE);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ v: 1, ...row(), host_build: "9.9.9" })}\n`);
    const rows = await readReplayTrials(vtcHome, SCOPE);
    expect([...rows.values()]).toEqual([row()]);
  });

  it("reads the ledger once for every replay a RETRO plans", async () => {
    const vtcHome = await tempDir("ledger-once");
    await recordReplayTrial(vtcHome, row());
    await recordReplayTrial(vtcHome, row({ proposal: "p-2", arm: "b" }));
    await recordReplayInfra(vtcHome, {
      repo_key: REPO,
      proposal: "p-2",
      ...SHAS,
      task: "r1:T-1",
      arm: "a",
      trial: 1,
      grader_bundle_sha: BUNDLE,
      outcome: "no_outcome",
      at: now.toISOString(),
    });
    const ledger = await readReplayLedger(vtcHome);
    expect([...ledger.trials(SCOPE).values()].map((r) => r.arm)).toEqual(["a"]);
    expect([...ledger.trials({ ...SCOPE, proposal: "p-2" }).values()].map((r) => r.arm)).toEqual([
      "b",
    ]);
    expect(ledger.infra(SCOPE).size).toBe(0);
    expect([...ledger.infra({ ...SCOPE, proposal: "p-2" }).values()]).toEqual([
      { attempts: 1, outcome: "no_outcome" },
    ]);
  });

  it("skips a line that does not parse", async () => {
    const vtcHome = await tempDir("ledger-bad");
    const path = join(vtcHome, REPLAY_TRIALS_FILE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `{"v":1,"nope":true}\nnot json\n`);
    await recordReplayTrial(vtcHome, row());
    const rows = await readReplayTrials(vtcHome, SCOPE);
    expect(rows.size).toBe(1);
  });
});

describe("the replay result (readings 178, 202)", () => {
  it("is read_denied only when every trial ran with the repo read-denied", () => {
    expect(replayIsolation([true, true])).toBe("read_denied");
    expect(replayIsolation([true, false])).toBe("paths_only");
    expect(replayIsolation([])).toBe("paths_only");
    // a Codex trial: the adapter reports no enforced read deny (no per-path read deny on Codex)
    expect(replayIsolation([false, false])).toBe("paths_only");
  });

  it("writes the grader and the isolation on every result", () => {
    const base = {
      proposal: "p-1",
      baseline,
      candidate,
      graderBundleSha: BUNDLE,
      k: 1,
      perTask: [{ task: "r1:T-1", a: [false], b: [true], regressionSet: false }],
      aaFlipRate: 0,
      tokensDeltaPct: 0,
      now,
    };
    expect(finishReplay(base)).toMatchObject({ grader: "gates", isolation: "paths_only" });
    expect(finishReplay({ ...base, grader: "verdict", isolation: "read_denied" })).toMatchObject({
      grader: "verdict",
      isolation: "read_denied",
    });
  });

  it("assembles a result from the ledger once every planned trial is graded", () => {
    const planned = plan(["r1:T-1", "r1:T-2"], true, 1);
    const rows = new Map<string, ReplayTrialRow>();
    for (const t of planned.slice(0, 5))
      rows.set(replayTrialKey(t), {
        repo_key: REPO,
        proposal: "p-1",
        ...SHAS,
        task: t.task,
        arm: t.arm,
        trial: t.trial,
        passed: t.arm === "b",
        tokens: t.arm === "b" ? 1100 : 1000,
        read_denied: true,
        grader_bundle_sha: BUNDLE,
        graded_at: now.toISOString(),
      });
    const input = {
      proposal: "p-1",
      baseline,
      candidate,
      grader: "gates" as const,
      planned,
      rows,
      graderBundleSha: BUNDLE,
      now,
    };
    expect(assembleReplay(input)).toEqual({ complete: false, missing: 1 });
    expect(assembleReplay({ ...input, planned: [] })).toEqual({
      complete: false,
      missing: 0,
      reason: "no_tasks",
    });
    const last = planned[5];
    if (last === undefined) throw new Error("no trial");
    rows.set(replayTrialKey(last), {
      repo_key: REPO,
      proposal: "p-1",
      ...SHAS,
      task: last.task,
      arm: last.arm,
      trial: last.trial,
      passed: true,
      tokens: 1000,
      read_denied: true,
      grader_bundle_sha: BUNDLE,
      graded_at: now.toISOString(),
    });
    const done = assembleReplay(input);
    if (!done.complete) throw new Error("incomplete");
    expect(ReplayResultSchema.safeParse(done.result).success).toBe(true);
    expect(done.result.per_task).toEqual([
      { task: "r1:T-1", a: [false], b: [true], regression_set: false },
      { task: "r1:T-2", a: [false], b: [true], regression_set: true },
    ]);
    // A/A: T-1 aa false (no flip), T-2 aa true (a flip): mean 0.5
    expect(done.measuredAaFlipRate).toBe(0.5);
    expect(done.result.aa_flip_rate).toBe(0.5);
    expect(done.result.tokens_delta_pct).toBeCloseTo(10);
    expect(done.result.isolation).toBe("read_denied");
    expect(done.result.grader).toBe("gates");
  });

  it("uses the cached A/A flip rate when the plan has no A/A arm", () => {
    const planned = plan(["r1:T-1"], false, 1);
    const rows = new Map<string, ReplayTrialRow>(
      planned.map((t) => [
        replayTrialKey(t),
        {
          repo_key: REPO,
          proposal: "p-1",
          ...SHAS,
          task: t.task,
          arm: t.arm,
          trial: t.trial,
          passed: true,
          tokens: 1000,
          read_denied: false,
          grader_bundle_sha: BUNDLE,
          graded_at: now.toISOString(),
        },
      ]),
    );
    const done = assembleReplay({
      proposal: "p-1",
      baseline,
      candidate,
      grader: "verdict",
      planned,
      rows,
      cachedAaFlipRate: 0.25,
      graderBundleSha: BUNDLE,
      now,
    });
    if (!done.complete) throw new Error("incomplete");
    expect(done.measuredAaFlipRate).toBeUndefined();
    expect(done.result).toMatchObject({
      aa_flip_rate: 0.25,
      grader: "verdict",
      isolation: "paths_only",
    });
  });
});
