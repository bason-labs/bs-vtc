/**
 * The verdict grader (D-ch; spine §5 reading 202; AD-21 rules 5 and 6): a verdict role's replay
 * trial is scored against the recorded outcome of the dispatch it replays (the human's verdict,
 * a later escaped defect, the PR, the gate result on the head it judged), so `spec_verifier` is
 * replayable. The outcome feeds `replayTasks` (wrong recorded verdicts are the failures to fix,
 * right ones the regression set) and `gradeVerdictTrial` scores each trial.
 */
import { ATTRIBUTION_TREE, LOOKBACK_LIMITS, sha256Hex, VERDICT_GRADED_ROLES } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  assembleReplay,
  attributeRun,
  expectedOfTaskKey,
  graderBundleSha,
  gradeVerdictReplay,
  gradeVerdictTrial,
  LOOKBACK_METRICS_VERSION,
  planReplayTrials,
  planRetroReplays,
  promptVersionRef,
  recordedOutcome,
  replayTaskKey,
  replayTasks,
  replayTrialKey,
  traceSplit,
  type ReplayTrialRow,
  VERDICT_GRADER_VERSION,
} from "../../src/lookback/index.js";
import { EDITABLE, HOST, LOCKED, lockedShaFor, RunLog } from "./log.js";

const OTHER_HEAD = "d".repeat(40);
const AC = "REQ-1.AC-1";

const baseline = promptVersionRef({
  role: "spec_verifier",
  host: HOST,
  locked: LOCKED,
  editable: EDITABLE,
});

const heldOutAction = (skip: number, run = "r1"): string => {
  let seen = 0;
  for (let i = 1; i < 1000; i += 1) {
    const id = `sv-${String(i)}`;
    if (traceSplit({ run, trace: id }) === "holdout" && seen++ === skip) return id;
  }
  throw new Error("none");
};

/** T-1 built by the Engineer (head HEAD), its round gate passed, then one Spec-Verifier call. */
const judged = (verdict: "pass" | "fail" | "unknown", action = "sv-1"): RunLog => {
  const log = new RunLog();
  log.taskCreated("T-1");
  log.dispatch("engineer", { task: "T-1", feature: "F-1" });
  log.gate("T-1", true);
  log.dispatch("spec_verifier", {
    task: "T-1",
    feature: "F-1",
    action,
    subject: AC,
    end: "done",
    verdicts: [{ subject: AC, verdict }],
  });
  return log;
};

