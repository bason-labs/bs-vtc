/**
 * `submit` (§4.2 step 3; AD-4 rule 1, AD-8 rules 2, 9 and 14): a role result is accepted only for
 * an open action the engine dispatched, after conformance to the role contract, an order check,
 * the submit snapshot commit, the write-scope check and the claim checks. Anything else is
 * rejected with a `RejectReason`; a rejection changes nothing but the log (and, for an
 * Engineer's write-scope violation, records the test-integrity hit, §6.3 step 4).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  capForRisk,
  checkResultAgainstContract,
  escalationFromQuestion,
  HIDDEN_TESTS,
  redactSecrets,
  resolveRoleMode,
  type ArtifactRef,
  type Finding,
  type HostFailureOutcome,
  type Phase,
  type Question,
  type RejectReason,
  type RoleResult,
  type RunUsage,
  type SessionRef,
  type SubmitInput,
  type Task,
  type TaskDraft,
} from "@vtc/shared";
import { budgetState, sharesExceeded, taskBudgetFor, usd } from "./budget.js";
import { DEFAULT_ACCEPTANCE_GLOBS } from "./config.js";
import { resolves, unresolved } from "./evidence.js";
import { matchesAny } from "./globs.js";
import {
  adoptGateOutput,
  baselineGates,
  emitGateResult,
  recordUnsandboxedGate,
  protectedFiles,
  startBaseCheck,
  startRoundGates,
} from "./jobs.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { parkEscalation } from "./escalations.js";
import { featureReviewDone } from "./final-review.js";
import { recordLimit } from "./limits.js";
import { openTaskEscalation, parkTask, setTaskStatus } from "./parking.js";
import {
  checkRun,
  dropDispatch,
  recordKey,
  removeRoleWorktree,
  reportFindings,
  sweepDispatches,
} from "./dispatch-guard.js";
import { checkPlan, isVtcScopeEntry } from "./plan-check.js";
import {
  collectRoleChanges,
  mergeRoleChanges,
  roleScopeIssues,
  touched,
  type RoleChanges,
} from "./role-worktree.js";
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
import { writePathsOf } from "./roles.js";
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
      /** Keep the role's worktree for the human (its changes could not be merged back). */
      readonly keepWorktree?: true;
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
  // Security's design mode (its verify mode always has a task, §6.1)
  security: "design",
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

const bytesSha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------- bookkeeping

/**
 * Records the spend of a run (§11): task, feature and run budgets. The cost is the one the host
 * reported, kept also when it names no model or one VTC has no price for (a run on the session's
 * model, D-ae; D-at, spine §5 reading 77): the host computed it, so it does not depend on VTC
 * knowing the model id, and being conservative about budget beats being precise about price.
 * Only a run with no reported cost (`null`) counts 0, and it is flagged unpriced.
 */
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
  // The run's spend as shown counts every role run, the front half's included (views.ts
  // `runBudget` sums the role runs); this event carries the features' budget once there is one.
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

/**
 * The task worktree a run writes in (the Engineer, QA author) and its branch head before the
 * result is looked at, or `null` for a run that does not work there.
 */
const taskWorktreeHead = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
): Promise<{ readonly worktree: string; readonly head: string } | null> => {
  if (run.task === undefined) return null;
  if (run.role !== "engineer" && !(run.role === "qa" && run.mode === "author")) return null;
  const task = h.state.tasks.get(run.task);
  if (task?.worktree === undefined) return null;
  try {
    return { worktree: task.worktree, head: await k.deps.workspace.resolve(`vtc/${task.id}`) };
  } catch {
    return null;
  }
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
      stuckRole: run.role,
    });
  }
};

/**
 * Records a rejection with what the run cost (§11, AD-7 rule 11: every AI call is traceable): a
 * rejected result was still paid for, so its host-reported usage is on the event and its cost
 * is charged to the task, feature and run budgets like any other run.
 */
const logRejection = (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  value: Rejection,
  usage: RunUsage | undefined,
): void => {
  k.emit(h, {
    type: "role.rejected",
    actor: "engine",
    role: run.role,
    ...(run.task === undefined ? {} : { task: run.task }),
    ...(usage === undefined
      ? {}
      : {
          model: usage.model ?? run.model,
          tokens: usage.tokens ?? null,
          cost_usd: usage.cost_usd ?? null,
        }),
    data: { action_id: run.action_id, reason: value.reason, issues: value.issues },
  });
  recordSpend(k, h, run, usage?.cost_usd ?? null);
};

