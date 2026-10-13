/**
 * The verification half of a round (§6.3 steps 5–10): recording triaged findings, deciding the
 * round's outcome (park on a risk rule, another fix round, stuck or cap, or all clear → built →
 * merge queue). Synchronous: callers have already done the I/O (gates, git, evidence checks).
 */
import type { Evidence, Finding, GateReport } from "@vtc/shared";
import type { Kernel, RunHandle } from "./kernel.js";
import { decideAfterFailedRound, findingRiskRule } from "./loop.js";
import { parkTask, setTaskStatus } from "./parking.js";
import { taskFindings } from "./queries.js";
import {
  findingFromGateFailure,
  findingFromTool,
  mergeRound,
  type RoundMerge,
} from "./triage.js";

/** Records a round's findings (new, repeated, resolved by silence) and returns the merge. */
export const recordRoundFindings = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
  fresh: readonly Finding[],
  ranSources: ReadonlySet<string>,
): RoundMerge => {
  const task = h.state.tasks.get(taskId);
  const round = task?.round ?? 1;
  const normalized = fresh.map((f) =>
    f.route === "defer" && f.status === "open" ? { ...f, status: "deferred" as const } : f,
  );
  const merge = mergeRound(taskFindings(h.state, taskId), normalized, ranSources, round);
  for (const finding of merge.recorded) {
    k.emit(h, { type: "finding.recorded", actor: "engine", task: taskId, data: { finding } });
  }
  for (const finding of merge.resolved) {
    k.emit(h, {
      type: "finding.status_changed",
      actor: "engine",
      task: taskId,
      data: { fingerprint: finding.fingerprint, from: "open", to: "resolved" },
    });
  }
  return merge;
};

const evidenceOf = (findings: readonly Finding[]): Evidence[] =>
  findings.slice(0, 5).map((f) => f.evidence);

/** A failed round: another fix round, or park as stuck / at the cap (§6.3 step 9). */
export const failRound = (k: Kernel, h: RunHandle, taskId: string, reappeared: boolean): void => {
  const task = h.state.tasks.get(taskId);
  if (task === undefined) return;
  const findings = taskFindings(h.state, taskId);
  const decision = decideAfterFailedRound({
    round: Math.max(1, task.round),
    cap: task.cap,
    findings,
    reappeared,
    identicalTree: k.identicalTree.get(taskId) ?? false,
  });
  k.identicalTree.delete(taskId);
  if (decision.kind === "park") {
    parkTask(k, h, taskId, {
      reason: decision.reason,
      detail: decision.detail,
      evidence: evidenceOf(findings.filter((f) => f.status === "open")),
    });
    return;
  }
  setTaskStatus(k, h, taskId, "fixing", { round: decision.round });
};

/**
 * The outcome of a round once its findings are recorded: a secret or a §7.6 rule 8/9 finding
 * parks; a spec or design gap parks for the human (the BA/Designer loop is the front half's);
 * open patch or test findings fail the round; otherwise the task is built and queued.
 */
export const settleRound = (k: Kernel, h: RunHandle, taskId: string, merge: RoundMerge): void => {
  const task = h.state.tasks.get(taskId);
  if (task === undefined) return;
  const open = taskFindings(h.state, taskId).filter((f) => f.status === "open");
  const secret = open.find((f) => f.route === "risky");
  if (secret !== undefined) {
    parkTask(k, h, taskId, {
      reason: "risk_rule",
      riskRule: "committed_secret",
      detail: `secret found: ${secret.title}`,
      evidence: [secret.evidence],
    });
    return;
  }
  const rule = findingRiskRule(taskFindings(h.state, taskId), Math.max(1, task.round));
  if (rule !== null && rule.finding.status === "open") {
    parkTask(k, h, taskId, {
      reason: "risk_rule",
      riskRule: rule.rule,
      detail: `${rule.rule.replace(/_/g, " ")}: ${rule.finding.title}`,
      evidence: [rule.finding.evidence],
    });
    return;
  }
  const gaps = open.filter((f) => f.route === "spec_gap" || f.route === "design_gap");
  if (gaps.length > 0) {
    parkTask(k, h, taskId, {
      reason: "spec_conflict",
      detail: gaps.map((f) => `${f.route}: ${f.title}`).join("; "),
      evidence: evidenceOf(gaps),
    });
    return;
  }
  if (open.some((f) => f.route === "patch" || f.route === "bad_test" || f.route === "out_of_scope")) {
    failRound(k, h, taskId, merge.reappeared);
    return;
  }
  markBuilt(k, h, taskId);
};

/** All clear (§6.3 step 10): built, then into the merge queue. */
export const markBuilt = (k: Kernel, h: RunHandle, taskId: string): void => {
  const task = h.state.tasks.get(taskId);
  if (task === undefined) return;
  if (task.status !== "built") setTaskStatus(k, h, taskId, "built");
  setTaskStatus(k, h, taskId, "queued");
};

/** Findings of a failed gate report: parsed tool findings, or one per failed gate without any. */
export const gateFindings = (report: GateReport, taskId: string | undefined, round: number): Finding[] => {
  const ctx = { ...(taskId === undefined ? {} : { task: taskId }), round };
  const out: Finding[] = [];
  for (const result of report.results) {
    for (const tool of result.findings) out.push(findingFromTool(tool, ctx));
    const failed = result.blocking && (result.status === "fail" || result.status === "error");
    if (failed && result.findings.length === 0) out.push(findingFromGateFailure(result, ctx));
  }
  return out;
};

/** Sources a gate run verifies: every tool-sourced finding is re-checked by a full run. */
export const gateSources = (h: RunHandle, taskId: string, fresh: readonly Finding[]): Set<string> =>
  new Set([
    ...taskFindings(h.state, taskId)
      .filter((f) => f.source === "tool")
      .map((f) => f.source_name),
    ...fresh.map((f) => f.source_name),
  ]);