describe("the recorded outcome of a verdict dispatch (D-ch)", () => {
  it("takes the gate result on the head the dispatch judged", () => {
    const log = judged("pass");
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })).toEqual({
      subject: AC,
      recorded: "pass",
      expected: "pass",
      source: "gate",
    });
  });

  it("ignores a gate run on another head", () => {
    const log = new RunLog();
    log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", false, "round", OTHER_HEAD);
    log.dispatch("spec_verifier", {
      task: "T-1",
      action: "sv-1",
      subject: AC,
      end: "done",
      verdicts: [{ subject: AC, verdict: "pass" }],
    });
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })).toBeUndefined();
  });

  it("lets a human label blaming the role beat the gate result", () => {
    const log = judged("pass");
    log.escalate("T-1", "spec_verifier", "blocked");
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })).toMatchObject({
      expected: "fail",
      source: "human_label",
    });
  });

  it("lets evidence that names the criterion win over task-level evidence (reading 212(4))", () => {
    const AC2 = "REQ-1.AC-2";
    const log = new RunLog();
    log.taskCreated("T-1");
    log.dispatch("engineer", { task: "T-1", feature: "F-1" });
    log.gate("T-1", true);
    for (const [action, subject] of [
      ["sv-1", AC],
      ["sv-2", AC2],
    ] as const)
      log.dispatch("spec_verifier", {
        task: "T-1",
        feature: "F-1",
        action,
        subject,
        end: "done",
        verdicts: [{ subject, verdict: "pass" }],
      });
    // the human names AC-1 as the Spec Verifier's miss; AC-2 is not named
    log.escalate("T-1", "spec_verifier", "blocked", [{ type: "spec_ref", ref: `spec.md#${AC}` }]);
    log.pr("merged");
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })).toMatchObject({
      subject: AC,
      expected: "fail",
      source: "human_label",
    });
    // task-level evidence applies only to a criterion with none of its own: the merged PR
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-2" })).toMatchObject({
      subject: AC2,
      expected: "pass",
      source: "pr",
    });
  });

  it("reads a label naming the requirement as naming each of its criteria", () => {
    const log = judged("pass");
    log.escalate("T-1", "spec_verifier", "blocked", [{ type: "spec_ref", ref: "REQ-1" }]);
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })?.source).toBe("human_label");
    const other = judged("pass");
    other.escalate("T-1", "spec_verifier", "blocked", [{ type: "spec_ref", ref: "REQ-12" }]);
    expect(recordedOutcome(other.events, { run: "r1", trace: "sv-1" })?.source).toBe("gate");
  });

  it("keeps a label that names no criterion as task-level evidence for every criterion", () => {
    const log = judged("pass");
    log.escalate("T-1", "spec_verifier", "blocked", [{ type: "file_line", ref: "src/a.ts:1" }]);
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })?.source).toBe("human_label");
  });

  it("does not count a human label that blames another role", () => {
    const log = judged("pass");
    log.escalate("T-1", "qa", "blocked");
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })).toMatchObject({
      expected: "pass",
      source: "gate",
    });
  });

  it("makes a later escaped defect on the task a failure", () => {
    const log = judged("pass");
    log.escapedDefect(["T-1"]);
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })).toMatchObject({
      recorded: "pass",
      expected: "fail",
      source: "escaped_defect",
    });
  });

  it("ignores an escaped defect logged before the dispatch or naming another task", () => {
    const before = new RunLog();
    before.escapedDefect(["T-1"]);
    before.dispatch("engineer", { task: "T-1" });
    before.gate("T-1", true);
    before.dispatch("spec_verifier", {
      task: "T-1",
      action: "sv-1",
      subject: AC,
      end: "done",
      verdicts: [{ subject: AC, verdict: "pass" }],
    });
    expect(recordedOutcome(before.events, { run: "r1", trace: "sv-1" })?.source).toBe("gate");
    const other = judged("pass");
    other.escapedDefect(["T-2"]);
    expect(recordedOutcome(other.events, { run: "r1", trace: "sv-1" })?.source).toBe("gate");
  });

  it("reads the human's PR verdict: merged is a pass, closed or reverted a failure", () => {
    const merged = judged("fail");
    merged.pr("merged");
    expect(recordedOutcome(merged.events, { run: "r1", trace: "sv-1" })).toMatchObject({
      recorded: "fail",
      expected: "pass",
      source: "pr",
    });
    const closed = judged("pass");
    closed.pr("closed");
    expect(recordedOutcome(closed.events, { run: "r1", trace: "sv-1" })).toMatchObject({
      expected: "fail",
      source: "pr",
    });
    const reverted = judged("pass");
    reverted.pr("merged");
    reverted.reverted();
    expect(recordedOutcome(reverted.events, { run: "r1", trace: "sv-1" })).toMatchObject({
      expected: "fail",
      source: "pr",
    });
  });

  it("does not take a Level-3 auto-merge as the human's verdict", () => {
    const log = judged("pass");
    log.pr("merged", "merged");
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })?.source).toBe("gate");
  });

  it("grades only the last call on a subject: an earlier one was answered by a later round", () => {
    const log = judged("fail", "sv-1");
    log.dispatch("engineer", { task: "T-1", feature: "F-1" });
    log.gate("T-1", true);
    log.dispatch("spec_verifier", {
      task: "T-1",
      feature: "F-1",
      action: "sv-2",
      subject: AC,
      end: "done",
      verdicts: [{ subject: AC, verdict: "pass" }],
    });
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })).toBeUndefined();
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-2" })?.expected).toBe("pass");
  });

  it("has no outcome for a dispatch that names no subject, did not submit, or saw nothing after", () => {
    const noSubject = new RunLog();
    noSubject.dispatch("engineer", { task: "T-1" });
    noSubject.gate("T-1", true);
    noSubject.dispatch("spec_verifier", { task: "T-1", action: "sv-1", end: "done" });
    expect(recordedOutcome(noSubject.events, { run: "r1", trace: "sv-1" })).toBeUndefined();
    const rejected = new RunLog();
    rejected.dispatch("engineer", { task: "T-1" });
    rejected.gate("T-1", true);
    rejected.dispatch("spec_verifier", {
      task: "T-1",
      action: "sv-1",
      subject: AC,
      end: "rejected",
    });
    expect(recordedOutcome(rejected.events, { run: "r1", trace: "sv-1" })).toBeUndefined();
    const unknownTask = new RunLog();
    unknownTask.dispatch("spec_verifier", {
      task: "T-9",
      action: "sv-1",
      subject: AC,
      end: "done",
      verdicts: [{ subject: AC, verdict: "pass" }],
    });
    expect(recordedOutcome(unknownTask.events, { run: "r1", trace: "sv-1" })).toBeUndefined();
  });

  it("records a missing verdict on the subject as null, never as a guess", () => {
    const log = new RunLog();
    log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", true);
    log.dispatch("spec_verifier", {
      task: "T-1",
      action: "sv-1",
      subject: AC,
      end: "done",
      verdicts: [{ subject: "REQ-2.AC-1", verdict: "pass" }],
    });
    expect(recordedOutcome(log.events, { run: "r1", trace: "sv-1" })).toMatchObject({
      recorded: null,
      expected: "pass",
    });
  });
});

