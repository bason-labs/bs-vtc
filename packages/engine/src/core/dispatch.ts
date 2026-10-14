/**
 * The flow composer's dispatch side (§4.2 step 1, §6.3; AD-4 rules 1 and 4, AD-17): which role
 * runs the engine wants now, and the `spawn_role` actions the Lead performs for them. Every
 * dispatch is a `role.dispatched` event with its pack, model and prompt version, so `submit` can
 * reject anything the engine did not ask for.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  agentNameFor,
  HIDDEN_TESTS,
  inSessionDispatchRefusal,
  PACK_INPUT_TYPES,
  PromptVersionRefSchema,
  resolveRoleMode,
  SESSION_DEFAULT_MODEL,
  Sha256HexSchema,
  type ArtifactRef,
  type Escalation,
  type EscalationAnswer,
  type Finding,
  type HostId,
  type ModelTier,
  type Phase,
  type ResolvedModel,
  type SessionRef,
  type SpawnRoleAction,
  type TaskPackInput,
} from "@vtc/shared";
import { restoreHostConfig } from "../git/index.js";
import { budgetState, sharesExceeded } from "./budget.js";
import { DEFAULT_ACCEPTANCE_GLOBS } from "./config.js";
import {
  EngineError,
  type CallContext,
  type Kernel,
  type PinnedPrompt,
  type PromptTarget,
  type RunHandle,
} from "./kernel.js";
import { finalReviewSteps } from "./final-review.js";
import { effectiveVerdict } from "./gate-verdict.js";
import { engineerDispatch, tierDown } from "./loop.js";
import { writeTaskPack } from "./projections.js";
import {
  inFlight,
  lastBuilt,
  lastQaAuthor,
  lastSubmitted,
  nextActionId,
  nextEscalationId,
  shareSpend,
  pendingBaseCheck,
  phaseEnteredSeq,
  roundVerdict,
  planOrder,
  runsOf,
  statusEnteredSeq,
  taskFindings,
} from "./queries.js";
import { frozenSpecItems, taskAcceptanceCriteria } from "./read-model.js";
import { resolveModel, roleTier } from "./roles.js";
import { crossFamilyHost } from "./cross-family.js";
import { installedLensRoles, reviewersFor, slotMatches } from "./router.js";
import { parkTask, setTaskStatus } from "./parking.js";
import { parkEscalation } from "./escalations.js";
import { recordDispatch, type DispatchRecord } from "./dispatch-guard.js";
import { architectDepth, dealDesignConstraints, researchDepth } from "./lottery.js";
import { prepareRoleWorktree } from "./role-worktree.js";

/** A handed-out step: the Lead's action, and what an engine-launched run of it needs. */
export interface DispatchedStep {
  readonly action: SpawnRoleAction;
  readonly model: ResolvedModel;
  /** Absolute directory the role works in. */
  readonly cwd: string;
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
  readonly tier?: ModelTier;
  readonly resume?: SessionRef;
  readonly findings?: readonly Finding[];
  readonly answer?: EscalationAnswer;
  readonly note?: string;
  /** Extra pack inputs (an advisor's, `consult`). */
  readonly inputs?: readonly ArtifactRef[];
  /** Engine transition that happens as the step is handed out (e.g. → building). */
  readonly onDispatch?: () => void;
}

/**
 * Whether the run has Security's design mode (§5.2, §6.1 DESIGN; spine §5 reading 37): the
 * installed Security contract declares it. Without it DESIGN runs without a threat model step.
 */
