/**
 * `submit` (§4.2 step 3; AD-4 rule 1, AD-8 rules 2, 9 and 14): a role result is accepted only for
 * an open action the engine dispatched, after conformance to the role contract, an order check,
 * the submit snapshot commit, the write-scope check and the claim checks. Anything else is
 * rejected with a `RejectReason`; a rejection changes nothing but the log (and, for an
 * Engineer's write-scope violation, records the test-integrity hit, §6.3 step 4).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capForRisk,
  checkResultAgainstContract,
  escalationFromQuestion,
  HIDDEN_TESTS,
  resolveRoleMode,
  type ArtifactRef,
  type Finding,
  type HostFailureOutcome,
  type Phase,
  type Question,
  type RejectReason,
  type RoleResult,
  type RunUsage,
  type SubmitInput,
  type Task,
  type TaskDraft,
} from "@vtc/shared";
import { budgetState, sharesExceeded, taskBudgetFor, usd } from "./budget.js";
import { DEFAULT_ACCEPTANCE_GLOBS } from "./config.js";
import { resolves, unresolved } from "./evidence.js";
import { matchesAny } from "./globs.js";
import { adoptGateOutput, protectedFiles, startBaseCheck, startRoundGates } from "./jobs.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { recordLimit } from "./limits.js";
import { openTaskEscalation, parkTask, setTaskStatus } from "./parking.js";
import { checkRunWrites, reportWrites, sweepCheckouts, writePathsOf } from "./checkout-guard.js";
import { dropCheckoutRecord, runsInCheckout, type WriteFindings } from "./phase-scope.js";
import {
  clarifications,
  frozenFor,
  isClarifier,
  MAX_CLARIFICATIONS,
  openChangeRequest,
  resolveGaps,
} from "./clarify.js";
import { checkPlan } from "./plan-check.js";
import {
  consecutiveFailures,
  inFlight,
  lastBuilt,
  nextEscalationId,
  nextNumberedId,
  shareSpend,
  taskFindings,
  usedFeatureIds,
  usedTaskIds,
} from "./queries.js";
import { frozenSpecItems } from "./read-model.js";
import { saveResult } from "./results.js";
import { completedReviews, evidenceContext, isReviewer, startTriage } from "./review.js";
import { specRequirementIds } from "./spec.js";
import type { RoleRunRecord } from "./state.js";
import { findingFromDraft, findingsFromWriteScope } from "./triage.js";
import { recordRoundFindings, settleRound } from "./verify.js";

export interface Rejection {
  readonly reason: RejectReason;
  readonly issues: string[];
}

export type SubmitOutcome =
  { readonly accepted: true } | { readonly accepted: false; readonly rejection: Rejection };

/** A role step's verdict before anything is logged. */
type StepOutcome =
  | {
      readonly kind: "reject";
      readonly rejection: Rejection;
      readonly findings?: readonly Finding[];
    }
  | {
      readonly kind: "accept";
      readonly head?: string;
      readonly artifacts?: readonly ArtifactRef[];
      readonly after: () => void | Promise<void>;
    };

/** After this many rejected or failed runs in a row, a task's step parks as stuck. */
export const MAX_STEP_FAILURES = 3;

/** Front-half roles and the phase they belong to (§6.1). */
const PHASE_OF_ROLE: Readonly<Record<string, Phase>> = {
  repo_cartographer: "discover",
  research_analyst: "discover",
  ba: "specify",
  architect: "design",
  designer: "design",
  planner: "plan",
};

const rejection = (reason: RejectReason, issues: readonly string[]): Rejection => ({
  reason,
  issues: issues.slice(0, 20).map((i) => i.slice(0, 500)),
});

const reject = (reason: RejectReason, issues: readonly string[]): StepOutcome => ({
  kind: "reject",
  rejection: rejection(reason, issues),
});

const fileSha = (repoRoot: string, path: string): string | undefined => {
  const abs = join(repoRoot, path);
  return existsSync(abs) ? createHash("sha256").update(readFileSync(abs)).digest("hex") : undefined;
};

// ---------------------------------------------------------------- bookkeeping

/** Records the spend of a run (§11): task, feature and run budgets. Unpriced spend stays unknown. */
const recordSpend = (k: Kernel, h: RunHandle, run: RoleRunRecord, cost: number | null): void => {
  if (cost === null || cost === 0) return;
  const task = run.task === undefined ? undefined : h.state.tasks.get(run.task);
  if (task !== undefined) {
    k.emit(h, {
      type: "budget.updated",
      actor: "engine",
      task: task.id,
      data: { scope: "task", budget_usd: task.budget_usd, spent_usd: usd(task.spent_usd + cost) },
    });
    const feature = h.state.features.get(task.feature);
    if (feature !== undefined) {
      k.emit(h, {
        type: "budget.updated",
        actor: "engine",
        feature: feature.id,
        data: {
          scope: "feature",
          budget_usd: feature.budget_usd,
          spent_usd: usd(feature.spent_usd + cost),
        },
      });
    }
  }
  const features = [...h.state.features.values()];
  if (features.length > 0) {
    const previous =
      h.state.runBudget?.spent_usd ??
      features.reduce((s, f) => s + f.spent_usd, 0) - (task === undefined ? 0 : cost);
    k.emit(h, {
      type: "budget.updated",
      actor: "engine",
      data: {
        scope: "run",
        budget_usd: usd(features.reduce((s, f) => s + f.budget_usd, 0)),
        spent_usd: usd(previous + cost),
      },
    });
  }
};

