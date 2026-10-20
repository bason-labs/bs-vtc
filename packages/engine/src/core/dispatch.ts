/**
 * The flow composer's dispatch side (§4.2 step 1, §6.3; AD-4 rules 1 and 4, AD-17): which role
 * runs the engine wants now, and the `spawn_role` actions the Lead performs for them. Every
 * dispatch is a `role.dispatched` event with its pack, model and prompt version, so `submit` can
 * reject anything the engine did not ask for.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  agentNameFor,
  effectivePromptSha,
  HIDDEN_TESTS,
  inSessionDispatchRefusal,
  PACK_INPUT_TYPES,
  EVENT_PAYLOAD_SCHEMAS,
  PromptVersionRefSchema,
  resolveRoleMode,
  SESSION_DEFAULT_MODEL,
  sha256Hex,
  TaskPackSchema,
  type ArtifactRef,
  type DispatchPurpose,
  type Escalation,
  type EscalationAnswer,
  type Finding,
  type ArmPlugin,
  type HostId,
  type ModelTier,
  type Phase,
  type ResolvedModel,
  type SessionRef,
  type SpawnRoleAction,
  type TaskPackInput,
  type TierReason,
  type DesignCoverageGaps,
  type EffectiveRoleContract,
} from "@vtc/shared";
import { restoreHostConfig } from "../git/index.js";
import { ownedAttachments, placeAttachments, runAttachments } from "./attachments.js";
import { budgetState, sharesExceeded } from "./budget.js";
import { DEFAULT_ACCEPTANCE_GLOBS } from "./config.js";
import {
  EngineError,
  type CallContext,
  type Kernel,
  type PinnedPrompt,
  type PromptPins,
  type PromptTarget,
  type RunHandle,
} from "./kernel.js";
import { finalReviewSteps } from "./final-review.js";
import { designerRedispatchNote, designWorkSince, rerollInputs } from "./g2.js";
import {
  changeSpecAnswer,
  coverageGapsFor,
  coverageRedoSince,
  coverageWaitsForArchitect,
} from "./design-loop.js";
import { retroSteps } from "./retro.js";
import type { PromptParts } from "./plugins.js";
import { effectiveVerdict } from "./gate-verdict.js";
import { engineerDispatch } from "./loop.js";
import { modelFallbackFor } from "./model-fallback.js";
import { routeTier, type TierChange, type TierRoute } from "./routing.js";
import { writeMethodSkill, writeTaskPack } from "./projections.js";
import {
  awaitingReopenRebase,
  inFlight,
  lastBuilt,
  lastQaAuthor,
  lastSubmitted,
  nextActionId,
  nextEscalationId,
  shareSpend,
  pendingBaseCheck,
  phaseEnteredSeq,
  renderedVisualReport,
  roundVerdict,
  planOrder,
  runsOf,
  statusEnteredSeq,
  taskFindings,
  visualJudgeStep,
} from "./queries.js";
import { frozenSpecItems, taskAcceptanceCriteria } from "./read-model.js";
import { resolveModel, roleTier } from "./roles.js";
import { crossFamilyHost } from "./cross-family.js";
import { installedLensRoles, reviewersFor, slotMatches } from "./router.js";
import { parkTask, setTaskStatus } from "./parking.js";
import { parkEscalation } from "./escalations.js";
import { recordDispatch, type DispatchRecord } from "./dispatch-guard.js";
import { ensurePrivateDir } from "./guard.js";
import { architectDepth, dealDesignConstraints, researchDepth } from "./lottery.js";
import { prepareRoleWorktree } from "./role-worktree.js";
import {
  armPluginDir,
  armPluginsRoot,
  prepareTrial,
  refuseTrial,
  replayTrialRef,
  trialAtRef,
  type ReplayStepRef,
} from "./replay.js";
import { HEADLESS_LOADS_AGENT, pinBlocker } from "./prompt-target.js";

export { HEADLESS_LOADS_AGENT } from "./prompt-target.js";

/** A handed-out step: the Lead's action, and what an engine-launched run of it needs. */
export interface DispatchedStep {
  readonly action: SpawnRoleAction;
  readonly model: ResolvedModel;
  /** Absolute directory the role works in. */
  readonly cwd: string;
  /**
   * A headless run on a host that cannot load the compiled agent ({@link HEADLESS_LOADS_AGENT}):
   * the agent's locked core, which the engine puts before the prompt (spine §5 reading 145);
   * `null` when the plugin's texts are missing or do not match its manifest (the run must not
   * start). Absent when the host loads the agent, or the plugin has no manifest entry for it.
   */
  readonly roleCore?: string | null;
  /**
   * A replay trial's own compiled arm plugin (D-cg, spine §5 reading 201), for
   * `SpawnRoleRequest.pluginDir`: on a host whose runs load the compiled agent, the arm's prompt is
   * in this copy of the plugin.
   */
  readonly pluginDir?: string;
}

export interface StepSpec {
  readonly key: string;
  readonly role: string;
  readonly mode?: string;
  readonly task?: string;
  /** A feature-level step with no task: a Final Review reviewer (§6.7a steps 3–4). */
  readonly feature?: string;
  /**
   * A step the engine runs headless on this host whatever the Lead's: the cross-family reviewer
   * (§12.4). It never becomes a Lead action.
   */
  readonly host?: HostId;
  readonly subject?: string;
  /**
   * The tier the step runs on (H-9, D-cm: `routing.ts`), with why (`tierReason`) and whether the
   * project's bounds or QA author's floor moved it (`tierClamped`). Set by the step's planner for
   * every role run of a task; a step without `tierReason` is routed when it is handed out.
   */
  readonly tier?: ModelTier;
  readonly tierReason?: TierReason;
  readonly tierClamped?: boolean;
  readonly resume?: SessionRef;
  readonly findings?: readonly Finding[];
  readonly answer?: EscalationAnswer;
  readonly note?: string;
  /** The G2 coverage loop's gaps this DESIGN re-dispatch fixes (`TaskPack.coverage_gaps`, H-13). */
  readonly coverageGaps?: DesignCoverageGaps;
  /** Extra pack inputs (an advisor's, `consult`). */
  readonly inputs?: readonly ArtifactRef[];
  /** Engine transition that happens as the step is handed out (e.g. → building). */
  readonly onDispatch?: () => void;
  /** Why the step runs (`planDispatch`'s purpose); default `role`. */
  readonly purpose?: DispatchPurpose;
  /**
   * A Lookback replay trial (AD-21 rule 6, reading 176): it runs in a clean checkout at `base`,
   * reads the recorded pack (without its task) and runs the arm's prompt version, never a pin.
   */
  readonly replay?: ReplayStepRef;
}

/**
 * Whether the run has Security's design mode (§5.2, §6.1 DESIGN; spine §5 reading 37): the
 * installed Security contract declares it. Without it DESIGN runs without a threat model step.
 */
const securityDesign = (k: Kernel): boolean =>
  k.deps.roles.get("security")?.modes?.design !== undefined;

/**
 * Whether DESIGN does UI design work (the Designer, its directions and prototype; §6.1, §9.1): a
 * run with UI the human asked for. An automatic run with UI (`has_ui` from its issue's paths, spine
 * §5 reading 223) does none: G2 stays the engine's and nothing waits on a prototype.
 */
export const designWork = (h: Pick<RunHandle, "state">): boolean =>
  h.state.run.has_ui && h.state.automation === null;

/** Front-half roles per phase (§6.1). The deeper front half is sub-project 4. */
export const phaseRoles = (
  k: Kernel,
  h: RunHandle,
  phase: Phase,
): { role: string; mode?: string }[] => {
  const run = h.state.run;
  switch (phase) {
    case "discover":
      return run.track === "quick_fix"
        ? []
        : [{ role: run.repo === "existing" ? "repo_cartographer" : "research_analyst" }];
    case "specify":
      return [{ role: "ba" }];
    case "design":
      // §6.1: Architect, Security's threat model and the Designer (with UI) run in parallel. An
      // automatic run's UI is the project's as it is (its issue is the spec, reading 223): no
      // Designer, no directions and no prototype; its UI tasks are checked against the
      // project's own screens
      return [
        { role: "architect" },
        ...(securityDesign(k) ? [{ role: "security", mode: "design" }] : []),
        ...(designWork(h) ? [{ role: "designer" }] : []),
      ];
    case "plan":
      return [{ role: "planner" }];
    default:
      return [];
  }
};

/** The latest answer to an escalation of this task given after `afterSeq`. */
const freshAnswer = (
  h: RunHandle,
  task: string,
  afterSeq: number,
): EscalationAnswer | undefined => {
  const answered = h.state.events.filter(
    (e) =>
      e.type === "escalation.answered" &&
      e.seq > afterSeq &&
      h.state.escalations.get((e.data as { escalation: string }).escalation)?.task === task,
  );
  const last = answered.at(-1);
  return last === undefined ? undefined : (last.data as { answer: EscalationAnswer }).answer;
};

