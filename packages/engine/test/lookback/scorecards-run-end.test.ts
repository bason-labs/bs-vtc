import {
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  ScorecardIndexSchema,
  ScorecardSchema,
  scorecardPath,
  validateEventData,
  wilsonInterval,
  type Attribution,
} from "@vtc/shared";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAttributions,
  buildTraces,
  computeScorecards,
  graderBundleSha,
  lookbackAtRunEnd,
  lookbackTargets,
  readAttributions,
  tiebreakAttribution,
  tiebreakKey,
  traceRef,
  traceSplit,
  writeScorecards,
} from "../../src/lookback/index.js";
import { EDITABLE_SHA, EFFECTIVE, HOST, LOCKED_SHA, lockedShaFor, RunLog, tempDir } from "./log.js";

const now = new Date("2026-10-14T18:00:00.000Z");
const BUNDLE = graderBundleSha({ judgeModel: "claude-sonnet-5", gatesConfigHash: null });

/** `n` engineer tasks: each a first-round dispatch whose round gate passes when `pass(i)`. */
const engineerRun = (n: number, pass: (i: number) => boolean, run = "r1"): RunLog => {
  const log = new RunLog(run);
  for (let i = 1; i <= n; i += 1) {
    const task = `T-${String(i)}`;
    log.taskCreated(task, "backend", ["node"]);
    log.dispatch("engineer", { task, tokens: 2000 });
    log.gate(task, pass(i));
    if (pass(i)) log.status(task, "merged", "done", 1);
  }
  return log;
};

describe("grader bundle", () => {
  it("changes with the judge model or the gates config", () => {
    expect(BUNDLE).toMatch(/^[a-f0-9]{64}$/);
    expect(graderBundleSha({ judgeModel: "other", gatesConfigHash: null })).not.toBe(BUNDLE);
    expect(
      graderBundleSha({ judgeModel: "claude-sonnet-5", gatesConfigHash: "1".repeat(64) }),
    ).not.toBe(BUNDLE);
  });
});

describe("scorecards (§13, AD-21 rule 5)", () => {
  it("reports proportions with n and a Wilson interval", () => {
    const log = engineerRun(12, (i) => i <= 9);
    const [card] = computeScorecards({
      events: log.events,
      attributions: [],
      lockedShaFor,
      graderBundleSha: BUNDLE,
      now,
    });
    expect(card).toBeDefined();
    if (card === undefined) return;
    expect(() => ScorecardSchema.parse(card)).not.toThrow();
    const ci = wilsonInterval(9, 12);
    expect(card.metrics.first_round_gate_pass).toEqual({
      value: 9 / 12,
      ci_low: ci.low,
      ci_high: ci.high,
      n: 12,
    });
    // Nine tasks reached done: below the minimum n, so "insufficient data".
    expect(card.metrics.rounds_to_done).toEqual({ value: null, ci_low: null, ci_high: null, n: 9 });
    expect(card.metrics.tokens_per_success).toMatchObject({ value: 2000, n: 12 });
    expect(card.prompt.effective_sha256).toBe(EFFECTIVE);
    expect(card.grader_bundle_sha).toBe(BUNDLE);
    expect(card.breakdown).toEqual([
      expect.objectContaining({ discipline: "backend", stack_pack: "node", host: HOST }),
    ]);
  });

  it("shows insufficient data below the minimum n", () => {
    const log = engineerRun(LOOKBACK_LIMITS.minScorecardN - 1, () => true);
    const [card] = computeScorecards({
      events: log.events,
      attributions: [],
      lockedShaFor,
      graderBundleSha: BUNDLE,
      now,
    });
    expect(card?.metrics.first_round_gate_pass).toEqual({
      value: null,
      ci_low: null,
      ci_high: null,
      n: LOOKBACK_LIMITS.minScorecardN - 1,
    });
  });

  it("writes each card at scorecardPath and keeps one index entry per card", async () => {
    const root = await tempDir("cards");
    const cards = computeScorecards({
      events: engineerRun(3, () => true).events,
      attributions: [],
      lockedShaFor,
      graderBundleSha: BUNDLE,
      now,
    });
    const [path] = await writeScorecards(root, cards);
    expect(path).toBe(scorecardPath("engineer", HOST, EFFECTIVE));
    await writeScorecards(root, cards);
    const index = ScorecardIndexSchema.parse(
      JSON.parse(await readFile(join(root, LOOKBACK_REPO.scorecardIndex), "utf8")),
    );
    expect(index.scorecards).toEqual([
      { prompt: cards[0]?.prompt, path, written_at: now.toISOString() },
    ]);
  });
});