/** At 100% of its budget a task finishes the current turn, then parks (§11, §7.6 rule 13). */
const checkBudget = (k: Kernel, h: RunHandle, taskId: string | undefined): void => {
  const task = taskId === undefined ? undefined : h.state.tasks.get(taskId);
  if (task === undefined) return;
  if (
    ["parked", "dropped", "done", "merged", "queued", "built", "interrupted"].includes(task.status)
  )
    return;
  if (budgetState(task.spent_usd, task.budget_usd) !== "exhausted") return;
  parkTask(k, h, task.id, {
    reason: "budget",
    detail: `spent $${task.spent_usd.toFixed(2)} of $${task.budget_usd.toFixed(2)}`,
    evidence: [{ type: "file", ref: `.vtc/tasks/${task.id}.md` }],
  });
};

/** Statuses in which the Engineer runs next (its share is checked before it runs again). */
const ENGINEER_NEXT: readonly string[] = ["tests_authored", "building", "fixing"];

/**
 * §11 Engineer share: once the Engineer has spent more than 45% of the task budget it is not
 * dispatched again; the task parks with evidence (a human may raise the budget, §6.5).
 */
export const checkEngineerShare = (k: Kernel, h: RunHandle): boolean => {
  let parked = false;
  for (const task of [...h.state.tasks.values()]) {
    if (!ENGINEER_NEXT.includes(task.status)) continue;
    if (inFlight(h.state).some((r) => r.task === task.id && r.role === "engineer")) continue;
    const spend = shareSpend(h.state, task.id);
    if (!sharesExceeded(spend, task.budget_usd).engineer) continue;
    parkTask(k, h, task.id, {
      reason: "budget",
      detail: `the Engineer spent $${spend.engineer.toFixed(2)}, over its 45% share of the $${task.budget_usd.toFixed(2)} task budget`,
      evidence: [{ type: "file", ref: `.vtc/tasks/${task.id}.md` }],
    });
    parked = true;
  }
  return parked;
};

/** A step that keeps failing parks its task as stuck (no infinite redispatch, §1.1 #2). */
const stepFailed = (k: Kernel, h: RunHandle, run: RoleRunRecord): void => {
  if (run.task === undefined) return;
  const failures = consecutiveFailures(h.state, {
    role: run.role,
    ...(run.mode === undefined ? {} : { mode: run.mode }),
    task: run.task,
    ...(run.subject === undefined ? {} : { subject: run.subject }),
  });
  if (failures >= MAX_STEP_FAILURES) {
    parkTask(k, h, run.task, {
      reason: "stuck",
      detail: `${run.role}${run.mode === undefined ? "" : ` (${run.mode})`} failed or was rejected ${String(failures)} times in a row`,
      evidence: [{ type: "file", ref: `.vtc/tasks/${run.task}.md` }],
    });
  }
};

const logRejection = (k: Kernel, h: RunHandle, run: RoleRunRecord, value: Rejection): void => {
  k.emit(h, {
    type: "role.rejected",
    actor: "engine",
    role: run.role,
    ...(run.task === undefined ? {} : { task: run.task }),
    data: { action_id: run.action_id, reason: value.reason, issues: value.issues },
  });
};

const emitSubmitted = (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  result: RoleResult,
  usage: RunUsage | undefined,
  extras: { readonly head?: string; readonly artifacts?: readonly ArtifactRef[] },
): void => {
  k.emit(h, {
    type: "role.submitted",
    actor: "role",
    role: run.role,
    ...(run.task === undefined ? {} : { task: run.task }),
    ...(run.feature === undefined ? {} : { feature: run.feature }),
    prompt_sha: run.prompt_sha,
    host: run.host,
    model: usage?.model ?? run.model,
    tokens: usage?.tokens ?? null,
    cost_usd: usage?.cost_usd ?? null,
    data: {
      action_id: run.action_id,
      exit: result.exit,
      verdicts: result.verdicts.map((v) => ({ subject: v.subject, verdict: v.verdict })),
      findings: result.findings.length,
      questions: result.questions.length,
      artifacts: [...(extras.artifacts ?? result.artifacts)],
      session_ref: null,
      ...(extras.head === undefined ? {} : { head: extras.head }),
    },
  });
};

const phaseEscalation = (
  k: Kernel,
  h: RunHandle,
  question: Question,
  reason: "blocked" | "spec_conflict" | "spec_question",
  phase: Phase,
  raisedBy: string,
): void => {
  const escalation = escalationFromQuestion(question, {
    id: nextEscalationId(h.state),
    run: h.state.id,
    reason,
    phase,
    created_at: k.now().toISOString(),
    raised_by: raisedBy,
  });
  k.emit(h, { type: "escalation.opened", actor: "engine", data: { escalation } });
};