describe("grading a verdict trial (D-ch)", () => {
  const expected = { subject: AC, verdict: "fail" } as const;
  it("passes a trial that gives the expected verdict on the subject", () => {
    expect(gradeVerdictTrial(expected, [{ subject: AC, verdict: "fail" }])).toBe(true);
  });
  it("fails a wrong, unknown, unchecked or missing verdict", () => {
    expect(gradeVerdictTrial(expected, [{ subject: AC, verdict: "pass" }])).toBe(false);
    expect(gradeVerdictTrial(expected, [{ subject: AC, verdict: "unknown" }])).toBe(false);
    expect(gradeVerdictTrial(expected, [{ subject: AC, verdict: "unchecked" }])).toBe(false);
    expect(gradeVerdictTrial(expected, [{ subject: "REQ-9", verdict: "fail" }])).toBe(false);
    expect(gradeVerdictTrial(expected, [])).toBe(false);
  });
  it("fails a trial that answers the subject twice with different verdicts", () => {
    expect(
      gradeVerdictTrial(expected, [
        { subject: AC, verdict: "fail" },
        { subject: AC, verdict: "pass" },
      ]),
    ).toBe(false);
  });
});

describe("grading a verdict replay trial from the log (the RETRO seam, D-ch)", () => {
  const at = { run: "r1", trace: "sv-1" };
  it("scores the trial's result against the replayed dispatch's recorded outcome", () => {
    // the gate passed on the head the Spec Verifier judged: `pass` was the right answer
    const log = judged("fail");
    expect(gradeVerdictReplay(log.events, at, [{ subject: AC, verdict: "pass" }])).toBe("pass");
    expect(gradeVerdictReplay(log.events, at, [{ subject: AC, verdict: "fail" }])).toBe("fail");
    expect(gradeVerdictReplay(log.events, at, [{ subject: AC, verdict: "unknown" }])).toBe("fail");
    expect(gradeVerdictReplay(log.events, at, [])).toBe("fail");
  });

  it("follows the strongest evidence: a later escaped defect makes `fail` the right answer", () => {
    const log = judged("pass");
    log.escapedDefect(["T-1"]);
    expect(gradeVerdictReplay(log.events, at, [{ subject: AC, verdict: "fail" }])).toBe("pass");
    expect(gradeVerdictReplay(log.events, at, [{ subject: AC, verdict: "pass" }])).toBe("fail");
  });

  it("grades against the expectation the trial was planned with, not the outcome at grading", () => {
    const log = judged("fail");
    // planned while the gate result was the strongest evidence
    const planned = { subject: AC, verdict: "pass" as const };
    expect(recordedOutcome(log.events, at)?.expected).toBe(planned.verdict);
    // the feature's PR is reverted before the trial is graded: `fail` would now be expected
    log.reverted();
    expect(recordedOutcome(log.events, at)?.expected).toBe("fail");
    const answer = [{ subject: AC, verdict: "pass" }];
    expect(gradeVerdictReplay(log.events, at, answer, planned)).toBe("pass");
    expect(gradeVerdictReplay(log.events, at, answer)).toBe("fail");
  });

  it("reads the expectation back from a verdict task key, and none from a gates key", () => {
    const key = replayTaskKey({
      run: "r1",
      task: "T-3",
      expected: { subject: AC, verdict: "fail" },
    });
    expect(key).toBe(`r1:${AC}:fail:T-3`);
    expect(expectedOfTaskKey(key)).toEqual({ subject: AC, verdict: "fail" });
    expect(expectedOfTaskKey("r1:T-3")).toBeUndefined();
    expect(expectedOfTaskKey(`r1:a:b:${AC}:pass:T-3`)).toEqual({
      subject: `a:b:${AC}`,
      verdict: "pass",
    });
  });

  it("measures nothing when the replayed dispatch has no recorded outcome", () => {
    const log = judged("pass");
    const answer = [{ subject: AC, verdict: "pass" }];
    expect(gradeVerdictReplay(log.events, { run: "r1", trace: "sv-9" }, answer)).toBe(
      "infra_error",
    );
    expect(gradeVerdictReplay([], at, answer)).toBe("infra_error");
  });
});