describe("lookback at run end (AD-21 rule 8)", () => {
  const failingRun = (failures: number): RunLog => engineerRun(failures * 4, () => false);

  it("attributes, writes scorecards and dispatches lookback for a target with enough train failures", async () => {
    const root = await tempDir("runend");
    const log = failingRun(LOOKBACK_LIMITS.minTrainFailures);
    const result = await lookbackAtRunEnd({
      projectRoot: root,
      events: log.events,
      history: log.events,
      lockedShaFor,
      graderBundleSha: BUNDLE,
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      now,
    });
    const train = result.attributions.filter((a) => a.split === "train");
    expect(train.length).toBeGreaterThanOrEqual(LOOKBACK_LIMITS.minTrainFailures);
    expect(await readAttributions(root, { history: log.events, lockedShaFor })).toHaveLength(
      result.attributions.length,
    );
    expect(result.targets).toEqual([
      expect.objectContaining({ role: "engineer", host: HOST, train_failures: train.length }),
    ]);
    expect(result.targets[0]?.traces.every((t) => traceSplit(t) === "train")).toBe(true);
    // The lookback role cites run-qualified slugs, never a bare per-run action id.
    expect(result.targets[0]?.traces.every((t) => t.id === `${t.run}.${t.trace}`)).toBe(true);
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "lookback.dispatched",
        data: { target_role: "engineer", target_host: HOST, train_failures: train.length },
      }),
    ]);
    for (const e of result.events) expect(validateEventData(e.type, e.data).ok).toBe(true);
    expect(result.scorecards).toHaveLength(1);

    // The same run again (a restart) adds no attributions and dispatches nothing new.
    const again = await lookbackAtRunEnd({
      projectRoot: root,
      events: log.events,
      history: log.events,
      lockedShaFor,
      graderBundleSha: BUNDLE,
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      now,
    });
    expect(again.attributions).toEqual([]);
    expect(again.targets).toEqual([]);
  });

  it("waits for the weekly window and the budget", () => {
    const attributions = Array.from({ length: 12 }, (_, i) => `x-${String(i)}`)
      .filter((trace) => traceSplit({ run: "r1", trace }) === "train")
      .map((trace) => ({
        v: 1 as const,
        trace,
        run: "r1",
        prompt: {
          role: "engineer",
          host: HOST,
          locked_sha256: "1".repeat(64),
          editable_sha256: "2".repeat(64),
          effective_sha256: "3".repeat(64),
        },
        outcome: "failure" as const,
        blamed_role: "engineer",
        method: "tree" as const,
        rule: "test_fails" as const,
        confidence: 1,
        split: "train" as const,
        evidence: [],
        attributed_at: now.toISOString(),
      }));
    expect(attributions.length).toBeGreaterThanOrEqual(LOOKBACK_LIMITS.minTrainFailures);
    const fresh = new Set(attributions.map(traceRef));
    expect(
      lookbackTargets({ attributions, fresh, weeklyRemainingPct: 80, budgetAvailable: true })
        .targets,
    ).toHaveLength(1);
    expect(
      lookbackTargets({ attributions, fresh, weeklyRemainingPct: 29, budgetAvailable: true }),
    ).toEqual({ targets: [], skipped: "weekly_window" });
    expect(
      lookbackTargets({ attributions, fresh, weeklyRemainingPct: null, budgetAvailable: true })
        .skipped,
    ).toBe("weekly_window");
    expect(
      lookbackTargets({ attributions, fresh, weeklyRemainingPct: 80, budgetAvailable: false }),
    ).toEqual({ targets: [], skipped: "budget" });
    expect(
      lookbackTargets({
        attributions: attributions.slice(0, LOOKBACK_LIMITS.minTrainFailures - 1),
        fresh,
        weeklyRemainingPct: 80,
        budgetAvailable: true,
      }).targets,
    ).toEqual([]);
    expect(
      lookbackTargets({
        attributions,
        fresh: new Set(),
        weeklyRemainingPct: 80,
        budgetAvailable: true,
      }).targets,
    ).toEqual([]);
  });

  const row = (trace: string, over: Partial<Attribution> = {}): Attribution => ({
    v: 1,
    trace,
    run: "r1",
    prompt: {
      role: "engineer",
      host: HOST,
      locked_sha256: "1".repeat(64),
      editable_sha256: "2".repeat(64),
      effective_sha256: "3".repeat(64),
    },
    outcome: "failure",
    blamed_role: "engineer",
    method: "tree",
    rule: "test_fails",
    confidence: 1,
    split: traceSplit({ run: "r1", trace }),
    evidence: [],
    attributed_at: now.toISOString(),
    ...over,
  });

  it("counts no failure that blames nobody or another role", () => {
    const train = Array.from({ length: 20 }, (_, i) => `x-${String(i)}`).filter(
      (trace) => traceSplit({ run: "r1", trace }) === "train",
    );
    const unknown = train.map((t) =>
      row(t, { method: "ai_tiebreak", rule: undefined, blamed_role: null }),
    );
    const other = train.map((t) => row(t, { blamed_role: "qa" }));
    for (const attributions of [unknown, other]) {
      expect(
        lookbackTargets({
          attributions,
          fresh: new Set(attributions.map(traceRef)),
          weeklyRemainingPct: 80,
          budgetAvailable: true,
        }).targets,
      ).toEqual([]);
    }
  });

  it("ignores planted rows: a held-out trace marked train, or a trace the run never dispatched", async () => {
    const root = await tempDir("planted");
    const log = failingRun(LOOKBACK_LIMITS.minTrainFailures);
    const held = Array.from({ length: 40 }, (_, i) => `p-${String(i)}`).filter(
      (trace) => traceSplit({ run: "r9", trace }) === "holdout",
    );
    const lying = held.map((trace) => row(trace, { run: "r9", split: "train" }));
    const ghosts = Array.from({ length: 10 }, (_, i) =>
      row(`ghost-${String(i)}`, {
        run: "r1",
        split: traceSplit({ run: "r1", trace: `ghost-${String(i)}` }),
      }),
    );
    await mkdir(join(root, ".vtc/lookback"), { recursive: true });
    await writeFile(
      join(root, LOOKBACK_REPO.attributions),
      [...lying, ...ghosts].map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    expect(await readAttributions(root, { history: log.events, lockedShaFor })).toEqual([]);
    const result = await lookbackAtRunEnd({
      projectRoot: root,
      events: log.events,
      history: log.events,
      lockedShaFor,
      graderBundleSha: BUNDLE,
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      now,
    });
    const train = result.attributions.filter((a) => a.split === "train");
    expect(result.targets).toEqual([
      expect.objectContaining({ role: "engineer", train_failures: train.length }),
    ]);
    expect(result.targets[0]?.traces.some((t) => t.trace.startsWith("ghost-"))).toBe(false);
  });

  it("ignores planted train rows of a run outside the history, even with the right version", async () => {
    const root = await tempDir("outside");
    // One real fresh train failure: alone it is below minTrainFailures.
    const log = new RunLog("r1");
    let action = "";
    for (let i = 1; action === ""; i += 1) {
      const id = `act-${String(i)}`;
      if (traceSplit({ run: "r1", trace: id }) === "train") action = id;
    }
    log.dispatch("engineer", { task: "T-1", action });
    log.gate("T-1", false);
    const version = {
      role: "engineer",
      host: HOST,
      locked_sha256: LOCKED_SHA,
      editable_sha256: EDITABLE_SHA,
      effective_sha256: EFFECTIVE,
    };
    const invented = Array.from({ length: 40 }, (_, i) => `x-${String(i)}`)
      .filter((trace) => traceSplit({ run: "r-invented", trace }) === "train")
      .slice(0, LOOKBACK_LIMITS.minTrainFailures)
      .map((trace) => row(trace, { run: "r-invented", prompt: version, split: "train" }));
    expect(invented).toHaveLength(LOOKBACK_LIMITS.minTrainFailures);
    await mkdir(join(root, ".vtc/lookback"), { recursive: true });
    await writeFile(
      join(root, LOOKBACK_REPO.attributions),
      invented.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const result = await lookbackAtRunEnd({
      projectRoot: root,
      events: log.events,
      history: log.events,
      lockedShaFor,
      graderBundleSha: BUNDLE,
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      now,
    });
    expect(result.attributions).toEqual([
      expect.objectContaining({ run: "r1", trace: action, split: "train" }),
    ]);
    expect(result.targets).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("keeps every run of the history in the scorecards, so a second run never shrinks n", async () => {
    const root = await tempDir("history");
    const first = engineerRun(6, () => true, "r1");
    const second = engineerRun(6, () => true, "r2");
    const common = {
      projectRoot: root,
      lockedShaFor,
      graderBundleSha: BUNDLE,
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      now,
    };
    await lookbackAtRunEnd({ ...common, events: first.events, history: first.events });
    const result = await lookbackAtRunEnd({
      ...common,
      events: second.events,
      history: [...first.events, ...second.events],
    });
    const card = ScorecardSchema.parse(
      JSON.parse(await readFile(join(root, scorecardPath("engineer", HOST, EFFECTIVE)), "utf8")),
    );
    expect(result.scorecards[0]?.metrics.first_round_gate_pass?.n).toBe(12);
    expect(card.metrics.first_round_gate_pass?.n).toBe(12);
  });
  it("counts a recorded AI tiebreak only when the engine's tiebreak record is passed in", async () => {
    const log = engineerRun(6, () => true);
    const parked = log.dispatch("engineer", { task: "T-99", tokens: 2000 });
    log.status("T-99", "fixing", "parked", 4, "cap");
    const trace = buildTraces(log.events, lockedShaFor).find((t) => t.trace === parked);
    if (trace === undefined) throw new Error("no trace");
    const tiebreak = tiebreakAttribution({
      trace,
      blamed: "engineer",
      confidence: 0.6,
      evidence: [],
      now,
    });
    if (tiebreak === undefined) throw new Error("unversioned");
    const runEnd = async (tiebreaks?: ReadonlySet<string>) => {
      const root = await tempDir("tiebreak");
      await appendAttributions(root, [tiebreak]);
      return lookbackAtRunEnd({
        projectRoot: root,
        events: log.events,
        history: log.events,
        lockedShaFor,
        graderBundleSha: BUNDLE,
        weeklyRemainingPct: 80,
        budgetAvailable: true,
        now,
        ...(tiebreaks === undefined ? {} : { tiebreaks }),
      });
    };
    const cards = (attributions: Attribution[]) =>
      computeScorecards({
        events: log.events,
        attributions,
        lockedShaFor,
        graderBundleSha: BUNDLE,
        now,
      });
    const without = await runEnd();
    const withRecord = await runEnd(new Set([tiebreakKey(tiebreak)]));
    expect(without.scorecards).toEqual(cards(without.attributions));
    expect(withRecord.scorecards).toEqual(cards([tiebreak, ...withRecord.attributions]));
    expect(withRecord.scorecards).not.toEqual(without.scorecards);
  });
});