const emitSubmitted = (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  result: RoleResult,
  usage: RunUsage | undefined,
  extras: {
    readonly head?: string;
    readonly artifacts?: readonly ArtifactRef[];
    readonly session?: SessionRef;
  },
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
      session_ref: extras.session ?? null,
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
const planTasks = async (
  k: Kernel,
  h: RunHandle,
  drafts: readonly TaskDraft[],
): Promise<{ tasks: { task: Task; draft: TaskDraft }[] } | { issues: string[] }> => {
  const issues = checkPlan({
    drafts,
    requirements: specRequirementIds(frozenSpecItems(k.deps.repoRoot, h.state)),
  });
  if (issues.length > 0) return { issues };
  const states = [...k.allStates()];
  // ids a teammate's clone already used, as far as this clone's git shows (reading 89)
  const shared = await k.deps.workspace
    .sharedIds()
    .catch(() => ({ tasks: [] as readonly string[], features: [] as readonly string[] }));
  for (const id of shared.tasks) k.sharedTaskIds.add(id);
  const taken = new Set([...usedTaskIds(states), ...k.sharedTaskIds]);
  const remap = new Map<string, string>();
  for (const d of drafts) {
    const id = taken.has(d.id) ? nextNumberedId("T", taken) : d.id;
    remap.set(d.id, id);
    taken.add(id);
  }
  const featureId = nextNumberedId("F", new Set([...usedFeatureIds(states), ...shared.features]));
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

/**
 * A front-half role or an advisor, from its own worktree (spine §5 reading 21): every change is
 * checked against the role's write paths, the artifacts it names must be in its work, its claims
 * must resolve there, and only then are its changes copied into the user's checkout (never over
 * a file the user changed meanwhile).
 */
/**
 * AD-18 rule 1 for what roles write into git-tracked `.vtc/` (repo map, briefs, spec,
 * architecture, threat model, design, exports): every text file the role changed is checked with
 * `redactSecrets` before it is copied into the user's checkout (spine §5 reading 87). Anything it
 * would redact rejects the result: rewriting the file silently would change the artifact's
 * sha256 and the hashes gates freeze. The issue names the path and the kind, never the value.
 */
const secretIssues = async (k: Kernel, work: RoleChanges): Promise<string[]> => {
  const issues: string[] = [];
  const known = k.secrets();
  for (const path of [...new Set(work.changes.flatMap(touched))]) {
    const bytes = await k.deps.git.readFileAtCommit(work.head, path);
    if (bytes === undefined || bytes.includes(0)) continue;
    const text = Buffer.from(bytes).toString("utf8");
    const redacted = redactSecrets(text, known);
    if (redacted === text) continue;
    const kinds = [...new Set([...redacted.matchAll(/\[REDACTED:([a-z_]+)\]/g)].map((m) => m[1]))];
    issues.push(
      `${path} holds what looks like a secret (${kinds.join(", ")}); remove it, refer to it by name instead`,
    );
  }
  return issues;
};

const acceptIsolatedRole = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  result: RoleResult,
): Promise<{ outcome: StepOutcome } | { artifacts: ArtifactRef[] }> => {
  const worktree = k.dispatches.get(recordKey(h.state.id, run.action_id))?.worktree;
  if (worktree === undefined)
    return {
      outcome: reject("write_scope", [
        "the engine has no record of the role's worktree, so its work cannot be verified",
      ]),
    };
  const work = await collectRoleChanges(k, worktree, `vtc: ${run.role} (${run.action_id})`);
  const writePaths = writePathsOf(k.deps.roles, run);
  const issues = roleScopeIssues(work.changes, writePaths);
  const artifacts: ArtifactRef[] = [];
  for (const artifact of result.artifacts) {
    if (!matchesAny(writePaths, artifact.path))
      issues.push(`${artifact.path} is outside the role's write paths`);
    const bytes = await k.deps.git.readFileAtCommit(work.head, artifact.path);
    if (bytes === undefined) issues.push(`${artifact.path} does not exist`);
    else artifacts.push({ ...artifact, sha256: bytesSha(bytes) });
  }
  if (issues.length > 0) return { outcome: reject("write_scope", issues) };
  const secrets = await secretIssues(k, work);
  if (secrets.length > 0) return { outcome: reject("write_scope", secrets) };
  const missing = await unresolved(
    { ...evidenceContext(k, h, null), repoRoot: join(k.deps.repoRoot, worktree.path) },
    [...result.claims, ...result.verdicts.flatMap((v) => v.evidence)],
  );
  if (missing.length > 0)
    return {
      outcome: reject(
        "claim_check",
        missing.map((m) => `does not resolve: ${m}`),
      ),
    };
  const merged = await mergeRoleChanges(k, worktree, work);
  if (merged.conflicts.length > 0) {
    k.emit(h, {
      type: "run.paused",
      actor: "engine",
      data: {
        reason:
          `${run.role} (${run.action_id}) changed files you edited meanwhile (${merged.conflicts.slice(0, 3).join(", ")}); its work is kept on vtc/${worktree.path.split("/").at(-1) ?? ""}. Reconcile, then vtc resume`.slice(
            0,
            300,
          ),
      },
    });
    return {
      outcome: {
        kind: "reject",
        rejection: rejection(
          "out_of_order",
          merged.conflicts.map((p) => `${p} changed in the user's checkout while the role worked`),
        ),
        keepWorktree: true,
      },
    };
  }
  return { artifacts };
};

const acceptPhaseRole = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  result: RoleResult,
): Promise<StepOutcome> => {
  const contract = k.deps.roles.get(run.role);
  const declared = contract?.output.artifacts ?? [];
  if (
    result.exit === "done" &&
    run.role !== "planner" &&
    declared.length > 0 &&
    result.artifacts.length === 0
  ) {
    return reject("claim_check", [`a done result returns its ${declared.join("/")} artifact`]);
  }
  let planned: { tasks: { task: Task; draft: TaskDraft }[] } | undefined;
  if (run.role === "planner" && result.exit === "done") {
    if (result.tasks === undefined) return reject("claim_check", ["the Planner returns its tasks"]);
    const plan = await planTasks(k, h, result.tasks);
    if ("issues" in plan) return reject("claim_check", plan.issues);
    planned = plan;
  }
  const work = await acceptIsolatedRole(k, h, run, result);
  if ("outcome" in work) return work.outcome;
  const artifacts = work.artifacts;
  const phase = PHASE_OF_ROLE[run.role] ?? h.state.run.phase;
  if (planned !== undefined) {
    const tasks = planned.tasks;
    return {
      kind: "accept",
      artifacts,
      after: () => {
        createPlan(k, h, tasks);
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

/**
 * An advisor's result (§5.4 through `consult`, spine §5 reading 25): checked like any role's
 * (its writes against its write paths, e.g. the client liaison's `.vtc/exports/**`), logged and
 * priced. Advice changes nothing by itself; its questions go to the human.
 */
const acceptAdvisor = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  result: RoleResult,
): Promise<StepOutcome> => {
  const work = await acceptIsolatedRole(k, h, run, result);
  if ("outcome" in work) return work.outcome;
  return {
    kind: "accept",
    artifacts: work.artifacts,
    after: () => {
      openQuestions(k, h, run, result);
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
  if (isVtcScopeEntry(fault.path))
    return [`${fault.path} is under .vtc/, which no task writes (out_of_scope claim)`];
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
  let gatesHash: string;
  try {
    gatesHash = (await baselineGates(k, h, base)).sha256;
  } catch (error) {
    return [
      `the fault cannot be reproduced: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const checkout = await k.deps.git.createCleanCheckout(base);
  try {
    const report = await k.deps.gateRunner.run({
      run: h.state.id,
      task: task.id,
      reason: "fault_repro",
      gates_config_hash: gatesHash,
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
    recordUnsandboxedGate(k, h, report);
    emitGateResult(k, h, report);
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
    const id = nextNumberedId("T", new Set([...usedTaskIds(k.allStates()), ...k.sharedTaskIds]));
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
    // Parks for the human until the front half (sub-project 4) lands (spine §5 reading 19).
    return {
      kind: "accept",
      after: () => {
        parkTask(k, h, task.id, {
          reason: "spec_conflict",
          detail: result.conflict.detail,
          evidence: result.conflict.req_ids.map((ref) => ({ type: "spec_ref" as const, ref })),
          raisedBy: run.role,
        });
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

/** The task an Architect triage run is about (§8.4), when the run is one. */
const triageTask = (h: RunHandle, run: RoleRunRecord): Task | undefined =>
  run.role === "architect" && run.task === undefined && run.subject?.startsWith("T-") === true
    ? h.state.tasks.get(run.subject)
    : undefined;

/**
 * The Architect's per-task triage (§8.4): its design note or ADR is checked like any front-half
 * role's work (its worktree, its write paths, citations) and copied into the checkout. An ADR for a
 * task triaged `changes` is put to the human as a change request on the frozen architecture; the
 * task waits for the answer. A blocked or conflicting result parks the task.
 */
const acceptArchitectTriage = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  task: Task,
  result: RoleResult,
): Promise<StepOutcome> => {
  if (result.exit === "done" && result.artifacts.length === 0)
    return reject("claim_check", [
      `a done triage of ${task.id} returns its ${task.arch_triage === "changes" ? "ADR" : "design note"}`,
    ]);
  const work = await acceptIsolatedRole(k, h, run, result);
  if ("outcome" in work) return work.outcome;
  const artifacts = work.artifacts;
  return {
    kind: "accept",
    artifacts,
    after: () => {
      openQuestions(k, h, run, result);
      if (result.exit === "blocked" || result.exit === "spec_conflict") {
        parkTask(k, h, task.id, {
          reason: result.exit,
          detail:
            result.exit === "blocked"
              ? `the Architect's triage of ${task.id} is blocked: ${result.question.question}`
              : `the Architect found a conflict in the spec: ${result.conflict.detail}`,
          evidence: artifacts.slice(0, 5).map((a) => ({ type: "file" as const, ref: a.path })),
        });
        return;
      }
      if (task.arch_triage !== "changes") return;
      const frozen = h.state.run.gates.G2.frozen.find((f) =>
        f.path.startsWith(".vtc/architecture/"),
      );
      const id = nextEscalationId(h.state);
      const escalation = parkEscalation({
        id,
        run: h.state.id,
        task: task.id,
        reason: "change_request",
        detail:
          `${task.id} (${task.title}) changes the approved architecture; the Architect's ADR: ${artifacts
            .map((a) => a.path)
            .join(", ")}`.slice(0, 2000),
        evidence: artifacts.slice(0, 5).map((a) => ({ type: "file" as const, ref: a.path })),
        blocks: [task.id],
        now: k.now(),
        raisedBy: "architect",
      });
      k.emit(h, {
        type: "escalation.opened",
        actor: "engine",
        task: task.id,
        data: {
          escalation: {
            ...escalation,
            question: `Approve the architecture change ${task.id} needs (§8.4)?`,
          },
        },
      });
      if (frozen !== undefined)
        k.emit(h, {
          type: "change_request.opened",
          actor: "engine",
          data: {
            escalation: id,
            artifact: "architecture",
            frozen,
            summary: `ADR for ${task.id}: ${task.title}`.slice(0, 300),
          },
        });
    },
  };
};

/**
 * A Final Review reviewer (§6.7a steps 3–4): read-only in its worktree at the feature's integrated
 * head (any change is refused), every citation resolving there. Once every AI step of the round
 * reported, the round concludes (`featureReviewDone`).
 */
const acceptFeatureReviewer = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  result: RoleResult,
): Promise<StepOutcome> => {
  const worktree = k.dispatches.get(recordKey(h.state.id, run.action_id))?.worktree;
  if (worktree === undefined || run.feature === undefined)
    return reject("write_scope", [
      "the engine has no record of the reviewer's worktree, so its review cannot be verified",
    ]);
  const work = await collectRoleChanges(k, worktree, `vtc: ${run.role} (${run.action_id})`);
  if (work.changes.length > 0)
    return reject("write_scope", [
      `a read-only Final Review reviewer changed ${work.changes
        .slice(0, 3)
        .map((c) => c.path)
        .join(", ")}`,
    ]);
  const missing = await unresolved(
    { ...evidenceContext(k, h, null), repoRoot: join(k.deps.repoRoot, worktree.path) },
    // its findings too: at Final Review a finding becomes a fix task, so it must cite what is there
    [
      ...result.claims,
      ...result.verdicts.flatMap((v) => v.evidence),
      ...result.findings.map((f) => f.evidence),
    ],
  );
  if (missing.length > 0)
    return reject(
      "claim_check",
      missing.map((m) => `does not resolve: ${m}`),
    );
  const feature = run.feature;
  return {
    kind: "accept",
    after: () => {
      openQuestions(k, h, run, result);
      featureReviewDone(k, h, feature);
    },
  };
};

/** Is the result arriving where the flow expects it (§4.2 step 4)? `null` when it is. */
const outOfOrder = (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  task: Task | undefined,
): string | null => {
  if (h.state.run.finished_at !== undefined) return "the run has finished";
  if (run.task === undefined) {
    if (k.deps.roles.get(run.role)?.kind === "advisor") return null;
    if (run.feature !== undefined) {
      const status = h.state.features.get(run.feature)?.status;
      return status === "final_review" ? null : `feature ${run.feature} is ${status ?? "unknown"}`;
    }
    const about = triageTask(h, run);
    if (about !== undefined)
      return about.status === "ready" ? null : `task ${about.id} is ${about.status}`;
    const phase = PHASE_OF_ROLE[run.role];
    return phase !== undefined && h.state.run.phase !== phase
      ? `the run is in ${h.state.run.phase}, not ${phase}`
      : null;
  }
  if (task === undefined) return `no task ${run.task}`;
  const expected: readonly string[] =
    run.role === "engineer"
      ? ["building", "fixing"]
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
    recordSpend(k, h, run, outcome.cost_usd ?? null);
    return;
  }
  // D-at (spine §5 reading 77): what the host reports a failed run cost counts too, whatever
  // the model; on the event, so the run's and the advisor budget's spend include it
  const cost = outcome.kind === "auth" ? null : outcome.cost_usd;
  k.emit(h, {
    type: "role.failed",
    actor: "engine",
    role: run.role,
    ...(run.task === undefined ? {} : { task: run.task }),
    ...(cost === null ? {} : { cost_usd: cost }),
    data: {
      action_id: run.action_id,
      kind: outcome.kind,
      message: outcome.message.slice(0, 2000),
      retryable: outcome.kind === "error" ? outcome.retryable : false,
    },
  });
  recordSpend(k, h, run, cost);
  if (outcome.kind === "auth") {
    // The user must sign in again; VTC never touches credentials (AD-9).
    k.emit(h, {
      type: "run.paused",
      actor: "engine",
      data: { reason: "the host lost its sign-in; sign in again and resume" },
    });
    return;
  }
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
  // Every role's dispatch record is checked before anything else, for a result and a failure
  // alike (AD-7 rule 7); the record goes only once checked.
  const writes = checkRun(k, h, run);
  const record = k.dispatches.get(recordKey(h.state.id, run.action_id));
  const close = async (keepWorktree: boolean): Promise<void> => {
    // nothing is re-dispatched over writes no one has looked at: the human resumes
    reportFindings(k, h, run, writes);
    if (record !== undefined && writes.git.length === 0 && !keepWorktree)
      await removeRoleWorktree(k, record);
    dropDispatch(k, h.state.id, run.action_id);
  };
  if (input.kind === "failure") {
    handleFailure(k, h, run, input.outcome);
    await close(false);
    // a limit interrupts every run in flight: theirs are checked now too
    await sweepDispatches(k, h);
    return { accepted: true };
  }
  const rollback = await taskWorktreeHead(k, h, run);
  const outcome: StepOutcome =
    writes.issues.length > 0
      ? reject("write_scope", writes.issues)
      : await evaluate(k, h, run, input.result);
  if (outcome.kind === "reject") {
    logRejection(k, h, run, outcome.rejection, input.usage);
    // A rejected result leaves nothing in the task worktree (committed or not), so the next role
    // there is never charged with it (spine §5 reading 86).
    if (rollback !== null) await k.deps.workspace.discard(rollback.worktree, rollback.head);
  }
  await close(outcome.kind === "reject" && outcome.keepWorktree === true);
  if (writes.issues.length > 0)
    return { accepted: false, rejection: rejection("write_scope", writes.issues) };
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
    ...(input.session_ref === undefined ? {} : { session: input.session_ref }),
  });
  // The host session the run used: later rounds and answers resume it (§6.3 step 8, §6.5).
  const task = run.task === undefined ? undefined : h.state.tasks.get(run.task);
  if (
    task !== undefined &&
    input.session_ref !== undefined &&
    JSON.stringify(task.session_ref) !== JSON.stringify(input.session_ref)
  ) {
    k.emit(h, {
      type: "task.session_updated",
      actor: "engine",
      task: task.id,
      data: { session_ref: input.session_ref },
    });
  }
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
  const order = outOfOrder(k, h, run, task);
  if (order !== null) return reject("out_of_order", [order]);
  if (task === undefined)
    return contract.kind === "advisor"
      ? acceptAdvisor(k, h, run, result)
      : run.feature !== undefined
        ? acceptFeatureReviewer(k, h, run, result)
        : triageTask(h, run) !== undefined
          ? acceptArchitectTriage(k, h, run, triageTask(h, run) as Task, result)
          : acceptPhaseRole(k, h, run, result);
  if (run.role === "engineer") return acceptEngineer(k, h, run, task, result);
  if (run.role === "qa" && run.mode === "author") return acceptQaAuthor(k, h, run, task, result);
  if (isReviewer(run)) return acceptReviewer(k, h, run, task, result);
  return reject("dispatch_mismatch", [`role ${run.role} has no task step`]);
};
