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
  graderBundleSha,
  gradeVerdictTrial,
  LOOKBACK_METRICS_VERSION,
  promptVersionRef,
  recordedOutcome,
  replayTasks,
  traceSplit,
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