/** Spec questions go to the escalation queue, never inline (§6.3 step 2). */
const openQuestions = (k: Kernel, h: RunHandle, run: RoleRunRecord, result: RoleResult): void => {
  for (const question of result.questions) {
    if (run.task !== undefined) {
      openTaskEscalation(k, h, run.task, {
        reason: "spec_question",
        detail: "",
        evidence: [],
        question,
        raisedBy: run.role,
      });
    } else {
      phaseEscalation(k, h, question, "spec_question", h.state.run.phase, run.role);
    }
  }
};

// ------------------------------------------------------------- front half

/** Engine fields for the Planner's drafts (AD-8 rules 5 and 11); ids renumbered past used ones. */
const planTasks = (
  k: Kernel,
  h: RunHandle,
  drafts: readonly TaskDraft[],
): { tasks: { task: Task; draft: TaskDraft }[] } | { issues: string[] } => {
  const issues = checkPlan({
    drafts,
    requirements: specRequirementIds(frozenSpecItems(k.deps.repoRoot, h.state)),
  });
  if (issues.length > 0) return { issues };
  const states = [...k.allStates()];
  const taken = usedTaskIds(states);
  const remap = new Map<string, string>();
  for (const d of drafts) {
    const id = taken.has(d.id) ? nextNumberedId("T", taken) : d.id;
    remap.set(d.id, id);
    taken.add(id);
  }
  const featureId = nextNumberedId("F", usedFeatureIds(states));
  const config = k.config();
  return {
    tasks: drafts.map((draft) => {
      const { intent: _intent, ...rest } = draft;
      const task: Task = {
        ...rest,
        id: remap.get(draft.id) ?? draft.id,
        after: draft.after.map((a) => remap.get(a) ?? a),
        consumes_contracts: draft.consumes_contracts.map((c) => ({
          ...c,
          provider: remap.get(c.provider) ?? c.provider,
        })),
        feature: featureId,
        origin: "planner",
        cap: capForRisk(draft.risk, config.caps),
        budget_usd: taskBudgetFor(draft.size, config),
        spent_usd: 0,
        status: "draft",
        round: 0,
        deferred: [],
      };
      return { task, draft };
    }),
  };
};

/** PLAN (§6.1, AD-8 rule 11): the tasks, then the run's one feature, then BUILD. */
const createPlan = (
  k: Kernel,
  h: RunHandle,
  tasks: readonly { task: Task; draft: TaskDraft }[],
): void => {
  const first = tasks[0];
  if (first === undefined) return;
  const featureId = first.task.feature;
  for (const { task, draft } of tasks) {
    k.emit(h, {
      type: "task.created",
      actor: "engine",
      task: task.id,
      data: { task, intent: draft.intent },
    });
  }
  const budget = usd(tasks.reduce((s, t) => s + t.task.budget_usd, 0));
  const title = (h.state.request.split("\n").find((l) => l.trim() !== "") ?? featureId)
    .trim()
    .slice(0, 200);
  k.emit(h, {
    type: "feature.created",
    actor: "engine",
    feature: featureId,
    data: {
      feature: {
        id: featureId,
        title,
        status: "building",
        tasks: tasks.map((t) => t.task.id),
        integration_branch: `vtc/${featureId}`,
        round: 0,
        budget_usd: budget,
        final_review_budget_usd: usd(budget * k.config().budgets.final_review_share),
        spent_usd: 0,
      },
    },
  });
  k.emit(h, {
    type: "run.phase_changed",
    actor: "engine",
    data: { from: h.state.run.phase, to: "build" },
  });
};

const acceptPhaseRole = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  result: RoleResult,
): Promise<StepOutcome> => {
  const contract = k.deps.roles.get(run.role);
  const writePaths = writePathsOf(k, run);
  const issues: string[] = [];
  const artifacts: ArtifactRef[] = [];
  for (const artifact of result.artifacts) {
    if (!matchesAny(writePaths, artifact.path))
      issues.push(`${artifact.path} is outside the role's write paths`);
    const sha = fileSha(k.deps.repoRoot, artifact.path);
    if (sha === undefined) issues.push(`${artifact.path} does not exist`);
    else artifacts.push({ ...artifact, sha256: sha });
  }
  if (issues.length > 0) return reject("write_scope", issues);
  const missing = await unresolved(evidenceContext(k, h, null), [
    ...result.claims,
    ...result.verdicts.flatMap((v) => v.evidence),
  ]);
  if (missing.length > 0)
    return reject(
      "claim_check",
      missing.map((m) => `does not resolve: ${m}`),
    );
  const declared = contract?.output.artifacts ?? [];
  if (
    result.exit === "done" &&
    run.role !== "planner" &&
    declared.length > 0 &&
    artifacts.length === 0
  ) {
    return reject("claim_check", [`a done result returns its ${declared.join("/")} artifact`]);
  }
  const phase = PHASE_OF_ROLE[run.role] ?? h.state.run.phase;
  if (run.role === "planner" && result.exit === "done") {
    if (result.tasks === undefined) return reject("claim_check", ["the Planner returns its tasks"]);
    const planned = planTasks(k, h, result.tasks);
    if ("issues" in planned) return reject("claim_check", planned.issues);
    return {
      kind: "accept",
      artifacts,
      after: () => {
        createPlan(k, h, planned.tasks);
      },
    };
  }
  return {
    kind: "accept",
    artifacts,
    after: () => {
      openQuestions(k, h, run, result);
      if (result.exit === "blocked")
        phaseEscalation(k, h, result.question, "blocked", phase, run.role);
      if (result.exit === "spec_conflict") {
        phaseEscalation(
          k,
          h,
          {
            question: `${run.role} found a conflict in the spec: ${result.conflict.detail}`.slice(
              0,
              1000,
            ),
            options: [
              {
                id: "clarify",
                label: "Answer with a clarification and continue",
                effect: "clarify",
              },
              { id: "hint", label: "Give a hint and continue", effect: "hint" },
            ],
            recommended: "clarify",
            evidence: result.conflict.req_ids.map((ref) => ({ type: "spec_ref" as const, ref })),
          },
          "spec_conflict",
          phase,
          run.role,
        );
      }
    },
  };
};

