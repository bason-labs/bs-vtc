/**
 * The verdict grader (D-ch; spine §5 reading 202; AD-21 rules 5 and 6). A verdict role
 * (`VERDICT_GRADED_ROLES`: the Spec Verifier first) changes no file, so the gates cannot tell its
 * replay arms apart. Instead each trial's verdict is scored against the **recorded outcome** of the
 * dispatch it replays: what the replayed verdict should have been, read from what the log shows
 * happened to the work it judged.
 *
 * {@link recordedOutcome} reads it, strongest evidence first:
 * 1. `human_label`: a later escalation on the task (or its feature) answered with
 *    `who_should_have_caught` naming the role. The human's label is the gold standard (spec §13):
 *    the role missed something, so the verdict should have been `fail`. A label whose escalation
 *    names criteria (a `spec_ref` evidence ref holding an AC or requirement id; a requirement names
 *    each of its criteria) speaks to those criteria only; one that names none speaks to the task.
 * 2. `escaped_defect`: a later `lookback.escaped_defect` naming the task (or, naming no task, its
 *    feature): the work was wrong, so `fail`.
 * 3. `pr`: the human's verdict on the feature's PR after the dispatch: reverted (`feature.reverted`)
 *    or closed unmerged is `fail`, merged by a human is `pass`. A Level-3 auto-merge
 *    (`auto_merge: merged`) is the engine's, not a human's, and does not count.
 * 4. `gate`: the latest gate result (`pass` or `fail`; an infra error says nothing) on the head the
 *    dispatch judged: the task's last submitted head before it, or, when no head is recorded, the
 *    task's latest gate run before it.
 * The human's G-gate verdicts (`gate.approved`/`gate.rejected`, G1 and G2) judge the spec and the
 * architecture before any task exists, so they carry no verdict on a task's criterion; a human's
 * judgement of one reaches the log as an escalation label or the PR verdict above.
 *
 * **Granularity** (spine §5 reading 212(4), amending reading 202). A replay task is one acceptance
 * criterion (the dispatch's subject). Evidence that names the criterion wins: a human label naming
 * it decides it. Task-level evidence (a label naming no criterion, an escaped defect, the PR
 * verdict, the gate result) applies only to a criterion no label names; a label naming other
 * criteria of the task says nothing about this one. A task-level label still gives every criterion
 * of the task the same `fail`, which favours a candidate that fails more often; naming the
 * criterion in the escalation's evidence avoids it.
 *
 * Only the last call of the role on a (task, subject) is graded: an earlier call was followed by
 * another round on new work, so what happened next speaks to that round, not to the earlier
 * verdict. A dispatch that names no subject, did not submit, or has none of the evidence above has
 * no recorded outcome and is never a replay task.
 *
 * {@link gradeVerdictTrial} passes a trial only when it gives exactly the expected verdict on the
 * subject; `unknown`, `unchecked`, a missing or a contradictory answer fail it. The grader is part
 * of the hashed grader bundle ({@link VERDICT_GRADER_VERSION}, `graderBundleSha`), so a replay
 * graded by another version of it is never compared with this one.
 */
import {
  isEventOfType,
  readEventData,
  type GateVerdict,
  type Verdict,
  type VtcEvent,
} from "@vtc/shared";

/**
 * Bump when what {@link recordedOutcome} reads or how a trial is scored changes. 2: a trial is
 * scored against the expectation its task key carries (`replayTaskKey`), not the outcome at grading.
 * 3: a human label naming criteria decides those criteria only (reading 212(4)).
 */
export const VERDICT_GRADER_VERSION = 3;

export type RecordedOutcomeSource = "human_label" | "escaped_defect" | "pr" | "gate";

/** What a verdict dispatch should have answered, from what happened next. */
export interface RecordedOutcome {
  /** The one subject the dispatch judged (`role.dispatched.subject`). */
  readonly subject: string;
  /** The verdict it gave on that subject; `null` when its result named none. */
  readonly recorded: Verdict | null;
  readonly expected: "pass" | "fail";
  readonly source: RecordedOutcomeSource;
}

/** The verdict a replay trial of a verdict role must give to pass. */
export interface ExpectedVerdict {
  readonly subject: string;
  readonly verdict: "pass" | "fail";
}

const actionOf = (event: VtcEvent): string | undefined => {
  const id = (event.data as { action_id?: unknown }).action_id;
  return typeof id === "string" ? id : undefined;
};