const securityDesign = (k: Kernel): boolean =>
  k.deps.roles.get("security")?.modes?.design !== undefined;

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
      // §6.1: Architect, Security's threat model and the Designer (with UI) run in parallel
      return [
        { role: "architect" },
        ...(securityDesign(k) ? [{ role: "security", mode: "design" }] : []),
        ...(run.has_ui ? [{ role: "designer" }] : []),
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
        ...(note === undefined ? {} : { note }),
        ...(answer === undefined ? {} : { answer }),
      });
    }
    return steps;
  }
  if (task.status === "tests_authored" || task.status === "building" || task.status === "fixing") {
    if (
      busyStep(h, { role: "engineer", task: taskId }) ||
      busyStep(h, { role: "qa", mode: "author", task: taskId })
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
      steps.push({
        key: `qa-fix:${taskId}`,
        role: "qa",
        mode: "author",
        task: taskId,
        findings: badTests,
      });
      return steps;
    }
    const round = task.status === "tests_authored" ? 1 : Math.max(1, task.round);
    const contract = k.deps.roles.get("engineer");
    const baseTier = contract === undefined ? "mid" : roleTier(contract, host);
    const plan = engineerDispatch(baseTier, round);
    const resume =
      interruptedSession(h, { role: "engineer", task: taskId }) ??
      (plan.freshSession || round === 1 ? undefined : task.session_ref);
    const answer = freshAnswer(h, taskId, lastDispatchSeq(h, taskId, "engineer"));
    const note = rejectionNote(h, { role: "engineer", task: taskId });
    steps.push({
      key: `engineer:${taskId}`,
      role: "engineer",
      task: taskId,
      tier: plan.tier,
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
    for (const slot of reviewersFor(
      task,
      h.state.run,
      taskAcceptanceCriteria(k.deps.repoRoot, h.state, taskId),
      { lensRoles: installedLensRoles(k.deps.roles), crossFamily: cross !== undefined },
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
      const contract = k.deps.roles.get(slot.role);
      const tier =
        contract !== undefined && drop ? tierDown(roleTier(contract, host, slot.mode)) : undefined;
      const note = rejectionNote(h, filter);
      steps.push({
        key: `review:${taskId}:${slot.id}`,
        ...filter,
        ...(tier === undefined ? {} : { tier }),
        ...(note === undefined ? {} : { note }),
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
  const phaseRoleList = phaseRoles(k, h, phase);
  if (phaseRoleList.length > 0) {
    const entered = phaseEnteredSeq(state, phase) ?? 0;
    const blocked = [...state.escalations.values()].some(
      (e) => e.phase === phase && e.answer === undefined,
    );
    if (blocked) return [];
    return phaseRoleList.flatMap(({ role, mode }) => {
      const filter = { role, ...(mode === undefined ? {} : { mode }) };
      if (busyStep(h, filter)) return [];
      const done = lastSubmitted(state, filter, entered);
      if (done !== undefined && done.exit === "done") return [];
      const note = rejectionNote(h, filter);
      const decision = [...state.events]
        .reverse()
        .find((e) => e.type === "gate.rejected" || e.type === "gate.approved");
      const gateNote =
        decision?.type === "gate.rejected"
          ? `The human rejected the gate${(decision.data as { note?: string }).note === undefined ? "." : `: ${(decision.data as { note?: string }).note ?? ""}`}`
          : undefined;
      const combined = [note, gateNote].filter((n) => n !== undefined).join("\n");
      const answer = phaseAnswer(h, phase, role);
      return [
        {
          key: `phase:${role}`,
          ...filter,
          ...(combined === "" ? {} : { note: combined }),
          ...(answer === undefined ? {} : { answer }),
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

/** The answer to the latest run-scoped escalation of `phase` given after the role's last dispatch. */
const phaseAnswer = (h: RunHandle, phase: Phase, role: string): EscalationAnswer | undefined => {
  const since = [...h.state.roleRuns.values()]
    .filter((r) => r.role === role && r.task === undefined)
    .reduce((max, r) => Math.max(max, r.seq), 0);
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
        : (contract?.tools.write_paths ?? []);
  const inputs: TaskPackInput["inputs"] = [...(step.inputs ?? [])];
  if (task === undefined && ["discover", "specify"].includes(state.run.phase)) {
    inputs.push({ type: "request", path: `.vtc/runs/${state.id}/request.md` });
  }
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
    for (const role of DISCOVER_ROLES) {
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
    ...(about === undefined || state.intents.get(about.id) === undefined
      ? {}
      : { intent: state.intents.get(about.id) }),
    requirements,
    decisions: [],
    inputs,
    files_scope: writeScope,
    gates: (gates?.gates ?? []).map((g) => ({ id: g.id, layer: g.layer, command: g.command })),
    findings: [...(step.findings ?? [])],
    ...(step.answer === undefined ? {} : { answer: step.answer }),
  };
};

/**
 * The pinned editable section of a dispatch (AD-21 rules 1–2), or `null` for the compiled agent's
 * own: no selector wired, or a selection that is not for this role, mode and host, is malformed,
 * has no text, or could not be made. A selection the engine cannot vouch for is never recorded
 * as a prompt version (AD-21: no ambiguous prompt identity).
 */
const PinnedCanarySchema = z.strictObject({
  arm: z.enum(["candidate", "baseline"]),
  candidate: Sha256HexSchema,
  baseline: Sha256HexSchema,
});

const pinnedPrompt = (k: Kernel, target: PromptTarget): PinnedPrompt | null => {
  const pins = k.promptPins();
  if (pins === null) return null;
  let pinned: PinnedPrompt | null;
  try {
    pinned = pins(target);
  } catch {
    return null;
  }
  if (pinned === null) return null;
  const version = PromptVersionRefSchema.safeParse(pinned.version);
  if (
    !version.success ||
    version.data.role !== target.role ||
    version.data.mode !== target.mode ||
    version.data.host !== target.host ||
    typeof pinned.text !== "string" ||
    pinned.text.trim() === ""
  )
    return null;
  // a malformed canary drops the arm, never the section: the dispatch is then not in the canary
  const canary = PinnedCanarySchema.safeParse(pinned.canary);
  const arm = canary.success ? canary.data : undefined;
  return {
    version: version.data,
    text: pinned.text,
    ...(arm === undefined ? {} : { canary: arm }),
  };
};

/** A task's canary arm, logged once per (task, role): sticky across its fix rounds (AD-21 rule 7). */
const assignCanary = (
  k: Kernel,
  h: RunHandle,
  task: string,
  role: string,
  canary: NonNullable<PinnedPrompt["canary"]>,
): void => {
  if (
    h.state.events.some(
      (e) => e.type === "lookback.canary_assigned" && e.task === task && e.role === role,
    )
  )
    return;
  k.emit(h, {
    type: "lookback.canary_assigned",
    actor: "engine",
    task,
    role,
    data: { arm: canary.arm, candidate: canary.candidate, baseline: canary.baseline },
  });
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
): DispatchedStep => {
  const contract = k.deps.roles.get(step.role);
  if (contract === undefined) throw new EngineError("invalid", `no contract for role ${step.role}`);
  const actionId = nextActionId(h.state);
  const config = k.config();
  const model = resolveModel(contract, host, config, {
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    ...(step.tier === undefined ? {} : { tier: step.tier }),
  });
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  // §5.2a, spine §5 reading 38: an Engineer task runs as its discipline's compiled profile agent
  // when the host's plugin has one; the dispatched role stays `engineer` (the family shares the
  // Engineer's result contract) and the prompt SHA is the profile's (§13).
  const profile =
    step.role === "engineer" && task !== undefined
      ? k.deps.plugins.profileFor(host, task.discipline)
      : undefined;
  const agent = profile ?? agentNameFor(step.role, step.mode);
  const pinned = pinnedPrompt(k, {
    run: h.state.id,
    role: step.role,
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    host,
    agent,
    ...(step.task === undefined ? {} : { task: step.task }),
  });
  const pack = writeTaskPack(
    k.deps.repoRoot,
    packFor(k, h, step, actionId),
    pinned === null
      ? undefined
      : { text: pinned.text, effective_sha256: pinned.version.effective_sha256 },
  );
  const resume = step.resume !== undefined && step.resume.host === host ? step.resume : undefined;
  step.onDispatch?.();
  if (pinned?.canary !== undefined && step.task !== undefined)
    assignCanary(k, h, step.task, step.role, pinned.canary);
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
      ...(pinned?.canary === undefined ? {} : { canary_arm: pinned.canary.arm }),
    },
  });
  const capabilities = k.deps.adapters[host]?.capabilities;
  // §5.3: the skills of the task's stack packs.
  const skills =
    task === undefined
      ? []
      : k.deps.plugins.skillsFor(host, [...task.stack_packs, task.discipline]);
  const prompt = [
    `VTC dispatch ${actionId}: you are ${agent} (${model.model === undefined ? "the session's model" : `model ${model.model}`}, effort ${model.effort}).`,
    `Work in: ${cwd}`,
    `Read your task pack: ${join(k.deps.repoRoot, pack)}`,
    ...(skills.length === 0 ? [] : [`Use these skills: ${skills.join(", ")}`]),
    ...(step.note === undefined ? [] : [step.note]),
    `Finish with exactly one RoleResult JSON object as your final message (role "${step.role}"${step.mode === undefined ? "" : `, mode "${step.mode}"`}${step.task === undefined ? "" : `, task "${step.task}"`}${step.task === undefined && step.feature !== undefined ? `, feature "${step.feature}"` : ""}${step.subject === undefined ? "" : `, verdict subject "${step.subject}"`}). ${dispatch === "subagent" ? `The Lead submits it with action_id ${actionId}.` : `The engine records it as action ${actionId}.`}`,
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
  return { action, model, cwd };
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