const lastDispatchSeq = (h: RunHandle, task: string, role: string): number =>
  runsOf(h.state, task)
    .filter((r) => r.role === role)
    .reduce((max, r) => Math.max(max, r.seq), 0);

/** Rejection issues of the step's last run, so the re-dispatch can fix them. */
const rejectionNote = (
  h: RunHandle,
  filter: { role: string; mode?: string; task?: string; subject?: string },
): string | undefined => {
  const last = [...h.state.roleRuns.values()]
    .filter(
      (r) =>
        r.role === filter.role &&
        r.mode === filter.mode &&
        r.task === filter.task &&
        r.subject === filter.subject,
    )
    .at(-1);
  if (last?.status !== "rejected" || last.rejection === undefined) return undefined;
  // a rejected Engineer or QA author result is discarded from the task worktree (submit.ts)
  const discarded =
    filter.task !== undefined &&
    (filter.role === "engineer" || (filter.role === "qa" && filter.mode === "author"))
      ? " Its changes were discarded from the worktree: redo them within scope."
      : "";
  return `Your previous result was rejected (${last.rejection.reason}): ${last.rejection.issues.join("; ")}${discarded}`;
};

const interruptedSession = (
  h: RunHandle,
  filter: { role: string; task?: string },
): SessionRef | undefined => {
  const last = [...h.state.roleRuns.values()]
    .filter((r) => r.role === filter.role && r.task === filter.task)
    .at(-1);
  if (last?.status !== "interrupted") return undefined;
  return h.state.limit?.sessionRef ?? undefined;
};

const busyStep = (
  h: RunHandle,
  step: { role: string; mode?: string; task?: string; subject?: string },
): boolean =>
  inFlight(h.state).some(
    (r) =>
      r.role === step.role &&
      r.mode === step.mode &&
      r.task === step.task &&
      r.subject === step.subject,
  );

/**
 * The tier a step runs on (H-9, D-cm; spine §5 reading 218): {@link routeTier} over the step's
 * task, the role's own tier on `host` and the project's `routing`. A step with no task keeps its
 * role's tier (reason `role`). A Lookback replay trial runs on the tier its recorded dispatch ran
 * on (reading 218 (7)), or the role's own for a dispatch logged before 5.4.0, never re-routed;
 * a tier replay's trial (D-cn, reading 247(6)) runs on its arm's tier instead (reason `rule`: the
 * routing-table cell under test), unclamped, so the arm measures the tier it names.
 */
export const routeStep = (
  k: Kernel,
  h: RunHandle,
  step: Pick<StepSpec, "role" | "mode" | "task" | "replay"> & {
    /** The step fills the task's cross-family reviewer slot (D-cu's high-risk raise). */
    readonly crossFamily?: boolean;
  },
  host: HostId,
  change?: TierChange,
  steps?: number,
): TierRoute => {
  const contract = k.deps.roles.get(step.role);
  const own = contract === undefined ? "mid" : roleTier(contract, host, step.mode);
  if (step.replay !== undefined) {
    if (step.replay.armTier !== undefined)
      return { tier: step.replay.armTier, reason: "rule", clamped: false };
    return step.replay.tier ?? { tier: own, reason: "role", clamped: false };
  }
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  return routeTier(
    {
      role: step.role,
      mode: step.mode,
      task,
      roleTier: own,
      ...(step.crossFamily === true ? { crossFamily: true } : {}),
      config: k.config(),
      table: k.deps.routingTable,
    },
    change,
    steps,
  );
};

/**
 * D-cm: the tier a step is dispatched on: the route its planner gave it, or, for a step its planner
 * did not route (the phase roles), {@link routeStep}'s (the role's own tier, clamped). The headless
 * preflight prices this same tier.
 */
export const stepRoute = (
  k: Kernel,
  h: RunHandle,
  step: Pick<StepSpec, "role" | "mode" | "task" | "replay" | "tier" | "tierReason" | "tierClamped">,
  host: HostId,
): TierRoute =>
  step.tier !== undefined && step.tierReason !== undefined
    ? { tier: step.tier, reason: step.tierReason, clamped: step.tierClamped ?? false }
    : routeStep(k, h, step, host);

/** The step fields of a route. */
const routed = (
  route: TierRoute,
): Required<Pick<StepSpec, "tier" | "tierReason" | "tierClamped">> => ({
  tier: route.tier,
  tierReason: route.reason,
  tierClamped: route.clamped,
});

/**
 * The Architect's per-task step (§8.4): a task the Planner triaged `extends` gets a one-page design
 * note, one triaged `changes` an ADR, which the engine then puts to the human as a change request
 * on the frozen architecture (G2 is always approved before PLAN). The step runs in its own
 * worktree like a front-half role, its subject the task. `done` once the Architect's result was
 * accepted and no change request of it is open; `null` while it runs or waits for the human.
 */
export const architectTriageStep = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
): StepSpec | "done" | null => {
  const task = h.state.tasks.get(taskId);
  if (
    task === undefined ||
    task.arch_triage === "fits" ||
    k.deps.roles.get("architect") === undefined
  )
    return "done";
  const filter = { role: "architect", subject: taskId };
  if (busyStep(h, filter)) return null;
  const accepted = [...h.state.roleRuns.values()]
    .filter((r) => r.role === "architect" && r.subject === taskId && r.status === "submitted")
    .sort((a, b) => (a.closedSeq ?? 0) - (b.closedSeq ?? 0))
    .at(-1);
  let rejected: string | undefined;
  if (accepted !== undefined) {
    const open = [...h.state.escalations.values()].some(
      (e) => e.task === taskId && e.reason === "change_request" && e.answer === undefined,
    );
    if (open) return null;
    // a change request the human rejected never lets the task build on it (AD-8 rule 1): the
    // task parked on the rejection, and once the human answered that park the Architect triages
    // it again with the answer
    rejected = rejectedTriageChange(h, taskId, accepted.closedSeq ?? 0);
    if (rejected === undefined) return "done";
  }
  const note = [rejected, rejectionNote(h, filter)].filter((n) => n !== undefined).join("\n");
  const ask =
    task.arch_triage === "extends"
      ? `Per-task triage (§8.4): ${taskId} extends the approved spine. Write a one-page design note for it under .vtc/architecture/notes/${taskId}.md (artifact design_note): which components it touches and how it stays inside the spine.`
      : `Per-task triage (§8.4): ${taskId} changes the approved architecture (a new service, datastore, integration, trust boundary, breaking interface or irreversible migration). Write an ADR for it under .vtc/architecture/adr/ (artifact adr, or design_note where your contract has no adr): the decision, the alternatives and its Check. The engine asks the human to approve the change before the task starts.`;
  return {
    key: `triage:${taskId}`,
    ...filter,
    note: [ask, ...(note === "" ? [] : [note])].join("\n"),
  };
};

/** The change-request answer `answer` picked on `escalation`, by its option's effect. */
const answerEffect = (escalation: Escalation): string | undefined =>
  escalation.answer === undefined
    ? undefined
    : escalation.options.find((o) => o.id === escalation.answer?.option)?.effect;

/**
 * When the change request the Architect's last accepted triage of `taskId` opened (after
 * `sinceSeq`) was rejected by the human: the note for the next triage (the rejection and the
 * human's answers since). `undefined` when there is none or it was not rejected.
 */
const rejectedTriageChange = (
  h: RunHandle,
  taskId: string,
  sinceSeq: number,
): string | undefined => {
  const opened = h.state.events.findLast((e) => {
    if (e.type !== "escalation.opened" || e.task !== taskId || e.seq <= sinceSeq) return false;
    const escalation = (e.data as { escalation?: Partial<Escalation> }).escalation;
    return escalation?.reason === "change_request" && escalation.raised_by === "architect";
  });
  const id = (opened?.data as { escalation?: { id?: string } } | undefined)?.escalation?.id;
  const cr = id === undefined ? undefined : h.state.escalations.get(id);
  if (cr === undefined || answerEffect(cr) !== "reject_change") return undefined;
  const answered = (e: { type: string; data: unknown }): EscalationAnswer | undefined =>
    e.type === "escalation.answered" ? (e.data as { answer?: EscalationAnswer }).answer : undefined;
  const rejectedAt =
    h.state.events.findLast(
      (e) =>
        e.type === "escalation.answered" &&
        (e.data as { escalation?: string }).escalation === cr.id,
    )?.seq ?? 0;
  const answers = h.state.events
    .filter((e) => e.task === taskId && e.seq > rejectedAt)
    .flatMap((e) => {
      const text = answered(e)?.text;
      return text === undefined ? [] : [text];
    });
  return [
    `The human rejected the change request ${cr.id} for your previous ADR of ${taskId}${cr.answer?.text === undefined ? "" : ` ("${cr.answer.text}")`}. Do not build on the rejected change: write a new ADR that fits the human's answer, or say the task is blocked.`,
    ...answers.map((a) => `The human's answer: ${a}`),
  ].join("\n");
};

