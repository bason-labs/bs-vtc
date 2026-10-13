/**
 * Workflow-graph composition for Flow Studio (§16 workflow node, §17 zoom levels). Pure: built
 * from the run state, so live mode and snapshot mode draw the same graph. Every back-edge goes
 * through a `loop_guard` (`WorkflowGraphSchema`).
 */
import {
  PHASES,
  type ParkReason,
  type Phase,
  type RiskRuleReasonRule,
  type Task,
  type TaskStatus,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeState,
} from "@vtc/shared";
import { reviewersFor, type ReviewerSlot } from "./router.js";
import type { RunState } from "./state.js";

const nodeId = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  intake: "Intake",
  discover: "Discover",
  specify: "Specify",
  g1: "G1",
  design: "Design",
  g2: "G2",
  plan: "Plan",
  build: "Build",
  integrate: "Integrate",
  final_review: "Final Review",
  release: "Release",
  retro: "Retro",
};

const edge = (from: string, to: string, artifact?: string): WorkflowEdge => ({
  id: `${from}-${to}`,
  from,
  to,
  ...(artifact === undefined ? {} : { artifact }),
});

/** Zoom level 1: the fixed backbone (§6.1) with each phase's state. */
export const projectGraph = (state: RunState): WorkflowGraph => {
  const current = PHASES.indexOf(state.run.phase);
  const finished = state.run.finished_at !== undefined;
  const nodes: WorkflowNode[] = PHASES.map((phase, index) => {
    const id = nodeId(phase);
    const human = phase === "g1" || phase === "g2";
    const skipped =
      phase === "discover" && state.run.track === "quick_fix" && index < current;
    const nodeState: WorkflowNodeState = skipped
      ? "skipped"
      : index < current || (finished && index === current)
        ? "passed"
        : index === current
          ? "running"
          : "waiting";
    return {
      id,
      kind: human ? "human" : "subflow",
      label: PHASE_LABELS[phase],
      ports_in: [],
      ports_out: [],
      reason_added: "backbone (§6.1)",
      state: nodeState,
      ...(human ? {} : { subflow: `phase-${id}` }),
    };
  });
  const edges = PHASES.slice(1).map((phase, i) =>
    edge(nodeId(PHASES[i] ?? phase), nodeId(phase)),
  );
  return { id: `${nodeId(state.id)}-phases`, scope: "project", nodes, edges };
};

/** `WorkflowNodeState` of a task node (`WorkflowNodeStateSchema` doc). */
export const taskNodeState = (status: TaskStatus): WorkflowNodeState => {
  switch (status) {
    case "draft":
    case "ready":
    case "waiting_dependency":
      return "waiting";
    case "tests_authored":
    case "building":
    case "verifying":
      return "running";
    case "fixing":
      return "looping";
    case "built":
    case "queued":
    case "merged":
      return "passed";
    case "done":
      return "done";
    case "parked":
      return "parked";
    case "interrupted":
      return "interrupted";
    case "dropped":
    case "non_converged":
      return "dropped";
  }
};

const parkFields = (
  reason: ParkReason | undefined,
  rule: RiskRuleReasonRule | undefined,
): Pick<WorkflowNode, "park_reason" | "risk_rule"> => ({
  ...(reason === undefined ? {} : { park_reason: reason }),
  ...(rule === undefined ? {} : { risk_rule: rule }),
});

/** Zoom level 2: the task DAG; edges are `after` dependencies and consumed contracts. */
export const taskDagGraph = (state: RunState): WorkflowGraph => {
  const tasks = [...state.tasks.values()];
  const nodes: WorkflowNode[] = tasks.map((task) => ({
    id: nodeId(task.id),
    kind: "subflow",
    label: `${task.id} ${task.title}`.slice(0, 120),
    task: task.id,
    ports_in: [],
    ports_out: [],
    reason_added: task.origin,
    state: taskNodeState(task.status),
    round: task.round,
    cap: task.cap,
    ...(task.status === "parked" ? parkFields(task.park_reason, task.risk_rule) : {}),
    subflow: `task-${nodeId(task.id)}`,
  }));
  const known = new Set(tasks.map((t) => t.id));
  const edges: WorkflowEdge[] = [];
  for (const task of tasks) {
    for (const dep of task.after) {
      if (known.has(dep)) edges.push(edge(nodeId(dep), nodeId(task.id)));
    }
    for (const consumed of task.consumes_contracts) {
      if (!known.has(consumed.provider)) continue;
      edges.push({
        ...edge(nodeId(consumed.provider), nodeId(task.id), "interface_contract"),
        id: `${nodeId(consumed.provider)}-${nodeId(task.id)}-contract`,
      });
    }
  }
  return {
    id: `${nodeId(state.id)}-tasks`,
    scope: "task_dag",
    nodes: nodes.length > 0 ? nodes : [placeholder("no-tasks", "No tasks yet")],
    edges,
  };
};

