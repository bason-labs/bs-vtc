import {
  canaryArmFor,
  LookbackPinsSchema,
  ReplayResultSchema,
  validateEventData,
  type Attribution,
  type GateReport,
  type GateRunner,
  type GateRunRequest,
  type LookbackPinsInput,
} from "@vtc/shared";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toYaml } from "../../src/core/index.js";
import {
  aaFlipRate,
  buildTraces,
  cachedAaFlipRate,
  canaryArmStats,
  evaluateCanaries,
  finishReplay,
  gradeTrial,
  pinsPath,
  planReplayTrials,
  promptVersionRef,
  recordAaFlipRate,
  replayDispatchPlan,
  replayTasks,
  tokensDeltaPct,
  traceSplit,
  writeReplayResult,
  type ReplayTask,
} from "../../src/lookback/index.js";
import { EDITABLE, EFFECTIVE, HOST, LOCKED, lockedShaFor, RunLog, tempDir } from "./log.js";

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
const now = new Date("2026-10-14T12:00:00.000Z");
const BUNDLE = "9".repeat(64);
const REPO = "0123456789abcdef";

const heldOutAction = (skip: number): string => {
  let seen = 0;
  for (let i = 1; i < 1000; i += 1) {
    const id = `act-${String(i)}`;
    if (traceSplit({ run: "r1", trace: id }) === "holdout" && seen++ === skip) return id;
  }
  throw new Error("none");
};

const trainAction = (): string => {
  for (let i = 1; i < 1000; i += 1)
    if (traceSplit({ run: "r1", trace: `act-${String(i)}` }) === "train") return `act-${String(i)}`;
  throw new Error("none");
};