// -------------------------------------------------------------- task roles

const qaWriteScope = (k: Kernel, taskId: string): string[] => [
  ...(k.gatesConfig()?.tests.acceptance_globs ?? DEFAULT_ACCEPTANCE_GLOBS),
  `${HIDDEN_TESTS.stagingDir}/${taskId}/**`,
];

const acceptQaAuthor = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  task: Task,
  result: RoleResult,
): Promise<StepOutcome> => {
  if (task.worktree === undefined || task.baseline_revision === undefined) {
    return reject("out_of_order", ["the task has no workspace yet"]);
  }
  const authoring = task.status === "ready";
  if (authoring && result.exit === "done" && result.acceptance_tests === undefined) {
    return reject("claim_check", [
      "QA author mode names its new acceptance tests (acceptance_tests)",
    ]);
  }
  const head = await k.deps.workspace.snapshot(
    task.worktree,
    `vtc: ${task.id} acceptance tests (${run.action_id})`,
  );
  const scope = await k.deps.gateRunner.checkWriteScope({
    worktree: task.worktree,
    base: task.baseline_revision,
    head,
    filesScope: qaWriteScope(k, task.id),
    protected: [],
  });
  if (!scope.ok)
    return reject(
      "write_scope",
      scope.violations.map((v) => `${v.kind}: ${v.path}`),
    );
  const missing: string[] = [];
  for (const artifact of result.artifacts) {
    const exists =
      artifact.type === HIDDEN_TESTS.artifactType
        ? artifact.path.startsWith(`${HIDDEN_TESTS.stagingDir}/${task.id}/`) &&
          existsSync(join(k.deps.repoRoot, artifact.path))
        : (await k.deps.git.readFileAtCommit(head, artifact.path)) !== undefined;
    if (!exists) missing.push(`${artifact.path} is not in the submitted work`);
  }
  if (missing.length > 0) return reject("claim_check", missing);
  return {
    kind: "accept",
    head,
    after: () => {
      openQuestions(k, h, run, result);
      if (result.exit !== "done") return;
      if (authoring) {
        startBaseCheck(k, h, task.id, head, result.acceptance_tests ?? []);
        return;
      }
      for (const f of taskFindings(h.state, task.id)) {
        if (f.status !== "open" || f.route !== "bad_test") continue;
        k.emit(h, {
          type: "finding.status_changed",
          actor: "engine",
          task: task.id,
          data: { fingerprint: f.fingerprint, from: "open", to: "resolved" },
        });
      }
    },
  };
};

type Fault = Extract<RoleResult, { exit: "out_of_scope_fault" }>["fault"];

/** The guards of an `out_of_scope_fault` claim (§6.3 step 3); empty when they all pass. */
const outOfScopeGuards = async (
  k: Kernel,
  h: RunHandle,
  task: Task,
  fault: Fault,
): Promise<string[]> => {
  if (matchesAny(task.files_scope, fault.path))
    return [`${fault.path} is inside the task's files_scope`];
  const claimed = [...h.state.findings.values()].some(
    (r) =>
      r.finding.task === task.id &&
      r.finding.route === "out_of_scope" &&
      r.finding.round_first_seen === task.round,
  );
  const rejectedClaims = h.state.events.filter(
    (e) =>
      e.task === task.id &&
      e.type === "role.rejected" &&
      (e.data as { issues?: string[] }).issues?.some((i) => i.includes("(out_of_scope claim)")) ===
        true &&
      e.seq >
        (h.state.events.findLast((x) => x.task === task.id && x.type === "task.status_changed")
          ?.seq ?? 0),
  );
  if (claimed || rejectedClaims.length > 0)
    return ["at most one out_of_scope_fault claim per round (out_of_scope claim)"];
  const base = task.baseline_revision;
  if (base === undefined) return ["the task has no baseline"];
  if (!(await resolves(evidenceContext(k, h, base), fault.evidence))) {
    return [
      `the fault's evidence does not resolve on the base (out_of_scope claim): ${fault.evidence.type} ${fault.evidence.ref}`,
    ];
  }
  const checkout = await k.deps.git.createCleanCheckout(base);
  try {
    const report = await k.deps.gateRunner.run({
      run: h.state.id,
      task: task.id,
      reason: "fault_repro",
      scope: "affected",
      base,
      head: base,
      checkout,
      files_scope: [],
      protected: [],
      req_tags: task.covers,
      expect: "pass",
      include_hidden: false,
    });
    adoptGateOutput(k, report);
    k.emit(h, { type: "gate.result", actor: "engine", task: task.id, data: report });
    if (report.verdict === "infra_error")
      return ["the fault could not be reproduced: the gates failed to run (out_of_scope claim)"];
    return report.verdict === "fail"
      ? []
      : ["the fault does not reproduce on the base without this task's diff (out_of_scope claim)"];
  } finally {
    await k.deps.git.removeCheckout(checkout);
  }
};

