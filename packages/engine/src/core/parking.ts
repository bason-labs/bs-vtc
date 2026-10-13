/**
 * Parking and escalation (§6.5; D5): a park stops only its own task and blocks only its transitive
 * dependents; the human's answer resumes the task from its checkpoint (same worktree and session,
 * plus the answer as new input), or waives, raises the budget, or drops it.
 */
import {
  escalationFromQuestion,
  readEventData,
  type Escalation,
  type EscalationAnswer,
  type Evidence,
  type ParkReason,
  type Question,
  type RiskRuleReasonRule,
  type TaskStatus,
} from "@vtc/shared";
import { raisedBudget, usd } from "./budget.js";
import { parkEscalation } from "./escalations.js";
import { EngineError, type Kernel, type RunHandle } from "./kernel.js";
import { assertTaskTransition } from "./machines.js";
import { nextEscalationId, taskFindings } from "./queries.js";
import { transitiveDependents } from "./scheduler.js";

export interface StatusOptions {
  readonly round?: number;
  readonly parkReason?: ParkReason;
  readonly riskRule?: RiskRuleReasonRule;
}

/** The one way a task changes state: validated against the §6.4 machine, then logged. */
export const setTaskStatus = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
  to: TaskStatus,
  options: StatusOptions = {},
): void => {
  const task = h.state.tasks.get(taskId);
  if (task === undefined) throw new EngineError("invalid", `no task ${taskId}`);
  assertTaskTransition(taskId, task.status, to);
  k.emit(h, {
    type: "task.status_changed",
    actor: "engine",
    task: taskId,
    data: {
      from: task.status,
      to,
      round: options.round ?? task.round,
      cap: task.cap,
      ...(options.parkReason === undefined ? {} : { park_reason: options.parkReason }),
      ...(options.riskRule === undefined ? {} : { risk_rule: options.riskRule }),
    },
  });
};

export interface ParkInput {
  readonly reason: ParkReason;
  readonly riskRule?: RiskRuleReasonRule;
  readonly detail: string;
  readonly evidence: readonly Evidence[];
  /** A role's own question (Engineer `blocked`, QA `spec_question`) becomes the escalation. */
  readonly question?: Question;
  readonly raisedBy?: string;
}

/** Opens an escalation for a task (parking it unless the reason is a non-blocking question). */
export const openTaskEscalation = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
  input: ParkInput,
): Escalation => {
  const id = nextEscalationId(h.state);
  const blocks =
    input.reason === "spec_question"
      ? []
      : [taskId, ...transitiveDependents(taskId, h.state.tasks.values())];
  const escalation =
    input.question === undefined
      ? parkEscalation({
          id,
          run: h.state.id,
          task: taskId,
          reason: input.reason,
          ...(input.riskRule === undefined ? {} : { riskRule: input.riskRule }),
          detail: input.detail,
          evidence: input.evidence,
          blocks,
          now: k.now(),
          ...(input.raisedBy === undefined ? {} : { raisedBy: input.raisedBy }),
        })
      : escalationFromQuestion(input.question, {
          id,
          run: h.state.id,
          task: taskId,
          reason: input.reason,
          created_at: k.now().toISOString(),
          blocks,
          ...(input.raisedBy === undefined ? {} : { raised_by: input.raisedBy }),
        });
  k.emit(h, { type: "escalation.opened", actor: "engine", task: taskId, data: { escalation } });
  return escalation;
};

/** Parks a task with an escalation (§6.5). No-op when it is already parked or finished. */
export const parkTask = (k: Kernel, h: RunHandle, taskId: string, input: ParkInput): void => {
  const task = h.state.tasks.get(taskId);
  if (task === undefined || ["parked", "dropped", "done", "merged"].includes(task.status)) return;
  setTaskStatus(k, h, taskId, "parked", {
    parkReason: input.reason,
    ...(input.reason === "risk_rule" && input.riskRule !== undefined
      ? { riskRule: input.riskRule }
      : {}),
  });
  openTaskEscalation(k, h, taskId, input);
};

/** Drops a task and everything that depends on it (the escalation listed them in `blocks`). */
export const dropTask = (k: Kernel, h: RunHandle, taskId: string): void => {
  for (const id of [taskId, ...transitiveDependents(taskId, h.state.tasks.values())]) {
    const task = h.state.tasks.get(id);
    if (task !== undefined && !["dropped", "done", "merged"].includes(task.status)) {
      setTaskStatus(k, h, id, "dropped");
    }
  }
};

/** Where a parked task resumes, by why it parked and what the human chose. */
const resumeTarget = (
  h: RunHandle,
  taskId: string,
  reason: ParkReason,
  effect: string,
): TaskStatus => {
  const checkpoint = h.state.checkpoints.get(taskId) ?? "fixing";
  if (reason === "cap" || reason === "stuck") {
    if (effect === "waive") {
      const open = taskFindings(h.state, taskId).filter((f) => f.status === "open");
      return open.length === 0 ? "built" : "fixing";
    }
    return "fixing";
  }
  if (reason === "risk_rule" && effect === "hint") return "fixing";
  return checkpoint;
};

/** Waives every open finding of a task, each with an expiring human waiver (§6.5). */
const waiveFindings = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
  reason: string,
  expiresAt: string,
): void => {
  for (const finding of taskFindings(h.state, taskId)) {
    if (finding.status !== "open") continue;
    k.emit(h, {
      type: "finding.status_changed",
      actor: "human",
      task: taskId,
      data: {
        fingerprint: finding.fingerprint,
        from: "open",
        to: "waived",
        waiver: { by: "human", reason, expires_at: expiresAt },
      },
    });
  }
};

const originalBudget = (h: RunHandle, taskId: string): number => {
  const created = h.state.events.find((e) => e.type === "task.created" && e.task === taskId);
  if (created?.type !== "task.created") return h.state.tasks.get(taskId)?.budget_usd ?? 0;
  return readEventData(created as typeof created & { type: "task.created" }).task.budget_usd;
};

/**
 * Applies the human's answer (§6.5 typical answers) after `escalation.answered` was recorded:
 * waive, hint, retry, clarify, raise the budget (≤ 2×), drop, re-plan (drops the task; the
 * re-plan itself is a front-half step), or decide a change request.
 */
export const applyAnswer = (
  k: Kernel,
  h: RunHandle,
  escalation: Escalation,
  answer: EscalationAnswer,
): void => {
  const option = escalation.options.find((o) => o.id === answer.option);
  if (option === undefined)
    throw new EngineError("invalid", `option ${answer.option} is not offered`);
  const taskId = escalation.task;
  const task = taskId === undefined ? undefined : h.state.tasks.get(taskId);
  if (option.effect === "approve_change" || option.effect === "reject_change") return;
  if (taskId === undefined || task === undefined) return;
  if (option.effect === "drop" || option.effect === "replan") {
    dropTask(k, h, taskId);
    return;
  }
  if (option.effect === "raise_budget" && option.budget_factor !== undefined) {
    const budget = usd(
      raisedBudget(originalBudget(h, taskId), task.budget_usd, option.budget_factor),
    );
    k.emit(h, {
      type: "budget.updated",
      actor: "human",
      task: taskId,
      data: { scope: "task", budget_usd: budget, spent_usd: task.spent_usd },
    });
  }
  if (option.effect === "waive" && option.waiver_expires_at !== undefined) {
    waiveFindings(k, h, taskId, answer.text ?? option.label, option.waiver_expires_at);
  }
  if (task.status !== "parked") return;
  if (escalation.reason === "spec_question") return;
  setTaskStatus(k, h, taskId, resumeTarget(h, taskId, escalation.reason, option.effect));
};