describe("replay harness (AD-21 rule 6)", () => {
  it("replays held-out failures and a regression set of held-out successes, never train traces", () => {
    const log = new RunLog();
    const failing = heldOutAction(0);
    const passing = heldOutAction(1);
    const train = trainAction();
    log.dispatch("engineer", { task: "T-1", action: failing });
    log.dispatch("engineer", { task: "T-2", action: passing });
    log.dispatch("engineer", { task: "T-3", action: train });
    const failure = (trace: string, blamed: string | null): Attribution =>
      ({
        run: "r1",
        trace,
        outcome: "failure",
        blamed_role: blamed,
        prompt: baseline,
      }) as Attribution;
    const unknown = heldOutAction(2);
    log.dispatch("engineer", { task: "T-4", action: unknown });
    const attributions = [
      failure(failing, "engineer"),
      failure(train, "engineer"),
      // An AI tiebreak that blamed nobody: not a failure of this version, so a regression task.
      failure(unknown, null),
    ];
    const traces = buildTraces(log.events, lockedShaFor);
    const tasks = replayTasks({ baseline, traces, attributions });
    expect(tasks.map((t) => [t.task, t.regressionSet])).toEqual([
      ["T-1", false],
      ["T-2", true],
      ["T-4", true],
    ]);
  });

  it("plans k interleaved, paired trials per task, plus the A/A arm when none is cached", () => {
    const tasks: ReplayTask[] = [
      { trace: "x-1", run: "r1", task: "T-1", regressionSet: false },
      { trace: "x-2", run: "r1", task: "T-2", regressionSet: true },
    ];
    const trials = planReplayTrials({ tasks, baseline, candidate, withAa: true });
    expect(trials).toHaveLength(3 * 2 * 3);
    expect(trials.slice(0, 3).map((t) => t.arm)).toEqual(["a", "b", "aa"]);
    expect(trials.slice(6, 9).map((t) => t.arm)).toEqual(["b", "a", "aa"]);
    expect(planReplayTrials({ tasks, baseline, candidate, withAa: false })).toHaveLength(12);
  });

  it("dispatches replays through planDispatch with purpose lookback_replay", () => {
    expect(replayDispatchPlan("plugin_only", { subagents: true, headless: true })).toBe("subagent");
    expect(replayDispatchPlan("plugin_only", { subagents: false, headless: true })).toBe(
      "unavailable",
    );
    expect(replayDispatchPlan("headless_allowed", { subagents: false, headless: true })).toBe(
      "headless",
    );
  });

  it("grades a trial through the GateRunner interface only", async () => {
    const report = (verdict: GateReport["verdict"]) => ({ verdict }) as GateReport;
    const runner: GateRunner = {
      run: (request: GateRunRequest) =>
        Promise.resolve(report(request.reason === "round" ? "pass" : "fail")),
      checkWriteScope: () => Promise.reject(new Error("unused")),
    };
    expect(await gradeTrial(runner, { reason: "round" } as GateRunRequest)).toBe(true);
    expect(await gradeTrial(runner, { reason: "merge_queue" } as GateRunRequest)).toBe(false);
  });

  it("computes the A/A floor and token delta, decides with replayVerdict and caches the floor", async () => {
    expect(
      aaFlipRate([
        { a: [true, true, false], aa: [true, false, false] },
        { a: [true], aa: [true] },
      ]),
    ).toBeCloseTo(1 / 6);
    expect(tokensDeltaPct([100, 100], [110, 130])).toBeCloseTo(20);
    const wins = Array.from({ length: 6 }, (_, i) => ({
      task: `T-${String(i + 1)}`,
      a: [false, false, false],
      b: [true, true, false],
      regressionSet: false,
    }));
    const result = finishReplay({
      proposal: "p-1",
      baseline,
      candidate,
      graderBundleSha: BUNDLE,
      k: 3,
      perTask: wins,
      aaFlipRate: 0.1,
      tokensDeltaPct: 5,
      now,
    });
    expect(result.verdict).toBe("improve");
    expect(result.sign_test).toMatchObject({ n_discordant: 6, wins_b: 6 });
    expect(() => ReplayResultSchema.parse(result)).not.toThrow();
    const costly = finishReplay({
      proposal: "p-2",
      baseline,
      candidate,
      graderBundleSha: BUNDLE,
      k: 3,
      perTask: wins,
      aaFlipRate: 0.1,
      tokensDeltaPct: 35,
      now,
    });
    expect(costly.verdict).toBe("inconclusive");

    const root = await tempDir("replay");
    const home = await tempDir("home");
    expect(await cachedAaFlipRate(home, baseline, BUNDLE)).toBeUndefined();
    const event = await writeReplayResult(root, result);
    expect(event).toMatchObject({
      type: "lookback.replay_finished",
      data: { proposal: "p-1", verdict: "improve", path: ".vtc/lookback/replays/p-1.json" },
    });
    expect(validateEventData(event.type, event.data).ok).toBe(true);
    expect(
      ReplayResultSchema.parse(
        JSON.parse(await readFile(join(root, ".vtc/lookback/replays/p-1.json"), "utf8")),
      ),
    ).toEqual(result);
    // A replay file in the repo is git-tracked and role-writable: never a source of the floor.
    await writeReplayResult(root, { ...result, proposal: "p-planted", aa_flip_rate: 0.9 });
    expect(await cachedAaFlipRate(home, baseline, BUNDLE)).toBeUndefined();
    await recordAaFlipRate({
      vtcHome: home,
      baseline,
      graderBundleSha: BUNDLE,
      aaFlipRate: 0.1,
      now,
    });
    expect(await cachedAaFlipRate(home, baseline, BUNDLE)).toBe(0.1);
    expect(await cachedAaFlipRate(home, baseline, "8".repeat(64))).toBeUndefined();
    expect(await cachedAaFlipRate(home, candidate, BUNDLE)).toBeUndefined();
  });
});