/** Steps of one task that need a role run now. */
const taskSteps = (k: Kernel, h: RunHandle, taskId: string, host: HostId): StepSpec[] => {
  const task = h.state.tasks.get(taskId);
  if (task?.worktree === undefined) return [];
  const steps: StepSpec[] = [];
  if (task.status === "ready") {
    // §8.4 per-task triage: `extends` and `changes` get the Architect before QA starts
    const triage = architectTriageStep(k, h, taskId);
    if (triage !== "done") return triage === null ? [] : [triage];
    const step = { role: "qa", mode: "author", task: taskId };
    const waiting = pendingBaseCheck(h.state, taskId) !== undefined;
    if (!busyStep(h, step) && !k.isRunning(`gates:${taskId}`) && !waiting) {
      const qa = lastQaAuthor(h.state, taskId);
      const missed = h.state.gateReports.some(
        (r) =>
          r.seq > (qa?.closedSeq ?? Number.MAX_SAFE_INTEGER) &&
          r.report.task === taskId &&
          r.report.reason === "base_fail_check" &&
          r.report.verdict !== "infra_error",
      );
      const note =
        rejectionNote(h, step) ??
        (missed
          ? "Your acceptance tests passed on the base commit. They must fail before the implementation exists (§6.3 step 2): test the new behaviour."
          : undefined);
      // the human's hint after QA got stuck goes to QA author (parking.ts resumeTarget)
      const answer = freshAnswer(h, taskId, lastDispatchSeq(h, taskId, "qa"));
      steps.push({
        key: `qa:${taskId}`,
        ...step,
        ...routed(routeStep(k, h, step, host)),
        ...(note === undefined ? {} : { note }),
        ...(answer === undefined ? {} : { answer }),
      });
    }
    return steps;
  }
  if (task.status === "tests_authored" || task.status === "building" || task.status === "fixing") {
    if (
      busyStep(h, { role: "engineer", task: taskId }) ||
      busyStep(h, { role: "qa", mode: "author", task: taskId }) ||
      // a task Final Review reopened works only once its worktree is on the integrated head
      awaitingReopenRebase(h.state, taskId)
    )
      return [];
    const fixingSince = statusEnteredSeq(h.state, taskId, "fixing") ?? 0;
    const badTests = taskFindings(h.state, taskId).filter(
      (f) => f.status === "open" && f.route === "bad_test",
    );
    const qaSince = lastSubmitted(
      h.state,
      { role: "qa", mode: "author", task: taskId },
      fixingSince,
    );
    if (task.status === "fixing" && badTests.length > 0 && qaSince === undefined) {
      const qaFix = { role: "qa", mode: "author", task: taskId };
      steps.push({
        key: `qa-fix:${taskId}`,
        ...qaFix,
        ...routed(routeStep(k, h, qaFix, host)),
        findings: badTests,
      });
      return steps;
    }
    const round = task.status === "tests_authored" ? 1 : Math.max(1, task.round);
    // D-cm, D-cv: the Engineer starts on its routed tier (after the clamp) and escalates from it
    // by `escalationSteps` (a Low start Low, Mid, Top in rounds 1–3; reading 242), clamped each
    // time; each tier change starts a fresh session
    const engineerStep = { role: "engineer", task: taskId };
    const start = routeStep(k, h, engineerStep, host);
    const plan = engineerDispatch(start.tier, round);
    const route = plan.escalated
      ? routeStep(k, h, engineerStep, host, "escalation", plan.steps)
      : start;
    // a later escalation the project's clamp holds on the same tier keeps the session
    const fresh =
      plan.freshSession &&
      (plan.steps <= 1 ||
        routeStep(k, h, engineerStep, host, "escalation", plan.steps - 1).tier !== route.tier);
    const resume =
      interruptedSession(h, { role: "engineer", task: taskId }) ??
      (fresh || round === 1 ? undefined : task.session_ref);
    const answer = freshAnswer(h, taskId, lastDispatchSeq(h, taskId, "engineer"));
    const note = rejectionNote(h, { role: "engineer", task: taskId });
    steps.push({
      key: `engineer:${taskId}`,
      role: "engineer",
      task: taskId,
      ...routed(route),
      ...(resume === undefined ? {} : { resume }),
      findings: [
        ...taskFindings(h.state, taskId).filter(
          (f) => f.status === "open" && (f.route === "patch" || f.route === "out_of_scope"),
        ),
        // Out-of-scope faults other tasks' Engineers routed to this task (§6.3 step 3).
        ...[...h.state.findings.values()]
          .map((r) => r.finding)
          .filter(
            (f) =>
              f.status === "open" &&
              f.route === "out_of_scope" &&
              f.owner_task === taskId &&
              f.task !== taskId,
          ),
      ],
      ...(answer === undefined ? {} : { answer }),
      ...(note === undefined ? {} : { note }),
      ...(task.status === "tests_authored"
        ? {
            onDispatch: () => {
              setTaskStatus(k, h, taskId, "building", { round: 1 });
            },
          }
        : {}),
    });
    return steps;
  }
  if (task.status === "verifying") {
    const built = lastBuilt(h.state, taskId);
    if (built?.head === undefined || k.isRunning(`gates:${taskId}`)) return [];
    const round = roundVerdict(h.state, taskId);
    if (round === undefined || effectiveVerdict(round) !== "pass") return [];
    // At 70% of the budget, or once the reviewers used their 25% share, they drop a tier (§11).
    const drop =
      budgetState(task.spent_usd, task.budget_usd) === "reviewers_drop" ||
      sharesExceeded(shareSpend(h.state, taskId), task.budget_usd).reviewers;
    const cross = crossFamilyHost(k, h, task);
    // §7.5 step 6: the judge reads the round's visual report and renders
    const visual = renderedVisualReport(round);
    for (const slot of reviewersFor(
      task,
      h.state.run,
      taskAcceptanceCriteria(k.deps.repoRoot, h.state, taskId),
      {
        lensRoles: installedLensRoles(k.deps.roles),
        crossFamily: cross !== undefined,
        visual: visual !== undefined,
      },
    )) {
      const filter = {
        role: slot.role,
        ...(slot.mode === undefined ? {} : { mode: slot.mode }),
        task: taskId,
        ...(slot.subject === undefined ? {} : { subject: slot.subject }),
      };
      if (slot.role === "visual_qa") {
        // three independent calls: count the accepted ones since the head was built
        const done = runsOf(h.state, taskId).filter(
          (r) =>
            r.role === "visual_qa" &&
            r.status === "submitted" &&
            (r.closedSeq ?? 0) > (built.closedSeq ?? 0),
        ).length;
        const flying = inFlight(h.state).filter(
          (r) => r.role === "visual_qa" && r.task === taskId,
        ).length;
        const index = Number(slot.id.split("-").at(-1));
        if (index <= done + flying) continue;
      } else {
        const runs = runsOf(h.state, taskId).filter((r) => slotMatches(slot, r, cross));
        if (runs.some((r) => r.status === "in_flight")) continue;
        if (
          runs.some((r) => r.status === "submitted" && (r.closedSeq ?? 0) > (built.closedSeq ?? 0))
        )
          continue;
      }
      // D-cu (reading 241): every reviewer starts on its own role.yaml tier (the cross-family one
      // on its own host; it and Security verify one tier up on a high-risk task) and drops one
      // tier from it (clamped)
      const crossSlot = slot.crossFamily === true && cross !== undefined;
      const route = routeStep(
        k,
        h,
        { ...filter, ...(crossSlot ? { crossFamily: true } : {}) },
        crossSlot ? cross : host,
        drop ? "budget_drop" : undefined,
      );
      const judge =
        slot.role === "visual_qa" && visual !== undefined
          ? visualJudgeStep(visual, `task ${taskId}'s screens`)
          : undefined;
      const note = [judge?.note, rejectionNote(h, filter)]
        .filter((n) => n !== undefined)
        .join("\n");
      steps.push({
        key: `review:${taskId}:${slot.id}`,
        ...filter,
        ...routed(route),
        ...(note === "" ? {} : { note }),
        ...(judge === undefined ? {} : { inputs: judge.inputs }),
        ...(slot.crossFamily === true && cross !== undefined ? { host: cross } : {}),
      });
    }
  }
  return steps;
};