/** The feature of `task` in `run`'s events (`task.created`), when the dispatch names none. */
const featureOfTask = (events: readonly VtcEvent[], task: string): string | undefined => {
  for (const event of events) {
    if (!isEventOfType(event, "task.created")) continue;
    const created = readEventData(event).task;
    if (created.id === task) return created.feature;
  }
  return undefined;
};

/** AC or requirement ids in an evidence ref (`spec.md#REQ-3.AC-2`, `REQ-3`). */
const CRITERION_ID = /(?<![A-Za-z0-9])(?:REQ|SEC)-[1-9]\d*(?:\.AC-[1-9]\d*)?(?![0-9])/g;

/** Whether criterion id `named` names `subject` (a requirement names each of its criteria). */
const names = (named: string, subject: string): boolean =>
  named === subject || subject.startsWith(`${named}.`);

/**
 * The human labels after `seq` that blame `role` for the task or its feature: `criterion` when
 * one names `subject`, `task` when none does but one names no criterion at all, else `undefined`
 * (reading 212(4)).
 */
const humanLabel = (
  events: readonly VtcEvent[],
  seq: number,
  role: string,
  task: string | undefined,
  feature: string | undefined,
  subject: string,
): "criterion" | "task" | undefined => {
  const scopes = new Map<string, { task?: string; feature?: string; criteria: string[] }>();
  let found: "task" | undefined;
  for (const event of events) {
    if (isEventOfType(event, "escalation.opened")) {
      const { escalation } = readEventData(event);
      scopes.set(escalation.id, {
        ...(escalation.task === undefined ? {} : { task: escalation.task }),
        ...(escalation.feature === undefined ? {} : { feature: escalation.feature }),
        criteria: escalation.evidence
          .filter((e) => e.type === "spec_ref")
          .flatMap((e) => e.ref.match(CRITERION_ID) ?? []),
      });
    } else if (isEventOfType(event, "escalation.answered") && event.seq > seq) {
      const data = readEventData(event);
      if (data.answer.who_should_have_caught !== role) continue;
      const scope = scopes.get(data.escalation);
      if (scope === undefined) continue;
      const inScope =
        (task !== undefined && scope.task === task) ||
        (scope.task === undefined && feature !== undefined && scope.feature === feature);
      if (!inScope) continue;
      if (scope.criteria.some((c) => names(c, subject))) return "criterion";
      if (scope.criteria.length === 0) found = "task";
    }
  }
  return found;
};

const escapedDefect = (
  events: readonly VtcEvent[],
  seq: number,
  task: string | undefined,
  feature: string | undefined,
): boolean =>
  events.some((event) => {
    if (event.seq <= seq || !isEventOfType(event, "lookback.escaped_defect")) return false;
    const defect = readEventData(event);
    if (task !== undefined && defect.tasks.includes(task)) return true;
    return defect.tasks.length === 0 && feature !== undefined && event.feature === feature;
  });

/** The human's verdict on the feature's PR after `seq`, or `undefined`. */
const prVerdict = (
  events: readonly VtcEvent[],
  seq: number,
  feature: string | undefined,
): "pass" | "fail" | undefined => {
  if (feature === undefined) return undefined;
  let verdict: "pass" | "fail" | undefined;
  for (const event of events) {
    if (event.seq <= seq || event.feature !== feature) continue;
    if (isEventOfType(event, "feature.reverted")) return "fail";
    if (!isEventOfType(event, "feature.pr_updated")) continue;
    const { pr } = readEventData(event);
    if (pr.state === "closed") verdict = "fail";
    else if (pr.state === "merged") verdict = pr.auto_merge === "merged" ? verdict : "pass";
  }
  return verdict;
};

/** The gate verdict on the head the dispatch judged (see the module comment), or `undefined`. */
const gateVerdict = (
  events: readonly VtcEvent[],
  seq: number,
  task: string | undefined,
): "pass" | "fail" | undefined => {
  if (task === undefined) return undefined;
  let head: string | undefined;
  for (const event of events) {
    if (event.seq >= seq) break;
    if (event.task !== task || !isEventOfType(event, "role.submitted")) continue;
    const submittedHead = readEventData(event).head;
    if (submittedHead !== undefined) head = submittedHead;
  }
  let verdict: "pass" | "fail" | undefined;
  for (const event of events) {
    if (!isEventOfType(event, "gate.result")) continue;
    const report = readEventData(event);
    if ((report.task ?? event.task) !== task || report.verdict === "infra_error") continue;
    if (head === undefined ? event.seq < seq : report.head === head) verdict = report.verdict;
  }
  return verdict;
};