/** Statuses in which a task's Engineer still runs, so it can take an out-of-scope fault. */
const FAULT_OWNER_STATUSES: readonly string[] = [
  "draft",
  "waiting_dependency",
  "ready",
  "tests_authored",
  "building",
  "fixing",
];

/**
 * A guarded fault goes to its owning task (one whose Engineer still runs: the finding is in its
 * next pack) or to a new out-of-scope task; the round ends early.
 */
const routeOutOfScope = (k: Kernel, h: RunHandle, task: Task, fault: Fault): void => {
  const owner = [...h.state.tasks.values()].find(
    (t) =>
      t.id !== task.id &&
      FAULT_OWNER_STATUSES.includes(t.status) &&
      matchesAny(t.files_scope, fault.path),
  );
  const base = findingFromDraft(
    {
      rule_id: "out_of_scope_fault",
      category: "correctness",
      kind: "implementation_deviation",
      title: `Fault outside ${task.id}: ${fault.path}:${String(fault.line)}`.slice(0, 200),
      message: fault.detail,
      confidence: 1,
      location: { path: fault.path, line: fault.line },
      evidence: fault.evidence,
      req_ids: [],
    },
    "engineer",
    { task: task.id, round: Math.max(1, task.round) },
  );
  const finding: Finding = {
    ...base,
    route: "out_of_scope",
    ...(owner === undefined ? {} : { owner_task: owner.id }),
  };
  k.emit(h, { type: "finding.recorded", actor: "engine", task: task.id, data: { finding } });
  if (owner === undefined) {
    const config = k.config();
    const id = nextNumberedId("T", usedTaskIds(k.allStates()));
    const scope = fault.path.includes("/")
      ? `${fault.path.slice(0, fault.path.lastIndexOf("/"))}/**`
      : fault.path;
    const created: Task = {
      id,
      title: `Out-of-scope fault: ${fault.path}`.slice(0, 200),
      feature: task.feature,
      origin: "out_of_scope",
      source_finding: finding.fingerprint,
      covers: [],
      after: [],
      files_scope: [scope],
      discipline: task.discipline,
      stack_packs: [],
      consumes_contracts: [],
      risk: "med",
      risk_tags: [],
      cap: capForRisk("med", config.caps),
      size: "S",
      arch_triage: "fits",
      budget_usd: taskBudgetFor("S", config),
      spent_usd: 0,
      status: "draft",
      round: 0,
      deferred: [],
    };
    k.emit(h, { type: "task.created", actor: "engine", task: id, data: { task: created } });
    k.emit(h, {
      type: "feature.task_added",
      actor: "engine",
      feature: task.feature,
      data: { task: id },
    });
  }
  // The round ends early and does not count as stuck (§6.3 step 3).
  const current = h.state.tasks.get(task.id);
  if (current === undefined) return;
  if (current.round + 1 > current.cap) {
    parkTask(k, h, task.id, {
      reason: "cap",
      detail: "round cap reached after an out-of-scope fault",
      evidence: [fault.evidence],
    });
  } else {
    setTaskStatus(k, h, task.id, "fixing", { round: current.round + 1 });
  }
};