/** Every role run the engine wants now, most important first: work in progress before new work. */
export const pendingSteps = (k: Kernel, h: RunHandle, host: HostId): StepSpec[] => {
  const state = h.state;
  if (state.run.finished_at !== undefined) return [];
  const phase = state.run.phase;
  // RETRO (§13 steps 1–2): the lookback role, one target at a time (retro.ts)
  if (phase === "retro") return retroSteps(k, h);
  const phaseRoleList = phaseRoles(k, h, phase);
  if (phaseRoleList.length > 0) {
    const entered = phaseEnteredSeq(state, phase) ?? 0;
    const blocked = [...state.escalations.values()].some(
      (e) => e.phase === phase && e.answer === undefined,
    );
    if (blocked) return [];
    // a G2 re-roll sends only the Designer back (§9.1 step 5, reading 151)
    const reroll = phase === "design" ? rerollInputs(h) : undefined;
    return phaseRoleList.flatMap(({ role, mode }) => {
      const filter = { role, ...(mode === undefined ? {} : { mode }) };
      if (busyStep(h, filter)) return [];
      const since = designWorkSince(h, role, entered);
      // H-13 (reading 237): a role the coverage loop re-dispatched hands in its work again, the
      // Designer after the Architect
      const redo = phase === "design" ? coverageRedoSince(h, role) : 0;
      const done = lastSubmitted(state, filter, Math.max(since, redo));
      // D-bt (reading 174): too few directions on a new UI design send the Designer back once
      const again =
        phase === "design" && role === "designer" ? designerRedispatchNote(k, h, since) : undefined;
      if (done !== undefined && done.exit === "done" && again === undefined) return [];
      if (
        phase === "design" &&
        coverageWaitsForArchitect(
          h,
          role,
          (seq) => lastSubmitted(state, { role: "architect" }, seq)?.exit === "done",
        )
      )
        return [];
      const coverageGaps = phase === "design" ? coverageGapsFor(h, role) : undefined;
      const note = [rejectionNote(h, filter), again].filter((n) => n !== undefined).join("\n");
      const decision = [...state.events]
        .reverse()
        .find((e) => e.type === "gate.rejected" || e.type === "gate.approved");
      const gateNote =
        decision?.type === "gate.rejected"
          ? `The ${decision.actor === "engine" ? "engine" : "human"} rejected the gate${(decision.data as { note?: string }).note === undefined ? "." : `: ${(decision.data as { note?: string }).note ?? ""}`}`
          : undefined;
      const rerolled = role === "designer" ? reroll : undefined;
      const combined = [note === "" ? undefined : note, gateNote, rerolled?.note]
        .filter((n) => n !== undefined)
        .join("\n");
      const answer = phaseAnswer(h, phase, role);
      return [
        {
          key: `phase:${role}`,
          ...filter,
          ...(combined === "" ? {} : { note: combined }),
          ...(answer === undefined ? {} : { answer }),
          ...(coverageGaps === undefined ? {} : { coverageGaps }),
          ...(rerolled === undefined || rerolled.inputs.length === 0
            ? {}
            : { inputs: rerolled.inputs }),
        },
      ];
    });
  }
  return [
    ...planOrder(state).flatMap((task) => taskSteps(k, h, task.id, host)),
    // Final Review's AI steps, once per feature on its integrated branch (§6.7a steps 3–4)
    ...finalReviewSteps(k, h),
  ];
};

/**
 * The answer to the latest run-scoped escalation of `phase` given after the role's last dispatch;
 * for the BA in SPECIFY also the human's `change_spec` answer to the G2 coverage loop (H-13).
 */
const phaseAnswer = (h: RunHandle, phase: Phase, role: string): EscalationAnswer | undefined => {
  const since = [...h.state.roleRuns.values()]
    .filter((r) => r.role === role && r.task === undefined)
    .reduce((max, r) => Math.max(max, r.seq), 0);
  if (phase === "specify" && role === "ba") {
    const changed = changeSpecAnswer(h, since);
    if (changed !== undefined) return changed;
  }
  const answered = [...h.state.escalations.values()].filter(
    (e) => e.phase === phase && e.answer !== undefined,
  );
  const last = answered.at(-1);
  if (last?.answer === undefined) return undefined;
  const answeredSeq =
    h.state.events.find(
      (e) =>
        e.type === "escalation.answered" &&
        (e.data as { escalation: string }).escalation === last.id,
    )?.seq ?? 0;
  return answeredSeq > since ? last.answer : undefined;
};

/**
 * What the engine decides for the pack (§6.2, §8.3, §9.1 step 2): the Architect's depth from the
 * frozen spec, DISCOVER's research depth from the track, and a Designer direction's constraints
 * from the seeded lottery (one deal per Designer dispatch of the run, in order).
 */