/**
 * The recorded outcome of the verdict dispatch `at` (`<run>`, `role.dispatched.action_id`) in the
 * history, or `undefined` when it has none (see the module comment for the order of evidence).
 */
export const recordedOutcome = (
  history: readonly VtcEvent[],
  at: { readonly run: string; readonly trace: string },
): RecordedOutcome | undefined => {
  const events = history.filter((e) => e.run === at.run).sort((a, b) => a.seq - b.seq);
  const dispatched = events.find(
    (e) => isEventOfType(e, "role.dispatched") && actionOf(e) === at.trace,
  );
  if (dispatched === undefined || !isEventOfType(dispatched, "role.dispatched")) return undefined;
  const role = dispatched.role;
  const { subject, mode } = readEventData(dispatched);
  if (role === undefined || subject === undefined) return undefined;
  const task = dispatched.task;
  const feature =
    dispatched.feature ?? (task === undefined ? undefined : featureOfTask(events, task));
  if (task === undefined && feature === undefined) return undefined;
  const submitted = events.find(
    (e) => e.seq > dispatched.seq && isEventOfType(e, "role.submitted") && actionOf(e) === at.trace,
  );
  if (submitted === undefined || !isEventOfType(submitted, "role.submitted")) return undefined;
  const superseded = events.some((e) => {
    if (e.seq <= dispatched.seq || !isEventOfType(e, "role.dispatched")) return false;
    const data = readEventData(e);
    return (
      e.role === role &&
      data.mode === mode &&
      data.subject === subject &&
      e.task === task &&
      data.purpose !== "lookback_replay"
    );
  });
  if (superseded) return undefined;
  const recorded =
    readEventData(submitted).verdicts.find((v) => v.subject === subject)?.verdict ?? null;
  const outcome = (expected: "pass" | "fail", source: RecordedOutcomeSource): RecordedOutcome => ({
    subject,
    recorded,
    expected,
    source,
  });
  if (humanLabel(events, submitted.seq, role, task, feature, subject) !== undefined)
    return outcome("fail", "human_label");
  if (escapedDefect(events, submitted.seq, task, feature)) return outcome("fail", "escaped_defect");
  const pr = prVerdict(events, submitted.seq, feature);
  if (pr !== undefined) return outcome(pr, "pr");
  const gate = gateVerdict(events, dispatched.seq, task);
  return gate === undefined ? undefined : outcome(gate, "gate");
};

/**
 * Pure: whether a verdict trial passed. It must answer the expected verdict on the subject, once
 * or consistently; `unknown`, `unchecked`, a missing or a contradictory answer fail it.
 */
export const gradeVerdictTrial = (
  expected: ExpectedVerdict,
  verdicts: readonly { readonly subject: string; readonly verdict: string }[],
): boolean => {
  const answers = verdicts.filter((v) => v.subject === expected.subject);
  return answers.length > 0 && answers.every((v) => v.verdict === expected.verdict);
};

/**
 * The verdict grader as RETRO calls it for one trial (the `gradeVerdict` seam core's
 * `LookbackRetro` names; D-ch, reading 202): the trial's verdicts scored against the expectation
 * the trial was planned with (`expected`: the `ReplayTask.expected`, or `expectedOfTaskKey` of the
 * trial's task key). A replay can span RETROs and the history can gain evidence in between, so a
 * trial is never graded against a recomputed outcome its task's key and regression-set membership
 * do not carry (a changed expectation is a new replay task, `replayTaskKey`). `pass` or `fail`
 * measure the trial ({@link gradeVerdictTrial}); `infra_error` measures nothing: the replayed
 * dispatch (`at`: its run and action id, its pack's `run` and `action_id`) has no recorded outcome
 * in `history` (the runs' events without replay trials) any more, so nothing can say which verdict
 * was right. Without `expected` the trial is graded against the recorded outcome as `history`
 * shows it now.
 */
export const gradeVerdictReplay = (
  history: readonly VtcEvent[],
  at: { readonly run: string; readonly trace: string },
  verdicts: readonly { readonly subject: string; readonly verdict: string }[],
  expected?: ExpectedVerdict,
): GateVerdict => {
  const outcome = recordedOutcome(history, at);
  if (outcome === undefined) return "infra_error";
  const against = expected ?? { subject: outcome.subject, verdict: outcome.expected };
  return gradeVerdictTrial(against, verdicts) ? "pass" : "fail";
};