const acceptEngineer = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  task: Task,
  result: RoleResult,
): Promise<StepOutcome> => {
  if (task.worktree === undefined || task.baseline_revision === undefined) {
    return reject("out_of_order", ["the task has no workspace yet"]);
  }
  if (result.exit === "out_of_scope_fault") {
    const issues = await outOfScopeGuards(k, h, task, result.fault);
    if (issues.length > 0) return reject("claim_check", issues);
    return {
      kind: "accept",
      after: () => {
        routeOutOfScope(k, h, task, result.fault);
      },
    };
  }
  if (result.exit === "blocked") {
    return {
      kind: "accept",
      after: () => {
        parkTask(k, h, task.id, {
          reason: "blocked",
          detail: result.summary.slice(0, 2000),
          evidence: result.question.evidence,
          question: result.question,
          raisedBy: run.role,
        });
      },
    };
  }
  if (result.exit === "spec_conflict") {
    // Goes to the BA (§6.3 step 3) as a spec gap of this task; the human only after it.
    return {
      kind: "accept",
      after: () => {
        const evidence = result.conflict.req_ids.map((ref) => ({ type: "spec_ref" as const, ref }));
        if (clarifications(h.state, task.id) >= MAX_CLARIFICATIONS) {
          parkTask(k, h, task.id, {
            reason: "spec_conflict",
            detail: result.conflict.detail,
            evidence,
            raisedBy: run.role,
          });
          return;
        }
        const spec = frozenFor(h.state, "ba")[0];
        const finding = findingFromDraft(
          {
            rule_id: "spec_conflict",
            category: "correctness",
            kind: "spec_ambiguity",
            title: `Spec conflict: ${result.conflict.req_ids.join(", ")}`.slice(0, 200),
            message: result.conflict.detail,
            confidence: 1,
            location: { path: spec?.path ?? ".vtc/spec/spec.md" },
            evidence: evidence[0] ?? { type: "file", ref: spec?.path ?? ".vtc/spec/spec.md" },
            req_ids: result.conflict.req_ids,
            snippet: result.conflict.detail,
          },
          run.role,
          { task: task.id, round: Math.max(1, task.round) },
        );
        k.emit(h, { type: "finding.recorded", actor: "engine", task: task.id, data: { finding } });
      },
    };
  }
  const previous = lastBuilt(h.state, task.id)?.head;
  const head = await k.deps.workspace.snapshot(
    task.worktree,
    `vtc: ${task.id} round ${String(task.round)} (${run.action_id})`,
  );
  const scope = await k.deps.gateRunner.checkWriteScope({
    worktree: task.worktree,
    base: task.baseline_revision,
    head,
    filesScope: task.files_scope,
    protected: await protectedFiles(k, h, task),
  });
  if (!scope.ok) {
    return {
      kind: "reject",
      rejection: rejection(
        "write_scope",
        scope.violations.map((v) => `${v.kind}: ${v.path}`),
      ),
      findings: findingsFromWriteScope(scope, { task: task.id, round: Math.max(1, task.round) }),
    };
  }
  const missing = await unresolved(evidenceContext(k, h, head), result.claims);
  if (missing.length > 0)
    return reject(
      "claim_check",
      missing.map((m) => `does not resolve: ${m}`),
    );
  const identical =
    previous !== undefined &&
    (await k.deps.workspace.treeOf(previous)) === (await k.deps.workspace.treeOf(head));
  let contractSha: string | undefined;
  if (task.provides_contract !== undefined && !h.state.contracts.has(task.id)) {
    const bytes = await k.deps.git.readFileAtCommit(head, task.provides_contract.path);
    if (bytes !== undefined) contractSha = createHash("sha256").update(bytes).digest("hex");
  }
  return {
    kind: "accept",
    head,
    after: () => {
      if (identical && task.round > 1) {
        // Stuck (§6.3 step 9): the same tree as the failed round; re-running the gates cannot help.
        parkTask(k, h, task.id, {
          reason: "stuck",
          detail: "the Engineer submitted an identical diff",
          evidence: [{ type: "commit", ref: head }],
        });
        return;
      }
      k.identicalTree.set(task.id, identical);
      if (contractSha !== undefined && task.provides_contract !== undefined) {
        k.emit(h, {
          type: "contract.frozen",
          actor: "engine",
          task: task.id,
          data: { path: task.provides_contract.path, sha256: contractSha },
        });
      }
      setTaskStatus(k, h, task.id, "verifying");
      startRoundGates(k, h, task.id, head);
    },
  };
};

/**
 * A BA or Designer answering a task's gap (§6.3 steps 3 and 8; `clarify.ts`): a wording-only
 * spec fix is `spec.clarified`, a change in meaning a change request, `blocked` a question for
 * the human; then the task's Engineer continues.
 */
