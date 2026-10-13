import {
  FINAL_REVIEW_CAP,
  type FeatureStatus,
  type ParkReason,
  type Phase,
  type RiskRuleReasonRule,
  type TaskStatus,
  type WorkflowNode,
  type WorkflowNodeState,
} from "@vtc/shared";

/** Colour family of a status (the ui kit's Badge tones). */
export type Tone = "neutral" | "brand" | "accent" | "ok" | "warn" | "danger";

export interface StatusMeta {
  readonly label: string;
  readonly tone: Tone;
  /** Pulses: something is happening right now. */
  readonly live?: boolean;
}

export const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  intake: "Intake",
  discover: "Discover",
  specify: "Specify",
  g1: "G1 spec gate",
  design: "Design",
  g2: "G2 architecture + design gate",
  plan: "Plan",
  build: "Build",
  integrate: "Integrate",
  final_review: "Final Review",
  release: "Release",
  retro: "Retro",
};

/** Why a task, feature or node is parked (§6.5 reason categories). */
export const PARK_REASON_LABELS: Readonly<Record<ParkReason, string>> = {
  risk_rule: "risk rule",
  cap: "round cap",
  stuck: "stuck",
  spec_conflict: "spec conflict",
  budget: "budget",
  change_request: "change request",
  gate_infra: "gate infrastructure",
  spec_question: "spec question",
  blocked: "blocked",
};

const words = (id: string): string => id.replace(/_/g, " ");

/** `round cap`, or `risk rule (committed secret)` with the §7.6 rule that fired. */
export const parkText = (reason: ParkReason, riskRule?: RiskRuleReasonRule): string =>
  riskRule === undefined
    ? PARK_REASON_LABELS[reason]
    : `${PARK_REASON_LABELS[reason]} (${words(riskRule)})`;

const parked = (reason: ParkReason | undefined, riskRule?: RiskRuleReasonRule): string =>
  reason === undefined ? "Parked" : `Parked: ${parkText(reason, riskRule)}`;

const ratio = (round: number | undefined, cap: number | undefined): string =>
  round === undefined || cap === undefined ? "" : ` ${String(round)}/${String(cap)}`;

/** Node display state (§17): waiting, running, passed, looping n/cap, parked with its reason, done… */
export const nodeStateMeta = (
  node: Pick<WorkflowNode, "state"> &
    Partial<Pick<WorkflowNode, "round" | "cap" | "park_reason" | "risk_rule">>,
): StatusMeta => {
  const state: WorkflowNodeState = node.state;
  switch (state) {
    case "waiting":
      return { label: "Waiting", tone: "neutral" };
    case "running":
      return { label: "Running", tone: "accent", live: true };
    case "passed":
      return { label: "Passed", tone: "ok" };
    case "looping":
      return { label: `Looping${ratio(node.round, node.cap)}`, tone: "warn", live: true };
    case "parked":
      return { label: parked(node.park_reason, node.risk_rule), tone: "danger" };
    case "interrupted":
      return { label: "Waiting for limit", tone: "warn" };
    case "done":
      return { label: "Done", tone: "ok" };
    case "skipped":
      return { label: "Skipped", tone: "neutral" };
    case "dropped":
      return { label: "Dropped", tone: "neutral" };
  }
};

/** Task status (§6.4), with `fixing(n/cap)`. */
export const taskStatusMeta = (task: {
  readonly status: TaskStatus;
  readonly round: number;
  readonly cap: number;
  readonly park_reason?: ParkReason | undefined;
  readonly risk_rule?: RiskRuleReasonRule | undefined;
}): StatusMeta => {
  switch (task.status) {
    case "draft":
      return { label: "Draft", tone: "neutral" };
    case "ready":
      return { label: "Ready", tone: "neutral" };
    case "waiting_dependency":
      return { label: "Waiting for dependency", tone: "neutral" };
    case "tests_authored":
      return { label: "Tests authored", tone: "accent", live: true };
    case "building":
      return { label: "Building", tone: "accent", live: true };
    case "verifying":
      return { label: "Verifying", tone: "accent", live: true };
    case "fixing":
      return { label: `Fixing${ratio(task.round, task.cap)}`, tone: "warn", live: true };
    case "built":
      return { label: "Built", tone: "brand" };
    case "queued":
      return { label: "Queued to merge", tone: "brand" };
    case "merged":
      return { label: "Merged", tone: "ok" };
    case "done":
      return { label: "Done", tone: "ok" };
    case "parked":
      return { label: parked(task.park_reason, task.risk_rule), tone: "danger" };
    case "interrupted":
      return { label: "Interrupted by usage limit", tone: "warn" };
    case "non_converged":
      return { label: "Non-converged", tone: "danger" };
    case "dropped":
      return { label: "Dropped", tone: "neutral" };
  }
};

/** Feature status (§6.7a), with Final Review `fixing(n/3)`. */
export const featureStatusMeta = (feature: {
  readonly status: FeatureStatus;
  readonly round: number;
  readonly park_reason?: ParkReason | undefined;
  readonly risk_rule?: RiskRuleReasonRule | undefined;
}): StatusMeta => {
  switch (feature.status) {
    case "building":
      return { label: "Building", tone: "accent", live: true };
    case "integrating":
      return { label: "Integrating", tone: "accent", live: true };
    case "final_review":
      return { label: "Final Review", tone: "accent", live: true };
    case "fixing":
      return { label: `Fixing${ratio(feature.round, FINAL_REVIEW_CAP)}`, tone: "warn", live: true };
    case "ready_to_ship":
      return { label: "Ready to ship", tone: "ok" };
    case "shipped":
      return { label: "Shipped", tone: "ok" };
    case "parked":
      return { label: parked(feature.park_reason, feature.risk_rule), tone: "danger" };
  }
};