describe("verdict-role replay tasks (D-ch)", () => {
  it("replays held-out wrong verdicts to improve and right ones as the regression set", () => {
    const log = new RunLog();
    const wrong = heldOutAction(0);
    const right = heldOutAction(1);
    const noOutcome = heldOutAction(2);
    for (const [task, action, verdict] of [
      ["T-1", wrong, "pass"],
      ["T-2", right, "pass"],
      ["T-3", noOutcome, "pass"],
    ] as const) {
      log.taskCreated(task);
      log.dispatch("engineer", { task, feature: "F-1" });
      if (task !== "T-3") log.gate(task, true);
      log.dispatch("spec_verifier", {
        task,
        feature: "F-1",
        action,
        subject: AC,
        end: "done",
        verdicts: [{ subject: AC, verdict }],
      });
    }
    log.escapedDefect(["T-1"]);
    const tasks = replayTasks({
      baseline,
      history: log.events,
      lockedShaFor,
      attributions: [],
      grader: "verdict",
    });
    expect(tasks).toEqual([
      {
        trace: wrong,
        run: "r1",
        task: "T-1",
        regressionSet: false,
        expected: { subject: AC, verdict: "fail" },
      },
      {
        trace: right,
        run: "r1",
        task: "T-2",
        regressionSet: true,
        expected: { subject: AC, verdict: "pass" },
      },
    ]);
  });

  it("keeps two criteria of one task apart, one in each set, through plan, ledger and result", () => {
    const log = new RunLog();
    const AC2 = "REQ-1.AC-2";
    const first = heldOutAction(0);
    const second = heldOutAction(1);
    log.taskCreated("T-1");
    log.dispatch("engineer", { task: "T-1", feature: "F-1" });
    log.gate("T-1", true);
    for (const [action, subject, verdict] of [
      [first, AC, "pass"],
      [second, AC2, "fail"],
    ] as const)
      log.dispatch("spec_verifier", {
        task: "T-1",
        feature: "F-1",
        action,
        subject,
        end: "done",
        verdicts: [{ subject, verdict }],
      });
    // the escaped defect makes every criterion of T-1 a fail: AC-1's pass was wrong, AC-2's right
    log.escapedDefect(["T-1"]);
    const tasks = replayTasks({
      baseline,
      history: log.events,
      lockedShaFor,
      attributions: [],
      grader: "verdict",
    });
    expect(tasks.map((t) => [replayTaskKey(t), t.regressionSet])).toEqual([
      [`r1:${AC}:fail:T-1`, false],
      [`r1:${AC2}:fail:T-1`, true],
    ]);
    const candidate = promptVersionRef({
      role: "spec_verifier",
      host: HOST,
      locked: LOCKED,
      editable: "Check every criterion against the diff.",
    });
    const trials = planReplayTrials({ tasks, baseline, candidate, withAa: false, k: 1 }).map(
      (t) => ({
        task: replayTaskKey(t.task),
        arm: t.arm,
        trial: t.trial,
        regressionSet: t.task.regressionSet,
      }),
    );
    expect(new Set(trials.map(replayTrialKey)).size).toBe(trials.length);
    const planned = planRetroReplays({
      pending: [
        {
          proposal: "p-sv",
          role: "spec_verifier",
          host: HOST,
          changesFiles: false,
          trials,
          recordedAt: "2026-10-14T09:00:00.000Z",
        },
      ],
      graded: () => new Set(),
      weeklyRemainingPct: 80,
      budgetAvailable: true,
    });
    expect(planned.launch[0]?.trials).toEqual(trials);
    const rows = new Map(
      trials.map((t) => [
        replayTrialKey(t),
        {
          repo_key: "0123456789abcdef",
          proposal: "p-sv",
          baseline: baseline.effective_sha256,
          candidate: candidate.effective_sha256,
          ...t,
          passed: t.arm === "b" || t.regressionSet,
          tokens: 1000,
          read_denied: false,
          grader_bundle_sha: "9".repeat(64),
          graded_at: "2026-10-15T09:00:00.000Z",
        },
      ]),
    );
    const done = assembleReplay({
      proposal: "p-sv",
      baseline,
      candidate,
      grader: "verdict",
      planned: trials,
      rows,
      graderBundleSha: "9".repeat(64),
      now: new Date("2026-10-15T09:00:00.000Z"),
    });
    if (!done.complete) throw new Error("incomplete");
    expect(done.result.per_task).toEqual([
      { task: `r1:${AC}:fail:T-1`, a: [false], b: [true], regression_set: false },
      { task: `r1:${AC2}:fail:T-1`, a: [true], b: [true], regression_set: true },
    ]);
  });

  it("never puts a gates task the baseline failed on in the regression set as well", () => {
    const engineer = promptVersionRef({
      role: "engineer",
      host: HOST,
      locked: LOCKED,
      editable: EDITABLE,
    });
    const log = new RunLog();
    const failedRound = heldOutAction(0);
    const passedRound = heldOutAction(1);
    log.taskCreated("T-1");
    log.dispatch("engineer", { task: "T-1", action: failedRound });
    log.gate("T-1", false);
    log.dispatch("engineer", { task: "T-1", action: passedRound });
    log.gate("T-1", true);
    const attributions = attributeRun({
      events: log.events,
      lockedShaFor,
      now: new Date("2026-10-15T09:00:00.000Z"),
    }).attributions;
    const tasks = replayTasks({
      baseline: engineer,
      history: log.events,
      lockedShaFor,
      attributions,
    });
    expect(tasks.map((t) => [replayTaskKey(t), t.regressionSet])).toEqual([["r1:T-1", false]]);
  });

  it("never replays a train-split dispatch", () => {
    const log = new RunLog();
    let train = "";
    for (let i = 1; i < 1000 && train === ""; i += 1)
      if (traceSplit({ run: "r1", trace: `sv-${String(i)}` }) === "train")
        train = `sv-${String(i)}`;
    log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", true);
    log.dispatch("spec_verifier", {
      task: "T-1",
      action: train,
      subject: AC,
      end: "done",
      verdicts: [{ subject: AC, verdict: "pass" }],
    });
    expect(
      replayTasks({
        baseline,
        history: log.events,
        lockedShaFor,
        attributions: [],
        grader: "verdict",
      }),
    ).toEqual([]);
  });
});