const placeholder = (id: string, label: string): WorkflowNode => ({
  id,
  kind: "subflow",
  label,
  ports_in: [],
  ports_out: [],
  reason_added: "planned at PLAN (§6.1)",
  state: "waiting",
  subflow: id,
});

/** Pipeline stages in order (§6.3); reviewers occupy one stage. */
const STAGES = [
  "qa",
  "engineer",
  "write_scope",
  "gates",
  "router",
  "reviewers",
  "triage",
  "loop_guard",
] as const;
type Stage = (typeof STAGES)[number];

/** Where a park of each reason stops the pipeline. */
const PARK_STAGE: Readonly<Record<ParkReason, Stage>> = {
  spec_question: "qa",
  blocked: "engineer",
  spec_conflict: "engineer",
  gate_infra: "gates",
  risk_rule: "router",
  cap: "loop_guard",
  stuck: "loop_guard",
  budget: "loop_guard",
  change_request: "loop_guard",
};

const PARK_NODE_REASON: Readonly<Record<ParkReason, string>> = {
  cap: "cap reached (§7.6 rule 10)",
  stuck: "stuck (§7.6 rule 10)",
  risk_rule: "risk rule fired (§7.6)",
  budget: "budget exhausted (§7.6 rule 13)",
  gate_infra: "gate infrastructure failure (§7.6 rule 12)",
  spec_conflict: "spec conflict (§7.6 rule 11)",
  change_request: "change request (§7.6 rule 11)",
  spec_question: "spec question (§6.3 step 2)",
  blocked: "blocked on a question (§6.3 step 3)",
};

interface StageView {
  readonly state: (stage: Stage, reviewer?: ReviewerSlot) => WorkflowNodeState;
}

/** Stage states for a task status; `current` is the stage that runs now. */
const stageStates = (state: RunState, task: Task): StageView => {
  const effective: TaskStatus =
    task.status === "interrupted" ? (state.checkpoints.get(task.id) ?? "building") : task.status;
  const at = (stage: Stage): number => STAGES.indexOf(stage);
  const runs = [...state.roleRuns.values()].filter((r) => r.task === task.id);
  const reviewerRun = (slot: ReviewerSlot) =>
    runs.filter((r) => r.role === slot.role && r.subject === slot.subject && r.mode === slot.mode).at(-1);
  const linear = (current: number, currentState: WorkflowNodeState) => (stage: Stage) => {
    const index = at(stage);
    if (index < current) return "passed";
    if (index === current) return currentState;
    return "waiting";
  };
  const interrupted = task.status === "interrupted";
  const running: WorkflowNodeState = interrupted ? "interrupted" : "running";
  switch (effective) {
    case "draft":
    case "waiting_dependency":
      return { state: () => "waiting" };
    case "ready": {
      const qaRunning = runs.some((r) => r.role === "qa" && r.status === "in_flight");
      return { state: linear(at("qa"), qaRunning || interrupted ? running : "waiting") };
    }
    case "tests_authored":
      return { state: linear(at("engineer"), "waiting") };
    case "building":
      return { state: linear(at("engineer"), running) };
    case "fixing":
      return {
        state: (stage) =>
          stage === "qa"
            ? "passed"
            : stage === "engineer"
              ? running
              : stage === "loop_guard"
                ? "looping"
                : "passed",
      };
    case "verifying": {
      const gated = state.gateReports.some(
        (r) => r.report.task === task.id && r.report.reason === "round" && r.seq > lastSubmitSeq(state, task.id),
      );
      const current = gated ? at("reviewers") : at("gates");
      return {
        state: (stage, reviewer) => {
          if (stage === "reviewers" && reviewer !== undefined && gated) {
            const run = reviewerRun(reviewer);
            if (run === undefined || run.seq < lastSubmitSeq(state, task.id)) return "waiting";
            return run.status === "in_flight" ? running : "passed";
          }
          return linear(current, running)(stage);
        },
      };
    }
    case "built":
    case "queued":
    case "merged":
    case "done":
      return { state: () => "passed" };
    case "parked": {
      const stop = at(PARK_STAGE[task.park_reason ?? "blocked"]);
      return {
        state: (stage) => {
          const index = at(stage);
          if (index < stop) return "passed";
          if (index === stop) return "parked";
          return "waiting";
        },
      };
    }
    case "interrupted":
    case "dropped":
    case "non_converged":
      return { state: () => "dropped" };
  }
};

