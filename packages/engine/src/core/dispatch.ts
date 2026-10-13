/**
 * The flow composer's dispatch side (§4.2 step 1, §6.3; AD-4 rules 1 and 4, AD-17): which role
 * runs the engine wants now, and the `spawn_role` actions the Lead performs for them. Every
 * dispatch is a `role.dispatched` event with its pack, model and prompt version, so `submit` can
 * reject anything the engine did not ask for.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentNameFor,
  HIDDEN_TESTS,
  inSessionDispatchRefusal,
  PACK_INPUT_TYPES,
  planDispatch,
  resolveRoleMode,
  SESSION_DEFAULT_MODEL,
  type ArtifactRef,
  type EscalationAnswer,
  type Finding,
  type HostId,
  type LeadAction,
  type ModelTier,
  type Phase,
  type SessionRef,
  type SpawnRoleAction,
  type TaskPackInput,
} from "@vtc/shared";
import { restoreHostConfig } from "../git/index.js";
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
import { reviewersFor } from "./router.js";
import { limitWait } from "./limits.js";
import { parkTask, setTaskStatus } from "./parking.js";
import { parkEscalation } from "./escalations.js";
import {
  checkGitNow,
  recordDispatch,
  sweepDispatches,
  type DispatchRecord,
} from "./dispatch-guard.js";
import { architectDepth, dealDesignConstraints, researchDepth } from "./lottery.js";
import { prepareRoleWorktree } from "./role-worktree.js";

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
  /** Extra pack inputs (an advisor's, `consult`). */
  readonly inputs?: readonly ArtifactRef[];
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
  if (step.task !== undefined) return {};
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
    ...depthsFor(k, h, step),
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

/**
 * Hands out one step: writes its pack, logs `role.dispatched` (prompt SHA and the resolved
 * model), returns the Lead action. `cwd` is where the role works (its worktree).
 */
export const dispatchStep = (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  host: HostId,
  cwd: string,
): SpawnRoleAction => {
  const contract = k.deps.roles.get(step.role);
  if (contract === undefined) throw new EngineError("invalid", `no contract for role ${step.role}`);
  const actionId = nextActionId(h.state);
  const config = k.config();
  const model = resolveModel(contract, host, config, {
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    ...(step.tier === undefined ? {} : { tier: step.tier }),
  });
  const pack = writeTaskPack(k.deps.repoRoot, packFor(k, h, step, actionId));
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  // §5.2a, spine §5 reading 38: an Engineer task runs as its discipline's compiled profile agent
  // when the host's plugin has one; the dispatched role stays `engineer` (the family shares the
  // Engineer's result contract) and the prompt SHA is the profile's (§13).
  const profile =
    step.role === "engineer" && task !== undefined
      ? k.deps.plugins.profileFor(host, task.discipline)
      : undefined;
  const agent = profile ?? agentNameFor(step.role, step.mode);
  const resume = step.resume !== undefined && step.resume.host === host ? step.resume : undefined;
  step.onDispatch?.();
  k.emit(h, {
    type: "role.dispatched",
    actor: "engine",
    role: step.role,
    ...(step.task === undefined ? {} : { task: step.task, feature: task?.feature }),
    prompt_sha: k.deps.plugins.promptSha(agent, host),
    host,
    // D-ae: no resolved id means the host session's model, recorded as such
    model: model.model ?? SESSION_DEFAULT_MODEL,
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
    // AD-14 rule 1: the host's adapter adds its plugin namespace; the log keeps the base name
    agent: k.deps.adapters[host]?.subagentName?.(agent) ?? agent,
    prompt: prompt.slice(0, 8000),
    background: capabilities?.backgroundSubagents ?? false,
    ...(model.model === undefined ? {} : { model: model.model }),
    ...(resume === undefined ? {} : { resume }),
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
const refuseInSession = (k: Kernel, h: RunHandle, step: StepSpec, reason: string): void => {
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
): Promise<SpawnRoleAction | null> => {
  const actionId = nextActionId(h.state);
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  let worktree: DispatchRecord["worktree"];
  if (task === undefined) {
    try {
      worktree = await prepareRoleWorktree(k, h.state.id, actionId);
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
  return dispatchStep(k, h, step, host, cwd);
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
  held: { noLead: number } = { noLead: 0 },
): Promise<LeadAction[]> => {
  if (h.state.run.paused || h.state.run.finished_at !== undefined) return [];
  // Runs that ended without a check (a failure, a limit, a restart) are checked before a new
  // baseline is recorded; a git change made while a role runs stops everything (AD-7 rule 7).
  if ((await sweepDispatches(k, h)).issues.length > 0 || checkGitNow(k, h)) return [];
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
  for (const step of pendingSteps(k, h, host)) {
    if (free <= 0) break;
    const refusal = inSessionRefusal(k, h, step, host, call);
    if (refusal !== null) {
      // only the run's Lead reporting its sandbox off or unknown parks the step; a caller that
      // is not the Lead, with no Lead to ask, leaves it pending ({@link NO_LEAD_WAIT_REASON})
      if (k.leadless(h.state.id, call)) held.noLead += 1;
      else refuseInSession(k, h, step, refusal);
      continue;
    }
    const action = await dispatchGuarded(k, h, step, host);
    if (action === null) break;
    actions.push(action);
    free -= 1;
  }
  return actions;
};