describe("a verdict replay whose recorded outcome changes between two RETROs (D-cg, D-ch)", () => {
  it("never mixes trials graded against one expectation with trials graded against another", () => {
    const log = new RunLog();
    const action = heldOutAction(0);
    log.taskCreated("T-1");
    log.dispatch("engineer", { task: "T-1", feature: "F-1" });
    log.gate("T-1", true);
    log.dispatch("spec_verifier", {
      task: "T-1",
      feature: "F-1",
      action,
      subject: AC,
      end: "done",
      verdicts: [{ subject: AC, verdict: "pass" }],
    });
    const candidate = promptVersionRef({
      role: "spec_verifier",
      host: HOST,
      locked: LOCKED,
      editable: "Check every criterion against the diff.",
    });
    const planAt = () => {
      const tasks = replayTasks({
        baseline,
        history: log.events,
        lockedShaFor,
        attributions: [],
        grader: "verdict",
      });
      return planReplayTrials({ tasks, baseline, candidate, withAa: false, k: 1 }).map((t) => ({
        task: replayTaskKey(t.task),
        arm: t.arm,
        trial: t.trial,
        regressionSet: t.task.regressionSet,
      }));
    };
    // RETRO N: the PR is still open, the gate passed: `pass` is expected, the task is a success
    const first = planAt();
    expect(first.map((t) => [t.task, t.regressionSet])).toEqual([
      [`r1:${AC}:pass:T-1`, true],
      [`r1:${AC}:pass:T-1`, true],
    ]);
    const rows = new Map<string, ReplayTrialRow>();
    const [a1] = first;
    if (a1 === undefined) throw new Error("no trial");
    rows.set(replayTrialKey(a1), {
      repo_key: "0123456789abcdef",
      proposal: "p-sv",
      baseline: baseline.effective_sha256,
      candidate: candidate.effective_sha256,
      task: a1.task,
      arm: a1.arm,
      trial: a1.trial,
      passed: true,
      tokens: 1000,
      read_denied: false,
      grader_bundle_sha: "9".repeat(64),
      graded_at: "2026-10-15T09:00:00.000Z",
    });
    // before RETRO N+1 the feature is reverted: `fail` is expected, the task is now a failure
    log.reverted();
    const second = planAt();
    expect(second.map((t) => [t.task, t.regressionSet])).toEqual([
      [`r1:${AC}:fail:T-1`, false],
      [`r1:${AC}:fail:T-1`, false],
    ]);
    // the grade made against `pass` is not counted: both trials of the new task run again
    const replanned = planRetroReplays({
      pending: [
        {
          proposal: "p-sv",
          role: "spec_verifier",
          host: HOST,
          changesFiles: false,
          trials: second,
          recordedAt: "2026-10-14T09:00:00.000Z",
        },
      ],
      graded: () => new Set(rows.keys()),
      weeklyRemainingPct: 80,
      budgetAvailable: true,
    });
    expect(replanned.launch[0]?.trials).toEqual(second);
    expect(
      assembleReplay({
        proposal: "p-sv",
        baseline,
        candidate,
        grader: "verdict",
        planned: second,
        rows,
        graderBundleSha: "9".repeat(64),
        now: new Date("2026-10-15T09:00:00.000Z"),
      }),
    ).toEqual({ complete: false, missing: 2 });
  });
});