const lastSubmitSeq = (state: RunState, taskId: string): number =>
  [...state.roleRuns.values()]
    .filter((r) => r.task === taskId && r.role === "engineer" && r.status === "submitted")
    .reduce((max, r) => Math.max(max, r.closedSeq ?? 0), 0);

/**
 * Zoom level 3: one task's pipeline (§6.3) with its loop. `acceptanceCriteria` are the ACs the
 * task covers (from the frozen spec); `null` when the run has no such task.
 */
export const taskPipelineGraph = (
  state: RunState,
  taskId: string,
  acceptanceCriteria: readonly string[],
): WorkflowGraph | null => {
  const task = state.tasks.get(taskId);
  if (task === undefined) return null;
  const reviewers = reviewersFor(task, state.run, acceptanceCriteria);
  const view = stageStates(state, task);
  const parked = task.status === "parked" ? task.park_reason : undefined;
  const parkAt = parked === undefined ? undefined : PARK_STAGE[parked];
  const node = (
    stage: Stage,
    base: Omit<WorkflowNode, "state" | "ports_in" | "ports_out" | "task"> &
      Partial<Pick<WorkflowNode, "ports_in" | "ports_out">>,
    reviewer?: ReviewerSlot,
  ): WorkflowNode => {
    const nodeState = view.state(stage, reviewer);
    const looping = nodeState === "looping" || stage === "loop_guard";
    return {
      ports_in: [],
      ports_out: [],
      ...base,
      task: task.id,
      state: nodeState,
      ...(looping ? { round: task.round, cap: task.cap } : {}),
      ...(nodeState === "parked" && parkAt === stage ? parkFields(parked, task.risk_rule) : {}),
    };
  };
  const nodes: WorkflowNode[] = [
    node("qa", {
      id: "qa-author",
      kind: "role",
      label: "QA author",
      role: "qa",
      ports_out: ["acceptance_tests"],
      reason_added: "every task (§6.3 step 2)",
    }),
    node("engineer", {
      id: "engineer",
      kind: "role",
      label: `Engineer (${task.discipline})`,
      role: "engineer",
      ports_in: ["acceptance_tests"],
      ports_out: ["diff"],
      reason_added: `discipline ${task.discipline} (§5.2a)`,
    }),
    node("write_scope", {
      id: "write-scope",
      kind: "gate",
      label: "Write scope (L5)",
      reason_added: "every submit (§6.3 step 4)",
    }),
    node("gates", {
      id: "gates",
      kind: "gate",
      label: "Gates L0-L5",
      reason_added: "every round (§6.3 step 5)",
    }),
    node("router", {
      id: "risk-router",
      kind: "router",
      label: "Risk router",
      reason_added: "every round (§6.3 step 6)",
    }),
    ...reviewers.map((slot) =>
      node(
        "reviewers",
        {
          id: slot.id,
          kind: "role",
          label: slot.label.slice(0, 120),
          role: slot.role,
          ports_out: ["verdict"],
          reason_added: slot.reason,
        },
        slot,
      ),
    ),
    node("triage", {
      id: "triage",
      kind: "router",
      label: "Triage",
      reason_added: "every round (§6.3 step 8)",
    }),
    node("loop_guard", {
      id: "loop-guard",
      kind: "loop_guard",
      label: "Round cap",
      reason_added: `risk ${task.risk}: cap ${String(task.cap)} (§6.3 step 9)`,
    }),
  ];
  const edges: WorkflowEdge[] = [
    edge("qa-author", "engineer"),
    edge("engineer", "write-scope"),
    edge("write-scope", "gates"),
    edge("gates", "risk-router"),
    ...(reviewers.length === 0
      ? [edge("risk-router", "triage")]
      : reviewers.flatMap((slot) => [edge("risk-router", slot.id), edge(slot.id, "triage")])),
    edge("triage", "loop-guard"),
    edge("loop-guard", "engineer", "findings"),
  ];
  if (parked !== undefined) {
    nodes.push({
      id: "park",
      kind: "park",
      label: `Parked: ${parked}`,
      task: task.id,
      ports_in: [],
      ports_out: [],
      reason_added: PARK_NODE_REASON[parked],
      state: "parked",
      ...parkFields(parked, task.risk_rule),
    });
    edges.push(edge("loop-guard", "park"));
  }
  return { id: `task-${nodeId(task.id)}`, scope: "task", nodes, edges };
};