const depthsFor = (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
): Pick<TaskPackInput, "architect_depth" | "research_depth" | "design_constraints"> => {
  if (step.task !== undefined || step.subject?.startsWith("T-") === true) return {};
  const run = h.state.run;
  if (step.role === "architect") {
    const spec = run.gates.G1.frozen
      .filter((f) => f.path.startsWith(".vtc/spec/"))
      .map((f) => {
        try {
          return readFileSync(join(k.deps.repoRoot, f.path), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    const requirements = new Set(
      frozenSpecItems(k.deps.repoRoot, h.state).map((i) => i.id.split(".")[0]),
    ).size;
    return { architect_depth: architectDepth(run.track, spec, requirements) };
  }
  if (step.role === "repo_cartographer" || step.role === "research_analyst")
    return { research_depth: researchDepth(run.track) };
  if (step.role === "designer") {
    const direction = [...h.state.roleRuns.values()].filter(
      (r) => r.role === "designer" && r.task === undefined,
    ).length;
    return { design_constraints: dealDesignConstraints(k.deps.repoRoot, h.state.id, direction) };
  }
  return {};
};

/** The DISCOVER roles whose outputs later phase roles read (§6.1): the repo map, the brief. */
const DISCOVER_ROLES = ["repo_cartographer", "research_analyst"] as const;

type SubmittedArtifacts = { artifacts?: { type: string; path: string }[] } | undefined;

/** The artifacts of a role's latest accepted (submitted) result in the run. */
const lastSubmittedArtifacts = (
  state: RunHandle["state"],
  role: string,
): readonly { type: string; path: string }[] =>
  (
    state.events.findLast((e) => e.type === "role.submitted" && e.role === role)
      ?.data as SubmittedArtifacts
  )?.artifacts ?? [];

/** The type each artifact path was last submitted as, by any role of the run. */
const submittedArtifactTypes = (state: RunHandle["state"]): Map<string, string> => {
  const types = new Map<string, string>();
  for (const e of state.events)
    if (e.type === "role.submitted")
      for (const a of (e.data as SubmittedArtifacts)?.artifacts ?? []) types.set(a.path, a.type);
  return types;
};

/**
 * The artifact type of a frozen G1/G2 file no role submitted (it was never named in a result):
 * by the §3 layout of `.vtc/spec/`, `.vtc/architecture/` and `.vtc/design/`.
 */
const frozenTypeByPath = (path: string): string => {
  if (path.startsWith(".vtc/spec/")) return "spec";
  if (path.startsWith(".vtc/architecture/threat-model/")) return "threat_model";
  if (path.startsWith(".vtc/architecture/")) return "architecture";
  const design = path.startsWith(".vtc/design/") ? path.slice(".vtc/design/".length) : null;
  if (design === null) return "spec";
  if (design.startsWith("flows")) return "design_flows";
  if (design.startsWith("screens")) return "screens";
  if (design.startsWith("tokens")) return "design_tokens";
  if (design === "DESIGN.md") return PACK_INPUT_TYPES.designMd;
  if (design.startsWith("components/")) return "component_specs";
  return "prototype";
};

/** The post-G2 UI roles that judge against the approved direction (spine §5 reading 179). */
const DIRECTION_ROLES: ReadonlySet<string> = new Set(["engineer", "visual_qa", "designer"]);

/**
 * The design direction the human approved at G2 (`gate.approved.design_direction`, §9.1 step 6),
 * for a post-G2 UI dispatch of a role that judges against it (spine §5 reading 179): the latest G2
 * approval's, absent before G2, on a run without UI, and after the `category_standard` exit.
 */
export const approvedDirection = (
  state: RunHandle["state"],
  step: Pick<StepSpec, "role">,
): string | undefined => {
  const g2 = approvedDesign(state, step);
  return g2?.design_exit === "category_standard" ? undefined : g2?.design_direction;
};

/**
 * What the latest G2 approval chose, for a post-G2 UI dispatch of a role that judges against it
 * (spine §5 readings 179 and 211), or `undefined` before G2, on a run without UI, or for any other
 * role.
 */
const approvedDesign = (
  state: RunHandle["state"],
  step: Pick<StepSpec, "role">,
): { readonly design_direction?: string; readonly design_exit?: string } | undefined => {
  if (!state.run.has_ui || !DIRECTION_ROLES.has(step.role)) return undefined;
  if (["intake", "discover", "specify", "g1", "design", "g2"].includes(state.run.phase))
    return undefined;
  const approval = state.events.findLast(
    (e) =>
      e.type === "gate.approved" && ((e.data as { gates?: string[] }).gates ?? []).includes("G2"),
  );
  return approval?.data;
};

/**
 * `TaskPack.design_exit` (spine §5 reading 211, amending 179): `category_standard` when the human
 * took that exit at G2, for the same post-G2 UI roles {@link approvedDirection} serves, so they
 * can tell "build the category standard" from "no direction known".
 */
export const approvedDesignExit = (
  state: RunHandle["state"],
  step: Pick<StepSpec, "role">,
): "category_standard" | undefined =>
  approvedDesign(state, step)?.design_exit === "category_standard"
    ? "category_standard"
    : undefined;

/** The step's effective role contract, or `undefined` when the role or its mode is unknown. */
const effectiveContract = (k: Kernel, step: StepSpec): EffectiveRoleContract | undefined => {
  const contract = k.deps.roles.get(step.role);
  const effective = contract === undefined ? undefined : resolveRoleMode(contract, step.mode);
  return effective?.ok === true ? effective.contract : undefined;
};

/**
 * The dispatch prompt's account of the result fields (spine §5 reading 258): the values to copy,
 * the ones this dispatch does not have (`null`, never invented: the owner's first run returned a
 * task id on a task-less dispatch), and the artifact types and exits the role's contract allows,
 * which a host that loads no compiled agent learns nowhere else. The schema a headless run gets
 * (`roleResultSchemaFor`) says the same.
 */
export const resultFields = (
  step: Pick<StepSpec, "role" | "mode" | "task" | "feature" | "subject">,
  taskFeature: string | undefined,
  contract: EffectiveRoleContract | undefined,
): string => {
  const feature = step.task === undefined ? step.feature : taskFeature;
  const values: [string, string | undefined][] = [
    ["mode", step.mode],
    ["task", step.task],
    ["feature", feature],
  ];
  const named = values.filter(([, v]) => v !== undefined).map(([f, v]) => `${f} "${String(v)}"`);
  const none = values.filter(([, v]) => v === undefined).map(([f]) => f);
  const parts = [
    `role "${step.role}"`,
    ...named,
    ...(step.subject === undefined ? [] : [`verdict subject "${step.subject}"`]),
    ...(none.length === 0
      ? []
      : [
          `${none.join(", ")} null (this dispatch has no ${none.join(" or ")}; never take one from the repository)`,
        ]),
  ];
  if (contract !== undefined) {
    const types = contract.output.artifacts;
    parts.push(
      types.length === 0
        ? "no artifacts"
        : `artifacts of type ${types.map((t) => `"${t}"`).join(" or ")} only`,
      `exit ${contract.exits.map((e) => `"${e}"`).join(", ")}`,
    );
  }
  return parts.join("; ");
};

/**
 * How much to read (spine §5 reading 261). On the owner's first run a Codex BA spent ~390k input
 * tokens on a one-line quick fix: about 20k of host context, then whole source files (~40 KB per
 * read) that every later turn carried again, past its 60k-token context budget, and searches for
 * inputs no quick fix has (a research brief, a repo map) and for VTC's own files. The line names
 * the role's budget, that the pack lists every input there is, and how to read code; a task-less
 * SPECIFY step on a quick fix also hears that its spec is short.
 */
const readingLine = (k: Kernel, h: RunHandle, step: StepSpec): string => {
  const budget = k.deps.roles.get(step.role)?.budget.context_tokens;
  const quickSpec =
    step.task === undefined && h.state.run.track === "quick_fix" && h.state.run.phase === "specify";
  return [
    `Reading: keep your context under ${budget === undefined ? "what the work needs" : `${String(Math.round(budget / 1000))}k tokens`}.`,
    "Your pack lists every input there is: do not look for other inputs (a research brief, a repo map), other dispatches' packs or VTC's own files.",
    "Find code with `rg -n` and read only the line ranges you need, never whole large files.",
    "Cite files by their path relative to your working directory.",
    ...(quickSpec
      ? [
          "This is a quick fix: write a short specification, only the requirements the request asks for, and read code only to state today's behaviour.",
        ]
      : []),
  ].join(" ");
};

/** Renders the pack for a step and writes it under `.vtc/state/packs/` (AD-14 rule 5). */
const packFor = (k: Kernel, h: RunHandle, step: StepSpec, actionId: string): TaskPackInput => {
  const state = h.state;
  const task = step.task === undefined ? undefined : state.tasks.get(step.task);
  // the task an Architect triage step is about (§8.4): its requirements, not its worktree
  const about =
    task ?? (step.subject?.startsWith("T-") === true ? state.tasks.get(step.subject) : undefined);
  const items = frozenSpecItems(k.deps.repoRoot, state);
  const covers = about?.covers ?? [];
  const requirements =
    step.feature !== undefined && task === undefined
      ? items // Final Review checks the whole spec (§6.7a step 3)
      : items.filter((i) =>
          step.subject !== undefined && /^(REQ|SEC)-/.test(step.subject)
            ? i.id === step.subject || step.subject.startsWith(`${i.id}.`)
            : covers.some((c) => i.id === c || i.id.startsWith(`${c}.`)),
        );
  const gates = k.gatesConfig();
  const contract = k.deps.roles.get(step.role);
  const writeScope =
    step.role === "engineer"
      ? (task?.files_scope ?? [])
      : step.role === "qa" && step.mode === "author"
        ? [
            ...(gates?.tests.acceptance_globs ?? DEFAULT_ACCEPTANCE_GLOBS),
            `${HIDDEN_TESTS.stagingDir}/${step.task ?? ""}/**`,
          ]
        : // the mode's tools: security design writes the threat model, security verify nothing
          (effectiveContract(k, step)?.tools.write_paths ?? []);
  const inputs: TaskPackInput["inputs"] = [...(step.inputs ?? [])];
  const frontHalf = task === undefined && ["discover", "specify"].includes(state.run.phase);
  if (frontHalf) {
    inputs.push({ type: "request", path: `.vtc/runs/${state.id}/request.md` });
  } else if (state.automation !== null && step.role === "spec_verifier") {
    // an automatic run's issue is its spec: the Spec Verifier checks the work against it too
    // (AD-27 rule 2, D-cd), and only this input type tells it the run is automatic (reading
    // 212(16))
    inputs.push({
      type: PACK_INPUT_TYPES.automationIssue,
      path: `.vtc/runs/${state.id}/request.md`,
    });
  }
  // reading 262: the images the human attached to the request or a change request; reading 266:
  // past SPECIFY, a change request's images reach the role that owns the changed artifact
  for (const path of new Set([
    ...(frontHalf ? runAttachments(state) : []),
    ...ownedAttachments(state, step.role, step.task),
  ]))
    inputs.push({ type: PACK_INPUT_TYPES.attachments, path });
  if (task !== undefined && step.role === "engineer") {
    const qa = lastQaAuthor(state, task.id);
    for (const a of (
      state.events.find(
        (e) =>
          e.type === "role.submitted" &&
          (e.data as { action_id?: string }).action_id === qa?.action_id,
      )?.data as { artifacts?: { type: string; path: string }[] } | undefined
    )?.artifacts ?? []) {
      if (a.type === "acceptance_test") inputs.push({ type: a.type, path: a.path });
    }
  }
  for (const consumed of task?.consumes_contracts ?? [])
    inputs.push({ type: "interface_contract", path: consumed.path });
  // AD-14 rule 5: an input carries the type its producing role submitted it as, the type the
  // reading role's contract declares (a path prefix is only the fallback for an unknown path)
  const submitted = submittedArtifactTypes(state);
  if (task === undefined && ["specify", "design", "plan"].includes(state.run.phase)) {
    const effective = contract === undefined ? undefined : resolveRoleMode(contract, step.mode);
    const declared = effective?.ok === true ? effective.contract.inputs : [];
    // reading 269: a quick fix's spec is frozen only at its combined G1+G2 screen (§6.2), so its
    // DESIGN roles read the BA's submitted spec, which the frozen-artifact list below lacks
    const unfrozenSpec =
      state.run.phase === "design" &&
      state.run.track === "quick_fix" &&
      state.run.gates.G1.frozen.length === 0;
    for (const role of unfrozenSpec ? [...DISCOVER_ROLES, "ba"] : DISCOVER_ROLES) {
      for (const a of lastSubmittedArtifacts(state, role))
        if (declared.includes(a.type)) inputs.push({ type: a.type, path: a.path });
    }
  }
  for (const gate of state.run.gates.G1.frozen.concat(state.run.gates.G2.frozen)) {
    const type = submitted.get(gate.path) ?? frozenTypeByPath(gate.path);
    if (
      about !== undefined ||
      step.feature !== undefined ||
      state.run.phase === "plan" ||
      state.run.phase === "design"
    )
      inputs.push({ type, path: gate.path });
  }
  // reading 179: a post-G2 UI role judges against the direction the human approved
  const direction = approvedDirection(state, step);
  const designExit = approvedDesignExit(state, step);
  return {
    v: 1,
    run: state.id,
    action_id: actionId,
    role: step.role,
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    ...(step.task === undefined ? {} : { task: step.task }),
    ...(task === undefined
      ? step.feature === undefined
        ? {}
        : { feature: step.feature }
      : { feature: task.feature }),
    ...(step.subject === undefined ? {} : { subject: step.subject }),
    ...depthsFor(k, h, step),
    ...(direction === undefined ? {} : { design_direction: direction }),
    ...(designExit === undefined ? {} : { design_exit: designExit }),
    ...(about === undefined || state.intents.get(about.id) === undefined
      ? {}
      : { intent: state.intents.get(about.id) }),
    requirements,
    decisions: [],
    inputs,
    files_scope: writeScope,
    // reading 261: a task-less step (DISCOVER, SPECIFY, DESIGN, PLAN, a feature review, an
    // advisor) has no change of its own to check, so its pack carries no gate commands
    gates:
      task === undefined
        ? []
        : (gates?.gates ?? []).map((g) => ({ id: g.id, layer: g.layer, command: g.command })),
    findings: [...(step.findings ?? [])],
    ...(step.answer === undefined ? {} : { answer: step.answer }),
    ...(step.coverageGaps === undefined ? {} : { coverage_gaps: step.coverageGaps }),
  };
};

/**
 * The pinned editable section of a dispatch (AD-21 rules 1–2 and 6, readings 117–118 and 176), or
 * `null` for the compiled agent's own. The engine vouches for what it records: the agent must take
 * its editable section from the pack ({@link pinBlocker}: its manifest's `editable_in_pack`, or a
 * headless run on a host that does not load the compiled agent, reading 145) and its manifest's
 * `locked_sha256` must be the version's; the version must be for this role, mode and host; the
 * text, trimmed, must hash to the version's `editable_sha256` (the compiler's and Lookback's
 * section hash) and be a valid `TaskPack.role_heuristics` (no pack heading). Anything else, or a
 * selector that throws, runs the compiled default. A pin or canary for an agent that cannot take
 * one applies nothing and says why (reading 176). The effective SHA is the selector's (core holds
 * no locked text to hash).
 */
interface PinSelection {
  readonly pinned: PinnedPrompt | null;
  /** Why a selection was thrown away (an `incident.recorded` `prompt_selection`, reading 137). */
  readonly problem?: string;
}

const pinnedPrompt = (
  k: Kernel,
  target: PromptTarget,
  dispatch: "subagent" | "headless",
  /** A replay trial's arm (reading 176): selected by the trial, never by the pins. */
  arm?: PinnedPrompt,
  /**
   * The arm's own compiled plugin (D-cg, reading 201): the agent then runs this copy, so the arm
   * applies when the copy's prompt is exactly the arm's version (in place of {@link pinBlocker}
   * and the shipped manifest's locked core).
   */
  armPlugin?: ArmPlugin,
): PinSelection => {
  const pins: PromptPins | null = arm === undefined ? k.promptPins() : () => arm;
  if (pins === null) return { pinned: null };
  const parts = k.deps.plugins.promptParts?.(target.agent, target.host);
  // an arm plugin carries the arm's own section: no pack pin needs to reach the agent
  const blocker = armPlugin === undefined ? pinBlocker(parts, target.host, dispatch) : null;
  let pinned: PinnedPrompt | null;
  try {
    pinned = pins(target);
  } catch (error) {
    // the compiled default runs
    const why = error instanceof Error ? error.message : String(error);
    return { pinned: null, problem: `the prompt selector threw: ${why}` };
  }
  if (pinned === null) return { pinned: null };
  if (armPlugin === undefined && (blocker !== null || parts?.lockedSha256 === undefined))
    return {
      pinned: null,
      problem: `a ${pinned.canary === undefined ? "pin" : "canary"} names this role on ${target.host}, but ${blocker ?? "its manifest names no locked_sha256"}; nothing was applied and the compiled agent ran`,
    };
  const refused = (why: string): PinSelection => ({
    pinned: null,
    problem: `the selected prompt version was not used (${why}); the compiled default ran`,
  });
  const version = PromptVersionRefSchema.safeParse(pinned.version);
  if (!version.success) return refused("a malformed version");
  if (
    version.data.role !== target.role ||
    version.data.mode !== target.mode ||
    version.data.host !== target.host
  )
    return refused("a version of another role, mode or host");
  // an arm plugin is compiled from the shipped plugin: its locked core is the manifest's too
  if (
    (armPlugin === undefined || parts?.lockedSha256 !== undefined) &&
    version.data.locked_sha256 !== parts?.lockedSha256
  )
    return refused("a version of another locked core than the compiled agent's");
  if (armPlugin !== undefined && armPlugin.promptSha256 !== version.data.effective_sha256)
    return refused("an arm plugin whose agent prompt is not the version's");
  if (typeof pinned.text !== "string") return refused("no editable text");
  const text = pinned.text.trim();
  if (text === "" || sha256Hex(text) !== version.data.editable_sha256)
    return refused("text that is not the version's editable section");
  if (!TaskPackSchema.shape.role_heuristics.safeParse(text).success)
    return refused("text that is not a valid Role heuristics section");
  // a canary whose arm is not this version drops the arm, never the section: the dispatch is then
  // not in the canary
  if (pinned.canary === undefined) return { pinned: { version: version.data, text } };
  const canary = EVENT_PAYLOAD_SCHEMAS["lookback.canary_assigned"].safeParse(pinned.canary);
  if (canary.success && canary.data[canary.data.arm] === version.data.effective_sha256)
    return { pinned: { version: version.data, text, canary: canary.data } };
  return {
    pinned: { version: version.data, text },
    problem:
      "the canary arm the selector named is not the version it selected; the dispatch ran outside the canary",
  };
};

/**
 * The compiled locked core and default editable section of an agent, checked: the locked core must
 * hash to the manifest's `locked_sha256`, and the section must be a valid `Role heuristics` block.
 * `null` when the plugin does not carry both texts, or they do not check out.
 */
const compiledPrompt = (
  target: PromptTarget,
  parts: PromptParts | undefined,
): {
  readonly locked: string;
  /** What a headless run carries before its prompt: the compiled locked part, else the core. */
  readonly instructions: string;
  readonly pinned: PinnedPrompt;
} | null => {
  if (parts?.compiled === undefined) return null;
  const locked = parts.compiled.locked.trim();
  const text = parts.compiled.editable.trim();
  if (parts.lockedSha256 === undefined || sha256Hex(locked) !== parts.lockedSha256) return null;
  if (text === "" || !TaskPackSchema.shape.role_heuristics.safeParse(text).success) return null;
  return {
    locked,
    instructions: parts.compiled.headless ?? locked,
    pinned: {
      version: {
        role: target.role,
        ...(target.mode === undefined ? {} : { mode: target.mode }),
        host: target.host,
        locked_sha256: parts.lockedSha256,
        editable_sha256: sha256Hex(text),
        effective_sha256: effectivePromptSha(locked, text),
      },
      text,
    },
  };
};

/**
 * The compiled default editable section of an agent compiled without it (`editable_in_pack`,
 * reading 142), as the version Lookback's selector falls back to. `null` when the agent is not
 * switched, or its texts do not check out ({@link compiledPrompt}).
 */
const compiledDefaultPrompt = (k: Kernel, target: PromptTarget): PinnedPrompt | null => {
  const parts = k.deps.plugins.promptParts?.(target.agent, target.host);
  if (parts?.editableInPack !== true) return null;
  return compiledPrompt(target, parts)?.pinned ?? null;
};

/** An `incident.recorded` `prompt_selection` (reading 137): a selection the engine did not use. */
const recordPromptSelection = (
  k: Kernel,
  h: RunHandle,
  task: string | undefined,
  detail: string,
): void => {
  k.emit(h, {
    type: "incident.recorded",
    actor: "engine",
    ...(task === undefined ? {} : { task }),
    data: { kind: "prompt_selection", detail: detail.slice(0, 2000) },
  });
};

/**
 * A task's canary arm (AD-21 rule 7), logged once per (task, role) and canary, and sticky: a
 * later dispatch of the same canary in another arm (the pins changed under the task) runs outside
 * the canary, so no dispatch is counted in an arm its task was not assigned. Returns the arm the
 * dispatch records, or `undefined`.
 */
const assignCanary = (
  k: Kernel,
  h: RunHandle,
  task: string,
  role: string,
  canary: NonNullable<PinnedPrompt["canary"]>,
): NonNullable<PinnedPrompt["canary"]> | undefined => {
  const assigned = h.state.events.findLast(
    (e) =>
      e.type === "lookback.canary_assigned" &&
      e.task === task &&
      e.role === role &&
      (e.data as { candidate?: string }).candidate === canary.candidate &&
      (e.data as { baseline?: string }).baseline === canary.baseline,
  );
  if (assigned !== undefined) {
    if ((assigned.data as { arm?: string }).arm === canary.arm) return canary;
    recordPromptSelection(
      k,
      h,
      task,
      `the canary arm ${canary.arm} differs from the task's assigned arm; the dispatch ran outside the canary`,
    );
    return undefined;
  }
  k.emit(h, {
    type: "lookback.canary_assigned",
    actor: "engine",
    task,
    role,
    data: { arm: canary.arm, candidate: canary.candidate, baseline: canary.baseline },
  });
  return canary;
};

/**
 * Why a replay trial cannot run its arm now (reading 176), or `null`: the arm goes through the
 * same checks as a pin ({@link pinnedPrompt}) for the dispatch kind decided now, and anything but
 * that exact version applied (no pin can apply to the agent here, a locked core recompiled since,
 * a text that does not hash) refuses the trial, so no arm is ever measured with another's prompt.
 */
const replayArmRefusal = (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  host: HostId,
  dispatch: "subagent" | "headless",
  armPlugin?: ArmPlugin,
): string | null => {
  if (step.replay === undefined) return null;
  // D-cg (reading 201): a trial is an engine-launched headless run, never a Lead's subagent
  if (dispatch !== "headless") return "a lookback_replay trial runs only headless";
  const want = step.replay.prompt.version.effective_sha256;
  const selection = pinnedPrompt(
    k,
    {
      run: h.state.id,
      role: step.role,
      ...(step.mode === undefined ? {} : { mode: step.mode }),
      host,
      agent: agentNameFor(step.role, step.mode),
    },
    dispatch,
    step.replay.prompt,
    armPlugin,
  );
  if (selection.pinned?.version.effective_sha256 === want) return null;
  return `its arm's prompt version ${want.slice(0, 12)} cannot run as planned (${selection.problem ?? "no pin applies"}), and a trial never runs another arm's prompt`;
};

/**
 * A replay trial's own compiled plugin (D-cg, spine §5 reading 201), when its host's runs load the
 * compiled agent (Claude Code): `compileArm` writes a full copy of the plugin whose agent carries
 * the arm's editable section into a fresh directory under the engine's private area
 * (`armPluginDir`), which the trial runs with `--plugin-dir`. `undefined`: the host takes the arm
 * in the pack; a string: why no arm plugin could be made (the trial then measures nothing).
 */
const trialArmPlugin = async (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  host: HostId,
  dispatch: "subagent" | "headless",
): Promise<ArmPlugin | string | undefined> => {
  if (step.replay === undefined || dispatch !== "headless" || !HEADLESS_LOADS_AGENT[host])
    return undefined;
  const compiler = k.deps.armPlugins;
  if (compiler === undefined)
    return `no arm plugin compiler is wired (EngineDeps.armPlugins), so a ${host} trial cannot run its arm`;
  const trial = trialAtRef(k, h.state.id, step.replay);
  if (trial === undefined) return "the plan no longer has the trial";
  const outDir = armPluginDir(k, h.state.id, step.replay, trial.arm);
  try {
    // a directory a stopped engine left behind is not reused: the host loads it in place
    rmSync(outDir, { recursive: true, force: true });
    ensurePrivateDir(armPluginsRoot(k));
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    return await compiler.compileArm({
      host,
      agent: agentNameFor(step.role, step.mode),
      editable: step.replay.prompt.text,
      outDir,
    });
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true });
    return `its arm plugin could not be compiled: ${error instanceof Error ? error.message : String(error)}`;
  }
};

/** A replay trial's pack: the recorded one in this run, without its task or feature. */
const trialPack = (h: RunHandle, ref: ReplayStepRef, actionId: string): TaskPackInput => {
  const { task: _task, feature: _feature, role_heuristics: _heuristics, ...rest } = ref.pack;
  return { ...rest, run: h.state.id, action_id: actionId };
};

/**
 * Hands out one step: writes its pack (the pinned editable section first, AD-21), logs
 * `role.dispatched` (prompt version and the resolved model), returns the Lead action. `cwd` is
 * where the role works (its worktree).
 */
export const dispatchStep = (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  host: HostId,
  cwd: string,
  dispatch: "subagent" | "headless" = "subagent",
  armPlugin?: ArmPlugin,
): DispatchedStep => {
  const contract = k.deps.roles.get(step.role);
  if (contract === undefined) throw new EngineError("invalid", `no contract for role ${step.role}`);
  const actionId = nextActionId(h.state);
  const config = k.config();
  const route = stepRoute(k, h, step, host);
  const resolved = resolveModel(contract, host, config, {
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    tier: route.tier,
  });
  // D-cx (reading 244): a model the host refused runs on the host default, once, logged
  const fallback = modelFallbackFor(k, h, step, host, resolved.model);
  const model: ResolvedModel =
    fallback === undefined ? resolved : { tier: resolved.tier, effort: resolved.effort };
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  // §5.2a, spine §5 reading 38: an Engineer task runs as its discipline's compiled profile agent
  // when the host's plugin has one; the dispatched role stays `engineer` (the family shares the
  // Engineer's result contract) and the prompt SHA is the profile's (§13).
  const profile =
    step.role === "engineer" && task !== undefined
      ? k.deps.plugins.profileFor(host, task.discipline)
      : undefined;
  const agent = profile ?? agentNameFor(step.role, step.mode);
  const selection = pinnedPrompt(
    k,
    {
      run: h.state.id,
      role: step.role,
      ...(step.mode === undefined ? {} : { mode: step.mode }),
      host,
      agent,
      ...(step.task === undefined ? {} : { task: step.task }),
    },
    dispatch,
    step.replay?.prompt,
    armPlugin,
  );
  if (selection.problem !== undefined)
    recordPromptSelection(k, h, step.task, `${agent}: ${selection.problem}`);
  // no pin applies: an agent compiled without its editable section gets the compiled default in
  // the pack (reading 142), so it never runs without its heuristics
  const target: PromptTarget = {
    run: h.state.id,
    role: step.role,
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    host,
    agent,
  };
  // reading 145: a headless run on a host that cannot load the compiled agent carries the role
  // itself, its locked core before the prompt and its editable section in the pack (the default
  // when no pin applies), so it never runs without its role. A plugin without a manifest entry
  // for the agent (development) carries nothing; one whose texts do not check out fails the run.
  const parts =
    dispatch === "headless" && !HEADLESS_LOADS_AGENT[host]
      ? k.deps.plugins.promptParts?.(agent, host)
      : undefined;
  const core = parts === undefined ? undefined : compiledPrompt(target, parts);
  const pinned = selection.pinned ?? compiledDefaultPrompt(k, target) ?? core?.pinned ?? null;
  // AD-21 rule 2, reading 117: the pinned section is the pack's opening `Role heuristics` block;
  // a replay trial reads the recorded pack, run as a task-less role (reading 176)
  const packInput =
    step.replay === undefined ? packFor(k, h, step, actionId) : trialPack(h, step.replay, actionId);
  const pack = writeTaskPack(k.deps.repoRoot, {
    ...packInput,
    ...(pinned === null ? {} : { role_heuristics: pinned.text }),
  });
  // reading 266: the attachments the pack lists, in the role's worktree too, untracked
  placeAttachments(k.deps.repoRoot, cwd, packInput.inputs ?? []);
  const resume = step.resume !== undefined && step.resume.host === host ? step.resume : undefined;
  step.onDispatch?.();
  // a canary covers task dispatches only (its arm is sticky per task)
  const arm =
    pinned?.canary === undefined || step.task === undefined
      ? undefined
      : assignCanary(k, h, step.task, step.role, pinned.canary);
  // reading 177: a replay trial is marked in the log, so every reader can leave it out
  const trialRef =
    step.replay === undefined ? undefined : replayTrialRef(k, h.state.id, step.replay);
  k.emit(h, {
    type: "role.dispatched",
    actor: "engine",
    role: step.role,
    ...(step.task === undefined
      ? step.feature === undefined
        ? {}
        : { feature: step.feature }
      : { task: step.task, feature: task?.feature }),
    // AD-21 rule 1: with a pinned editable section the prompt version is the effective SHA
    prompt_sha: pinned?.version.effective_sha256 ?? k.deps.plugins.promptSha(agent, host),
    host,
    // D-ae: no resolved id means the host session's model, recorded as such
    model: model.model ?? SESSION_DEFAULT_MODEL,
    data: {
      action_id: actionId,
      ...(step.mode === undefined ? {} : { mode: step.mode }),
      ...(step.subject === undefined ? {} : { subject: step.subject }),
      dispatch,
      agent,
      pack,
      resume: resume ?? null,
      ...(pinned === null ? {} : { editable_sha256: pinned.version.editable_sha256 }),
      ...(arm === undefined ? {} : { canary_arm: arm.arm }),
      ...(trialRef === undefined ? {} : { purpose: "lookback_replay" as const, replay: trialRef }),
      // H-9, D-cm (reading 218 (6)): the tier and why, always together
      tier: route.tier,
      tier_reason: route.reason,
      tier_clamped: route.clamped,
      ...(fallback === undefined ? {} : { model_fallback: fallback }),
    },
  });
  const capabilities = k.deps.adapters[host]?.capabilities;
  // §5.3: the skills of the task's stack packs.
  const skills =
    task === undefined
      ? []
      : k.deps.plugins.skillsFor(host, [...task.stack_packs, task.discipline]);
  // reading 275: a headless run has no plugin skills (`codex exec` turns plugins off), so the
  // method skills its role's prompt names are written to the checkout and named here
  const roleText = (
    dispatch === "headless" ? (parts ?? k.deps.plugins.promptParts?.(agent, host)) : undefined
  )?.compiled;
  const methodSkills =
    roleText === undefined
      ? []
      : (k.deps.plugins.methodSkills?.(host, roleText.headless ?? roleText.locked) ?? []).map(
          (skill) =>
            `Skill \`${skill.name}\`: read ${join(k.deps.repoRoot, writeMethodSkill(k.deps.repoRoot, skill))} and the references it names`,
        );
  const prompt = [
    `VTC dispatch ${actionId}: you are ${agent} (${model.model === undefined ? "the session's model" : `model ${model.model}`}, effort ${model.effort}).`,
    `Work in: ${cwd}`,
    `Read your task pack: ${join(k.deps.repoRoot, pack)}`,
    ...(skills.length === 0 ? [] : [`Use these skills: ${skills.join(", ")}`]),
    ...methodSkills,
    readingLine(k, h, step),
    ...(step.note === undefined ? [] : [step.note]),
    `Finish with exactly one RoleResult JSON object as your final message: ${resultFields(step, task?.feature, effectiveContract(k, step))}. ${dispatch === "subagent" ? `The Lead submits it with action_id ${actionId}.` : `The engine records it as action ${actionId}.`}`,
  ].join("\n");
  const action: SpawnRoleAction = {
    type: "spawn_role",
    action_id: actionId,
    role: step.role,
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    ...(step.task === undefined ? {} : { task: step.task }),
    ...(task === undefined
      ? step.feature === undefined
        ? {}
        : { feature: step.feature }
      : { feature: task.feature }),
    ...(step.subject === undefined ? {} : { subject: step.subject }),
    pack,
    // AD-14 rule 1: the host's adapter adds its plugin namespace; the log keeps the base name
    agent: k.deps.adapters[host]?.subagentName?.(agent) ?? agent,
    prompt: prompt.slice(0, 8000),
    background: capabilities?.backgroundSubagents ?? false,
    ...(model.model === undefined ? {} : { model: model.model }),
    ...(resume === undefined ? {} : { resume }),
  };
  return {
    action,
    model,
    cwd,
    ...(core === undefined ? {} : { roleCore: core === null ? null : core.instructions }),
    ...(armPlugin === undefined ? {} : { pluginDir: armPlugin.dir }),
  };
};

/**
 * Host config in the worktree (D-ao, spine §5 reading 72): before every dispatch or resume there,
 * `.claude/**`, `.codex/**` and `.mcp.json` go back to the worktree's base commit, so nothing a
 * role wrote there reaches the next host start (on both hosts, whatever the dispatch mode). What
 * was restored is a `host_config_restored` incident with the paths as evidence. When the restore
 * fails the run pauses and nothing is dispatched.
 */
const guardHostConfig = async (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  where: { readonly path: string; readonly base: string },
): Promise<boolean> => {
  const who = `${step.role}${step.task === undefined ? "" : ` (${step.task})`}`;
  let restored: string[];
  try {
    restored = await restoreHostConfig(k.deps.repoRoot, where.path, where.base);
  } catch (error) {
    k.emit(h, {
      type: "run.paused",
      actor: "engine",
      data: {
        reason:
          `the engine could not check the host config in ${where.path} before dispatching ${who}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            300,
          ),
      },
    });
    return false;
  }
  if (restored.length === 0) return true;
  k.emit(h, {
    type: "incident.recorded",
    actor: "engine",
    ...(step.task === undefined ? {} : { task: step.task }),
    data: {
      kind: "host_config_restored",
      detail:
        `before dispatching ${who} in ${where.path}: ${restored.join(", ")} differed from the worktree's base ${where.base.slice(0, 12)} and were restored, so no host loads them`.slice(
          0,
          2000,
        ),
      evidence: restored.slice(0, 20).map((path) => ({
        type: "file" as const,
        ref: `${where.path}/${path}`,
      })),
    },
  });
  return true;
};

/**
 * Why the step may not run as a subagent of the Lead session, or `null` when it may
 * (`inSessionDispatchRefusal`; D-an, spine §5 readings 71 and 79): on Claude Code a code-running
 * role (`code_sandboxed`, it has a shell) needs the run's Lead session to report its OS sandbox
 * `on` (absent or `unknown` refuses); on Codex every role needs a platform where Codex's
 * network-off sandbox is shown to block a Unix-socket connect (`deps.platform`).
 */
export const inSessionRefusal = (
  k: Kernel,
  h: RunHandle,
  step: Pick<StepSpec, "role" | "mode">,
  host: HostId,
  call: CallContext,
): string | null => {
  const contract = k.deps.roles.get(step.role);
  const effective = contract === undefined ? undefined : resolveRoleMode(contract, step.mode);
  const profile =
    contract === undefined
      ? "read_only"
      : effective?.ok === true
        ? effective.contract.tools.profile
        : contract.tools.profile;
  return inSessionDispatchRefusal(
    host,
    profile,
    k.sessionSandboxFor(h.state.id, call),
    k.deps.platform ?? process.platform,
  );
};

/**
 * Why an in-session step with a shell waits (D-an): no session holds the run's Lead, and the
 * caller cannot (a cli connection, or a bridge session bound to a role action). Nothing parks:
 * the Lead's sandbox, not this caller's, decides once a Lead session calls `next`.
 */
export const NO_LEAD_WAIT_REASON =
  "no Lead session holds this run, so a role with a shell cannot be dispatched in-session yet: call next from the Lead session (the Claude Code or Codex session running the vtc plugin)";

/**
 * A step refused in-session (D-an): its task parks as `blocked` with the refusal's text
 * (`SESSION_SANDBOX_OFF_REASON` or `CODEX_IN_SESSION_REFUSED_REASON`; the escalation names the
 * fix, answering it retries the dispatch). A phase step opens the same escalation for its phase,
 * which holds the phase until it is answered.
 */
export const refuseInSession = (k: Kernel, h: RunHandle, step: StepSpec, reason: string): void => {
  // a replay trial that cannot run did not pass (reading 176): nothing to ask the human
  if (step.replay !== undefined) {
    refuseTrial(k, h, step.replay, reason);
    return;
  }
  if (step.task !== undefined) {
    parkTask(k, h, step.task, {
      reason: "blocked",
      detail: reason,
      evidence: [],
    });
    return;
  }
  const escalation = parkEscalation({
    id: nextEscalationId(h.state),
    run: h.state.id,
    phase: h.state.run.phase,
    reason: "blocked",
    detail: reason,
    evidence: [],
    blocks: [],
    now: k.now(),
  });
  k.emit(h, { type: "escalation.opened", actor: "engine", data: { escalation } });
};

/**
 * Records the dispatch (every role: the git baseline and the engine files, `dispatch-guard.ts`),
 * prepares a front-half role's or advisor's own worktree (spine §5 reading 21), restores the
 * worktree's host config (D-ao), and hands the step out. A worktree that cannot be made pauses
 * the run instead.
 */
export const dispatchGuarded = async (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  host: HostId,
): Promise<SpawnRoleAction | null> =>
  (await dispatchPrepared(k, h, step, host, "subagent"))?.action ?? null;

/** {@link dispatchGuarded} for either dispatch kind, with the model and working directory. */
export const dispatchPrepared = async (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  host: HostId,
  dispatch: "subagent" | "headless",
): Promise<DispatchedStep | null> => {
  const actionId = nextActionId(h.state);
  if (step.replay !== undefined) {
    const arm = await trialArmPlugin(k, h, step, host, dispatch);
    const refused =
      typeof arm === "string" ? arm : replayArmRefusal(k, h, step, host, dispatch, arm);
    if (refused !== null) {
      if (arm !== undefined && typeof arm !== "string")
        rmSync(arm.dir, { recursive: true, force: true });
      refuseTrial(k, h, step.replay, refused);
      return null;
    }
    const plugin = typeof arm === "string" ? undefined : arm;
    // a replay trial works in its own clean checkout at the recorded base (reading 176)
    const cwd = await prepareTrial(k, h, step.replay, actionId);
    if (cwd === null) {
      if (plugin !== undefined) rmSync(plugin.dir, { recursive: true, force: true });
      return null;
    }
    recordDispatch(k, h.state.id, actionId);
    return dispatchStep(k, h, step, host, cwd, dispatch, plugin);
  }
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  let worktree: DispatchRecord["worktree"];
  if (task === undefined) {
    try {
      // a Final Review reviewer reads the feature's integrated branch (§6.7a)
      const feature = step.feature === undefined ? undefined : h.state.features.get(step.feature);
      const at =
        feature === undefined
          ? undefined
          : await k.deps.workspace.resolve(feature.integration_branch);
      worktree = await prepareRoleWorktree(k, h.state.id, actionId, at);
    } catch (error) {
      k.emit(h, {
        type: "run.paused",
        actor: "engine",
        data: {
          reason:
            `the engine could not prepare ${step.role}'s worktree: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              300,
            ),
        },
      });
      return null;
    }
  }
  const where =
    worktree ??
    (task?.worktree === undefined || task.baseline_revision === undefined
      ? undefined
      : { path: task.worktree, base: task.baseline_revision });
  if (where !== undefined && !(await guardHostConfig(k, h, step, where))) return null;
  recordDispatch(k, h.state.id, actionId, worktree);
  const cwd =
    worktree !== undefined
      ? join(k.deps.repoRoot, worktree.path)
      : task?.worktree === undefined
        ? k.deps.repoRoot
        : join(k.deps.repoRoot, task.worktree);
  return dispatchStep(k, h, step, host, cwd, dispatch);
};
