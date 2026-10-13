/**
 * The flow composer's dispatch side (§4.2 step 1, §6.3; AD-4 rules 1 and 4, AD-17): which role
 * runs the engine wants now, and the `spawn_role` actions the Lead performs for them. Every
 * dispatch is a `role.dispatched` event with its pack, model and prompt version, so `submit` can
 * reject anything the engine did not ask for.
 */
import { join } from "node:path";
import {
  agentNameFor,
  HIDDEN_TESTS,
  planDispatch,
  type EscalationAnswer,
  type Finding,
  type HostId,
  type LeadAction,
  type ModelTier,
  type Phase,
  type SessionRef,
  type TaskPackInput,
} from "@vtc/shared";
import { budgetState, sharesExceeded } from "./budget.js";
import { DEFAULT_ACCEPTANCE_GLOBS } from "./config.js";
import { EngineError, type CallContext, type Kernel, type RunHandle } from "./kernel.js";
import { engineerDispatch, tierDown } from "./loop.js";
import { writeTaskPack } from "./projections.js";
import {
  inFlight,
  lastBuilt,
  lastQaAuthor,
  lastSubmitted,
  nextActionId,
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
import { reviewersFor } from "./router.js";
import { limitWait } from "./limits.js";
import { setTaskStatus } from "./parking.js";
import { checkGitNow, sweepCheckouts } from "./checkout-guard.js";
import { CLARIFIER_OF, openGaps } from "./clarify.js";
import {
  recordCheckout,
  runsInCheckout,
  saveCheckoutRecord,
  type CheckoutRecord,
} from "./phase-scope.js";

export interface StepSpec {
  readonly key: string;
  readonly role: string;
  readonly mode?: string;
  readonly task?: string;
  readonly subject?: string;
  readonly tier?: ModelTier;
  readonly resume?: SessionRef;
  readonly findings?: readonly Finding[];
  readonly answer?: EscalationAnswer;
  readonly note?: string;
  /** Engine transition that happens as the step is handed out (e.g. → building). */
  readonly onDispatch?: () => void;
}

/** Front-half roles per phase (§6.1). The deeper front half is sub-project 4. */
export const phaseRoles = (h: RunHandle, phase: Phase): { role: string; mode?: string }[] => {
  const run = h.state.run;
  switch (phase) {
    case "discover":
      return run.track === "quick_fix"
        ? []
        : [{ role: run.repo === "existing" ? "repo_cartographer" : "research_analyst" }];
    case "specify":
      return [{ role: "ba" }];
    case "design":
      return [{ role: "architect" }, ...(run.has_ui ? [{ role: "designer" }] : [])];
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
  return `Your previous result was rejected (${last.rejection.reason}): ${last.rejection.issues.join("; ")}`;
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

/** Steps of one task that need a role run now. */
const taskSteps = (k: Kernel, h: RunHandle, taskId: string, host: HostId): StepSpec[] => {
  const task = h.state.tasks.get(taskId);
  if (task?.worktree === undefined) return [];
  const steps: StepSpec[] = [];
  if (task.status === "ready") {
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
      steps.push({ key: `qa:${taskId}`, ...step, ...(note === undefined ? {} : { note }) });
    }
    return steps;
  }
  if (task.status === "tests_authored" || task.status === "building" || task.status === "fixing") {
    if (
      busyStep(h, { role: "engineer", task: taskId }) ||
      busyStep(h, { role: "qa", mode: "author", task: taskId })
    )
      return [];
    // A spec or design gap is answered first, by the BA or the Designer (§6.3 steps 3 and 8).
    const gaps = openGaps(h.state, taskId);
    const first = gaps[0];
    const clarifier = first === undefined ? undefined : CLARIFIER_OF[first.route];
    if (clarifier !== undefined) {
      const step = { role: clarifier, task: taskId };
      if (busyStep(h, step)) return [];
      const answer = freshAnswer(h, taskId, lastDispatchSeq(h, taskId, clarifier));
      const note = [
        rejectionNote(h, step),
        clarifier === "ba"
          ? "Answer the spec gap(s) in your pack's findings for this task. A wording-only fix of the frozen spec (no requirement or acceptance criterion added, removed or renamed): edit it and exit done. A change in meaning: write it into the spec and exit spec_conflict; it goes to the human as a change request. If the spec already answers it, exit done and say how in your summary."
          : "Answer the design gap(s) in your pack's findings for this task. Additions outside the frozen design artifacts: exit done. A change to a frozen design artifact goes to the human as a change request: write it and exit spec_conflict.",
      ]
        .filter((n) => n !== undefined)
        .join("\n");
      steps.push({
        key: `clarify:${taskId}`,
        ...step,
        findings: gaps.filter((f) => CLARIFIER_OF[f.route] === clarifier),
        note,
        ...(answer === undefined ? {} : { answer }),
      });
      return steps;
    }
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
    if (roundVerdict(h.state, taskId)?.verdict !== "pass") return [];
    // At 70% of the budget, or once the reviewers used their 25% share, they drop a tier (§11).
    const drop =
      budgetState(task.spent_usd, task.budget_usd) === "reviewers_drop" ||
      sharesExceeded(shareSpend(h.state, taskId), task.budget_usd).reviewers;
    for (const slot of reviewersFor(
      task,
      h.state.run,
      taskAcceptanceCriteria(k.deps.repoRoot, h.state, taskId),
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
        if (busyStep(h, filter)) continue;
        if (lastSubmitted(h.state, filter, built.closedSeq ?? 0) !== undefined) continue;
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
  const phaseRoleList = phaseRoles(h, phase);
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
  return planOrder(state).flatMap((task) => taskSteps(k, h, task.id, host));
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

/** Renders the pack for a step and writes it under `.vtc/state/packs/` (AD-14 rule 5). */
const packFor = (k: Kernel, h: RunHandle, step: StepSpec, actionId: string): TaskPackInput => {
  const state = h.state;
  const task = step.task === undefined ? undefined : state.tasks.get(step.task);
  const items = frozenSpecItems(k.deps.repoRoot, state);
  const covers = task?.covers ?? [];
  const requirements = items.filter((i) =>
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
  const inputs: TaskPackInput["inputs"] = [];
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
  for (const gate of state.run.gates.G1.frozen.concat(state.run.gates.G2.frozen)) {
    const type = gate.path.startsWith(".vtc/spec/")
      ? "spec"
      : gate.path.startsWith(".vtc/architecture/")
        ? "architecture"
        : "design";
    if (task !== undefined || state.run.phase === "plan" || state.run.phase === "design")
      inputs.push({ type, path: gate.path });
  }
  return {
    v: 1,
    run: state.id,
    action_id: actionId,
    role: step.role,
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    ...(step.task === undefined ? {} : { task: step.task }),
    ...(task === undefined ? {} : { feature: task.feature }),
    ...(step.subject === undefined ? {} : { subject: step.subject }),
    ...(step.task === undefined || state.intents.get(step.task) === undefined
      ? {}
      : { intent: state.intents.get(step.task) }),
    requirements,
    decisions: [],
    inputs,
    files_scope: writeScope,
    gates: (gates?.gates ?? []).map((g) => ({ id: g.id, layer: g.layer, command: g.command })),
    findings: [...(step.findings ?? [])],
    ...(step.answer === undefined ? {} : { answer: step.answer }),
  };
};

/** Hands out one step: writes its pack, logs `role.dispatched`, returns the Lead action. */
export const dispatchStep = (k: Kernel, h: RunHandle, step: StepSpec, host: HostId): LeadAction => {
  const contract = k.deps.roles.get(step.role);
  if (contract === undefined) throw new EngineError("invalid", `no contract for role ${step.role}`);
  const actionId = nextActionId(h.state);
  const config = k.config();
  const model = resolveModel(contract, host, config, {
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    ...(step.tier === undefined ? {} : { tier: step.tier }),
  });
  const agent = agentNameFor(step.role, step.mode);
  const pack = writeTaskPack(k.deps.repoRoot, packFor(k, h, step, actionId));
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  const cwd =
    task?.worktree === undefined || runsInCheckout(step.role)
      ? k.deps.repoRoot
      : join(k.deps.repoRoot, task.worktree);
  const resume = step.resume !== undefined && step.resume.host === host ? step.resume : undefined;
  step.onDispatch?.();
  k.emit(h, {
    type: "role.dispatched",
    actor: "engine",
    role: step.role,
    ...(step.task === undefined ? {} : { task: step.task, feature: task?.feature }),
    prompt_sha: k.deps.promptSha(agent, host),
    host,
    model: model.model,
    data: {
      action_id: actionId,
      ...(step.mode === undefined ? {} : { mode: step.mode }),
      ...(step.subject === undefined ? {} : { subject: step.subject }),
      dispatch: "subagent",
      agent,
      pack,
      resume: resume ?? null,
    },
  });
  const capabilities = k.deps.adapters[host]?.capabilities;
  const prompt = [
    `VTC dispatch ${actionId}: you are ${agent} (model ${model.model}, effort ${model.effort}).`,
    `Work in: ${cwd}`,
    `Read your task pack: ${join(k.deps.repoRoot, pack)}`,
    ...(step.note === undefined ? [] : [step.note]),
    `Finish with exactly one RoleResult JSON object as your final message (role "${step.role}"${step.mode === undefined ? "" : `, mode "${step.mode}"`}${step.task === undefined ? "" : `, task "${step.task}"`}${step.subject === undefined ? "" : `, verdict subject "${step.subject}"`}). The Lead submits it with action_id ${actionId}.`,
  ].join("\n");
  return {
    type: "spawn_role",
    action_id: actionId,
    role: step.role,
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    ...(step.task === undefined ? {} : { task: step.task }),
    ...(task === undefined ? {} : { feature: task.feature }),
    ...(step.subject === undefined ? {} : { subject: step.subject }),
    pack,
    agent,
    prompt: prompt.slice(0, 8000),
    background: capabilities?.backgroundSubagents ?? false,
    ...(resume === undefined ? {} : { resume }),
  };
};

/**
 * New role runs for the Lead, within the concurrency limit (reviewers count, §6.6). In plugin-only
 * mode every role run is a Lead subagent; the engine never starts a headless run (AD-17). Headless
 * launches are not part of this engine yet: on a host that cannot run role subagents the run
 * pauses with the reason instead of waiting silently forever.
 */
export const dispatchNow = async (
  k: Kernel,
  h: RunHandle,
  call: CallContext,
): Promise<LeadAction[]> => {
  if (h.state.run.paused || h.state.run.finished_at !== undefined) return [];
  // Runs that ended without a check (a failure, a limit, a restart) are checked before a new
  // baseline is recorded; a git change made while a role runs stops everything (AD-7 rule 7).
  if ((await sweepCheckouts(k, h)).issues.length > 0 || checkGitNow(k, h)) return [];
  if (limitWait(k, h) !== null) return [];
  const host = k.hostFor(call);
  const config = k.config();
  const capabilities = k.deps.adapters[host]?.capabilities ?? { subagents: true, headless: false };
  const plan = planDispatch("role", config.hosts.dispatch, capabilities);
  if (plan !== "subagent") {
    if (pendingSteps(k, h, host).length > 0) {
      k.emit(h, {
        type: "run.paused",
        actor: "engine",
        data: {
          reason:
            plan === "headless"
              ? `${host} has no role subagents and this engine does not launch headless runs yet; run the Lead on a host with subagents, then vtc resume`
              : `${host} cannot run roles (no subagents; hosts.dispatch ${config.hosts.dispatch}); run the Lead on a host with subagents, then vtc resume`,
        },
      });
    }
    return [];
  }
  const actions: LeadAction[] = [];
  let free = config.concurrency - inFlight(h.state).length;
  // Checkout roles write in the user's checkout: record it before the Lead can start one, so
  // every write can be verified when the run ends (AD-7 rule 7).
  let checkout: CheckoutRecord | undefined;
  for (const step of pendingSteps(k, h, host)) {
    if (free <= 0) break;
    const inCheckout = runsInCheckout(step.role);
    if (inCheckout) checkout ??= await recordCheckout(k.deps.repoRoot);
    const action = dispatchStep(k, h, step, host);
    if (inCheckout && checkout !== undefined && action.type === "spawn_role") {
      // A BA answering a task's gap: the spec's ids now, to tell wording from meaning (§6.2).
      const record =
        step.role === "ba" && step.task !== undefined
          ? {
              ...checkout,
              spec_ids: frozenSpecItems(k.deps.repoRoot, h.state).map((i) => i.id),
            }
          : checkout;
      saveCheckoutRecord(k.deps.repoRoot, k.checkouts, action.action_id, record);
    }
    actions.push(action);
    free -= 1;
  }
  return actions;
};