const acceptClarifier = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  role: "ba" | "designer",
  task: Task,
  result: RoleResult,
): Promise<StepOutcome> => {
  const writePaths = writePathsOf(k, run);
  const issues: string[] = [];
  const artifacts: ArtifactRef[] = [];
  for (const artifact of result.artifacts) {
    if (!matchesAny(writePaths, artifact.path))
      issues.push(`${artifact.path} is outside the role's write paths`);
    const sha = fileSha(k.deps.repoRoot, artifact.path);
    if (sha === undefined) issues.push(`${artifact.path} does not exist`);
    else artifacts.push({ ...artifact, sha256: sha });
  }
  if (issues.length > 0) return reject("write_scope", issues);
  const missing = await unresolved(evidenceContext(k, h, null), result.claims);
  if (missing.length > 0)
    return reject(
      "claim_check",
      missing.map((m) => `does not resolve: ${m}`),
    );
  const frozen = frozenFor(h.state, role);
  const changed = frozen.flatMap((f) => {
    const sha = fileSha(k.deps.repoRoot, f.path);
    return sha === f.sha256 ? [] : [{ frozen: f, sha }];
  });
  const route = role === "ba" ? "spec_gap" : "design_gap";
  const gaps = taskFindings(h.state, task.id).filter(
    (f) => f.status === "open" && f.route === route,
  );
  const detail = [result.summary, ...gaps.map((f) => `${f.route}: ${f.title}`)]
    .join("; ")
    .slice(0, 2000);
  const artifact = role === "ba" ? "spec" : "design";
  let meaning = result.exit === "spec_conflict";
  if (result.exit === "done" && changed.length > 0) {
    if (role === "designer") meaning = true;
    else {
      // Wording only: the same requirement and acceptance-criterion ids as at dispatch.
      const before = k.checkouts.get(run.action_id)?.spec_ids;
      const now = frozenSpecItems(k.deps.repoRoot, h.state).map((i) => i.id);
      meaning =
        before === undefined ||
        before.length !== now.length ||
        [...before].sort().join("\n") !== [...now].sort().join("\n");
    }
  }
  return {
    kind: "accept",
    artifacts,
    after: () => {
      if (result.exit === "blocked") {
        parkTask(k, h, task.id, {
          reason: "blocked",
          detail: result.summary.slice(0, 2000),
          evidence: result.question.evidence,
          question: result.question,
          raisedBy: role,
        });
        return;
      }
      if (meaning) {
        const target = changed[0]?.frozen ?? frozen[0];
        if (target !== undefined) {
          openChangeRequest(k, h, task.id, {
            artifact,
            frozen: target,
            summary: result.summary,
            detail,
            raisedBy: role,
          });
          return;
        }
      }
      if (meaning || result.exit !== "done") {
        // nothing frozen to change, or no answer: the human decides
        parkTask(k, h, task.id, {
          reason: "spec_conflict",
          detail,
          evidence: gaps.slice(0, 5).map((f) => f.evidence),
          raisedBy: role,
        });
        return;
      }
      for (const c of changed) {
        if (c.sha === undefined) continue;
        k.emit(h, {
          type: "spec.clarified",
          actor: "engine",
          task: task.id,
          data: {
            path: c.frozen.path,
            old_sha256: c.frozen.sha256,
            new_sha256: c.sha,
            summary: (result.summary.trim() || "wording clarified").slice(0, 300),
          },
        });
      }
      resolveGaps(k, h, task.id, [route]);
    },
  };
};

const acceptReviewer = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  task: Task,
  result: RoleResult,
): Promise<StepOutcome> => {
  const built = lastBuilt(h.state, task.id);
  if (task.worktree === undefined || built?.head === undefined)
    return reject("out_of_order", ["no built head to review"]);
  // Read-only: no uncommitted change, and the branch still at the head the gates verified (a
  // reviewer's own commit would otherwise reach the merge queue unreviewed, AD-8 rules 4 and 14).
  const dirty = await k.deps.workspace.isDirty(task.worktree);
  const tip = await k.deps.workspace.resolve(task.branch ?? `vtc/${task.id}`);
  if (dirty || tip !== built.head) {
    await k.deps.workspace.discard(task.worktree, built.head);
    return reject("write_scope", [
      dirty
        ? "a read-only reviewer changed files in the task worktree (discarded)"
        : `a read-only reviewer moved the task branch to ${tip.slice(0, 12)} (reset to the built head)`,
    ]);
  }
  const missing = await unresolved(evidenceContext(k, h, built.head), [
    ...result.claims,
    ...result.verdicts.flatMap((v) => v.evidence),
  ]);
  if (missing.length > 0) {
    return reject(
      "claim_check",
      missing.map((m) => `does not resolve: ${m}`),
    );
  }
  return {
    kind: "accept",
    after: () => {
      openQuestions(k, h, run, result);
      if (completedReviews(k, h, task.id) !== null) startTriage(k, h, task.id);
    },
  };
};

/** Is the result arriving where the flow expects it (§4.2 step 4)? `null` when it is. */
const outOfOrder = (h: RunHandle, run: RoleRunRecord, task: Task | undefined): string | null => {
  if (h.state.run.finished_at !== undefined) return "the run has finished";
  if (run.task === undefined) {
    const phase = PHASE_OF_ROLE[run.role];
    return phase !== undefined && h.state.run.phase !== phase
      ? `the run is in ${h.state.run.phase}, not ${phase}`
      : null;
  }
  if (task === undefined) return `no task ${run.task}`;
  const expected: readonly string[] =
    run.role === "engineer"
      ? ["building", "fixing"]
      : isClarifier(run.role)
        ? ["tests_authored", "building", "fixing"]
        : run.role === "qa" && run.mode === "author"
          ? ["ready", "fixing"]
          : ["verifying"];
  return expected.includes(task.status) ? null : `task ${task.id} is ${task.status}`;
};