describe("canaries (AD-21 rule 7)", () => {
  const writeCanary = async (home: string): Promise<void> => {
    const pins: LookbackPinsInput = {
      v: 1,
      projects: {
        [REPO]: {
          canaries: [
            {
              role: "engineer",
              host: HOST,
              candidate: candidate.effective_sha256,
              baseline: EFFECTIVE,
              started_at: "2026-10-14T00:00:00.000Z",
              assignment: "task_hash_50",
            },
          ],
        },
      },
    };
    await mkdir(join(home, "lookback"), { recursive: true });
    await writeFile(pinsPath(home), toYaml(LookbackPinsSchema.parse(pins)));
  };

  /**
   * A run where every task's dispatch records its arm; `candidateTokens` per candidate dispatch;
   * the first `escalate[arm]` tasks of an arm escalate and the first `cap[arm]` park on the cap.
   */
  const canaryRun = (
    perArm: number,
    candidateTokens: number,
    escalateCandidate = 0,
    more: {
      escalate?: { candidate?: number; baseline?: number };
      cap?: { candidate?: number; baseline?: number };
    } = {},
  ): RunLog => {
    const log = new RunLog();
    let n = 0;
    const counts = { candidate: 0, baseline: 0 };
    for (let i = 1; counts.candidate < perArm || counts.baseline < perArm; i += 1) {
      const task = `T-${String(i)}`;
      const arm = canaryArmFor(REPO, task);
      if (counts[arm] >= perArm) continue;
      counts[arm] += 1;
      n += 1;
      const prompt =
        arm === "candidate"
          ? { effective: candidate.effective_sha256, editable: candidate.editable_sha256 }
          : undefined;
      log.dispatch("engineer", {
        task,
        arm,
        tokens: arm === "candidate" ? candidateTokens : 1000,
        ...(prompt === undefined ? {} : { prompt }),
      });
      if (arm === "candidate" && counts.candidate <= escalateCandidate) log.escalate(task);
      if (counts[arm] <= (more.escalate?.[arm] ?? 0)) log.escalate(task);
      if (counts[arm] <= (more.cap?.[arm] ?? 0)) log.status(task, "fixing", "parked", 4, "cap");
    }
    expect(n).toBe(perArm * 2);
    return log;
  };

  it("counts each arm's dispatches, escalations, cap hits and tokens", () => {
    const log = canaryRun(3, 2000, 1);
    expect(
      canaryArmStats(log.events, {
        role: "engineer",
        host: HOST,
        candidate: candidate.effective_sha256,
        baseline: EFFECTIVE,
        started_at: "2026-10-14T00:00:00.000Z",
      }),
    ).toEqual({
      candidate: { dispatches: 3, escalations: 1, capHits: 0, tokens: 6000 },
      baseline: { dispatches: 3, escalations: 0, capHits: 0, tokens: 3000 },
    });
  });

  it("keeps a canary running without data, and rolls it back on a token rise once both arms have data", async () => {
    const home = await tempDir("home");
    await writeCanary(home);
    const early = await evaluateCanaries({
      vtcHome: home,
      repoKey: REPO,
      events: canaryRun(2, 5000).events,
      now,
    });
    expect(early.states[0]?.verdict).toBe("no_data");
    expect(early.events.map((e) => e.type)).toEqual(["lookback.canary_evaluated"]);

    const late = await evaluateCanaries({
      vtcHome: home,
      repoKey: REPO,
      events: canaryRun(5, 5000).events,
      now,
    });
    expect(late.states[0]).toMatchObject({
      verdict: "rollback",
      reason: "tokens per dispatch up more than 20%",
    });
    expect(late.events.map((e) => e.type)).toEqual([
      "lookback.canary_evaluated",
      "lookback.rolled_back",
    ]);
    for (const e of late.events) expect(validateEventData(e.type, e.data).ok).toBe(true);
    // Rolled back: the canary is gone, so the next evaluation has nothing to judge.
    expect(
      (await evaluateCanaries({ vtcHome: home, repoKey: REPO, events: [], now })).states,
    ).toEqual([]);
  });

  it("counts cap hits and rolls back when escalations plus cap hits reach 2x the baseline", async () => {
    const home = await tempDir("home");
    await writeCanary(home);
    const log = canaryRun(5, 1000, 0, {
      escalate: { candidate: 1, baseline: 1 },
      cap: { candidate: 1 },
    });
    const result = await evaluateCanaries({
      vtcHome: home,
      repoKey: REPO,
      events: log.events,
      now,
    });
    expect(result.states[0]).toMatchObject({
      arms: {
        candidate: { dispatches: 5, escalations: 1, cap_hits: 1 },
        baseline: { dispatches: 5, escalations: 1, cap_hits: 0 },
      },
      verdict: "rollback",
      reason: "escalations and cap hits at 2x the baseline or more",
    });
    expect(result.events.map((e) => e.type)).toEqual([
      "lookback.canary_evaluated",
      "lookback.rolled_back",
    ]);

    // Below 2x (the same rate in both arms) it keeps running.
    await writeCanary(home);
    const even = canaryRun(5, 1000, 0, { cap: { candidate: 1, baseline: 1 } });
    expect(
      (await evaluateCanaries({ vtcHome: home, repoKey: REPO, events: even.events, now })).states[0]
        ?.verdict,
    ).toBe("continue");
  });

  it("rolls back at once on a human regression flag", async () => {
    const home = await tempDir("home");
    await writeCanary(home);
    const flagged = await evaluateCanaries({
      vtcHome: home,
      repoKey: REPO,
      events: [],
      now,
      humanFlags: new Set([`engineer@${HOST}`]),
    });
    expect(flagged.states[0]?.verdict).toBe("rollback");
    expect(flagged.events.at(-1)?.type).toBe("lookback.rolled_back");
  });
});