describe("the grader bundle covers the verdict grader (AD-21 rule 5)", () => {
  it("hashes the verdict grader's version and roles with the rest of the bundle", () => {
    const bundle = { judgeModel: null, gatesConfigHash: "e".repeat(64) };
    const withoutVerdictGrader = sha256Hex(
      JSON.stringify({
        metrics_version: LOOKBACK_METRICS_VERSION,
        attribution_tree: Object.entries(ATTRIBUTION_TREE).sort(([a], [b]) => a.localeCompare(b)),
        limits: Object.entries(LOOKBACK_LIMITS).sort(([a], [b]) => a.localeCompare(b)),
        judge_model: null,
        gates_config_hash: "e".repeat(64),
      }),
    );
    const withVerdictGrader = sha256Hex(
      JSON.stringify({
        metrics_version: LOOKBACK_METRICS_VERSION,
        attribution_tree: Object.entries(ATTRIBUTION_TREE).sort(([a], [b]) => a.localeCompare(b)),
        limits: Object.entries(LOOKBACK_LIMITS).sort(([a], [b]) => a.localeCompare(b)),
        judge_model: null,
        gates_config_hash: "e".repeat(64),
        verdict_grader: {
          version: VERDICT_GRADER_VERSION,
          roles: [...VERDICT_GRADED_ROLES].sort(),
        },
      }),
    );
    expect(graderBundleSha(bundle)).not.toBe(withoutVerdictGrader);
    expect(graderBundleSha(bundle)).toBe(withVerdictGrader);
  });
});