/** A subagent that hit a limit, lost auth or crashed (§6.9, AD-4 rule 5). */
const handleFailure = (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  outcome: HostFailureOutcome,
): void => {
  if (outcome.kind === "limit") {
    recordLimit(k, h, run, outcome);
    recordSpend(k, h, run, outcome.cost_usd);
    return;
  }
  k.emit(h, {
    type: "role.failed",
    actor: "engine",
    role: run.role,
    ...(run.task === undefined ? {} : { task: run.task }),
    data: {
      action_id: run.action_id,
      kind: outcome.kind,
      message: outcome.message.slice(0, 2000),
      retryable: outcome.kind === "error" ? outcome.retryable : false,
    },
  });
  if (outcome.kind === "auth") {
    // The user must sign in again; VTC never touches credentials (AD-9).
    k.emit(h, {
      type: "run.paused",
      actor: "engine",
      data: { reason: "the host lost its sign-in; sign in again and resume" },
    });
    return;
  }
  recordSpend(k, h, run, outcome.cost_usd);
  stepFailed(k, h, run);
};

/** Handles a `submit`. Callers run it inside the run's lock. */
export const handleSubmit = async (
  k: Kernel,
  h: RunHandle,
  input: SubmitInput,
): Promise<SubmitOutcome> => {
  const run = h.state.roleRuns.get(input.action_id);
  if (run === undefined) {
    return {
      accepted: false,
      rejection: rejection("unknown_action", [`no dispatched action ${input.action_id}`]),
    };
  }
  if (run.status === "submitted") {
    return {
      accepted: false,
      rejection: rejection("duplicate", [`action ${input.action_id} was already submitted`]),
    };
  }
  if (run.status !== "in_flight") {
    return {
      accepted: false,
      rejection: rejection("stale_action", [`action ${input.action_id} is ${run.status}`]),
    };
  }
  // A role that worked in the user's checkout: every write is checked before anything else, for
  // a result and a failure alike (AD-7 rule 7); the record goes only once checked.
  const writes: WriteFindings | null = runsInCheckout(run.role)
    ? await checkRunWrites(k, h, run)
    : null;
  if (input.kind === "failure") {
    handleFailure(k, h, run, input.outcome);
    if (writes !== null) {
      reportWrites(k, h, run, writes);
      dropCheckoutRecord(k.deps.repoRoot, k.checkouts, run.action_id);
      // a limit interrupts every run in flight: theirs are checked now too
      await sweepCheckouts(k, h);
    }
    return { accepted: true };
  }
  const outcome: StepOutcome =
    writes !== null && writes.issues.length > 0
      ? reject("write_scope", writes.issues)
      : await evaluate(k, h, run, input.result);
  if (outcome.kind === "reject") logRejection(k, h, run, outcome.rejection);
  if (writes !== null) {
    // nothing is re-dispatched over writes no one has looked at: the human resumes
    reportWrites(k, h, run, writes);
    dropCheckoutRecord(k.deps.repoRoot, k.checkouts, run.action_id);
    if (writes.issues.length > 0)
      return { accepted: false, rejection: rejection("write_scope", writes.issues) };
  }
  if (outcome.kind === "reject") {
    const task = run.task;
    if (outcome.findings !== undefined && task !== undefined) {
      settleRound(
        k,
        h,
        task,
        recordRoundFindings(k, h, task, outcome.findings, new Set(["write_scope"])),
      );
    } else {
      stepFailed(k, h, run);
    }
    return { accepted: false, rejection: outcome.rejection };
  }
  saveResult(k.deps.repoRoot, run.action_id, input.result);
  emitSubmitted(k, h, run, input.result, input.usage, {
    ...(outcome.head === undefined ? {} : { head: outcome.head }),
    ...(outcome.artifacts === undefined ? {} : { artifacts: outcome.artifacts }),
  });
  recordSpend(k, h, run, input.usage?.cost_usd ?? null);
  await outcome.after();
  checkBudget(k, h, run.task);
  return { accepted: true };
};

const evaluate = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  result: RoleResult,
): Promise<StepOutcome> => {
  const contract = k.deps.roles.get(run.role);
  if (contract === undefined)
    return reject("dispatch_mismatch", [`no contract for role ${run.role}`]);
  const effective = resolveRoleMode(contract, run.mode);
  if (!effective.ok) return reject("undeclared_mode", [effective.error]);
  const conformance = checkResultAgainstContract(result, effective.contract, {
    role: run.role,
    mode: run.mode,
    task: run.task,
    feature: run.task === undefined ? run.feature : undefined,
    subject: run.subject,
  });
  if (!conformance.ok) return reject(conformance.reason, conformance.issues);
  const task = run.task === undefined ? undefined : h.state.tasks.get(run.task);
  const order = outOfOrder(h, run, task);
  if (order !== null) return reject("out_of_order", [order]);
  if (task === undefined) return acceptPhaseRole(k, h, run, result);
  if (run.role === "engineer") return acceptEngineer(k, h, run, task, result);
  if (isClarifier(run.role)) return acceptClarifier(k, h, run, run.role, task, result);
  if (run.role === "qa" && run.mode === "author") return acceptQaAuthor(k, h, run, task, result);
  if (isReviewer(run)) return acceptReviewer(k, h, run, task, result);
  return reject("dispatch_mismatch", [`role ${run.role} has no task step`]);
};
