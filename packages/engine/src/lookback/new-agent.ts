/**
 * New-agent signals (D-cd, H-7; spine §5 reading 198): where the attribution history says VTC is
 * missing a specialist. Pure. Three kinds, each needing a recurring cause:
 * - `discipline_failures`: at least `LOOKBACK_LIMITS.minTrainFailures` Engineer failures (the
 *   attribution tree's or a human's, on the Engineer's own dispatch) on tasks of a discipline no
 *   installed engineer profile serves. The dispatched role is `engineer` whether a profile ran it
 *   or not (§5.2a, reading 38), so the catalog decides: proposed `engineer_<discipline>`.
 * - `stack_failures`: as many Engineer failures on tasks of one stack pack in disciplines that do
 *   have a profile, when no installed role declares that stack: proposed `engineer_<stack>`.
 * - `missing_role`: at least {@link NEW_AGENT_MIN_ESCALATIONS} answered escalations whose
 *   `who_should_have_caught` names a role that is not installed (the human asking for a skill VTC
 *   lacks): proposed that role.
 * A new role has no dispatches of its own to replay, so every signal is evidence-only: its PR
 * carries the evidence and the `needs-eval` label (`AUTO_LABELS.needsEval`). Engine core raises
 * the `new_agent` issue from it through the upstream module (`newAgentReportFields` is what may
 * leave the machine: the proposed role only when it is named after a shipped discipline), and VTC
 * builds the role on the bs-vtc checkout.
 */
import {
  AUTO_LABELS,
  DisciplineSchema,
  isEventOfType,
  LOOKBACK_LIMITS,
  readEventData,
  RoleIdSchema,
  type Attribution,
  type Discipline,
  type RoleKind,
  type VtcEvent,
} from "@vtc/shared";
import { isRoleFailure } from "./attribution.js";
import { traceRef } from "./traces.js";

/** Escalations naming the same missing role before it is proposed ("keep asking"). */
export const NEW_AGENT_MIN_ESCALATIONS = 2;

/** Most trace refs a signal carries as evidence. */
const MAX_TRACES = 20;

/** A role this vtc carries, as the catalog describes it. */
export interface InstalledRole {
  readonly id: string;
  readonly kind: RoleKind;
  /** An engineer profile's discipline. */
  readonly discipline?: string;
  /** Stack packs the role declares it covers (none in the shipped catalog). */
  readonly stack_packs?: readonly string[];
}

export interface NewAgentSignal {
  readonly kind: "new_agent";
  readonly basis: "discipline_failures" | "stack_failures" | "missing_role";
  /** The role id the proposal would add. */
  readonly proposed_role: string;
  readonly discipline?: Discipline;
  /** The stack packs of the failing tasks, most frequent first. */
  readonly stack_packs: readonly string[];
  readonly failures: number;
  readonly escalations: number;
  /** `<run>:<action_id>` of the failures (the newest {@link MAX_TRACES}). */
  readonly traces: readonly string[];
  /** No replay is possible for a role that does not exist yet (D-cd). */
  readonly evidence_only: true;
  readonly labels: readonly string[];
}

const roleIdFor = (suffix: string): string | undefined => {
  const id = `engineer_${suffix.toLowerCase().replace(/[^a-z0-9_-]+/g, "_")}`.slice(0, 48);
  return RoleIdSchema.safeParse(id).success ? id : undefined;
};

const byFrequency = (values: readonly string[]): string[] => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
};

/** The new-agent signals of the history (see the module comment). */
export const newAgentSignals = (input: {
  /** Trusted attributions (`readAttributions`). */
  readonly attributions: readonly Attribution[];
  readonly history: readonly VtcEvent[];
  readonly roles: readonly InstalledRole[];
}): NewAgentSignal[] => {
  const installed = new Set(input.roles.map((r) => r.id));
  const profiled = new Set(
    input.roles.flatMap((r) =>
      r.kind === "engineer_profile" && r.discipline !== undefined ? [r.discipline] : [],
    ),
  );
  const coveredStacks = new Set(input.roles.flatMap((r) => r.stack_packs ?? []));
  const tasks = new Map<string, { discipline: Discipline; stacks: readonly string[] }>();
  for (const event of input.history) {
    if (!isEventOfType(event, "task.created")) continue;
    const { task } = readEventData(event);
    tasks.set(`${event.run}:${task.id}`, { discipline: task.discipline, stacks: task.stack_packs });
  }
  const groups = new Map<
    string,
    {
      basis: "discipline_failures" | "stack_failures";
      role: string;
      discipline: Discipline;
      stacks: string[];
      traces: string[];
    }
  >();
  for (const a of input.attributions) {
    if (!isRoleFailure(a) || a.prompt.role !== "engineer" || a.task === undefined) continue;
    const task = tasks.get(`${a.run}:${a.task}`);
    if (task === undefined) continue;
    const add = (
      key: string,
      basis: "discipline_failures" | "stack_failures",
      role: string | undefined,
    ): void => {
      if (role === undefined || installed.has(role)) return;
      const group = groups.get(key) ?? {
        basis,
        role,
        discipline: task.discipline,
        stacks: [],
        traces: [],
      };
      group.stacks.push(...task.stacks);
      group.traces.push(traceRef(a));
      groups.set(key, group);
    };
    if (!profiled.has(task.discipline)) {
      add(`discipline:${task.discipline}`, "discipline_failures", roleIdFor(task.discipline));
      continue;
    }
    for (const stack of task.stacks)
      if (!coveredStacks.has(stack)) add(`stack:${stack}`, "stack_failures", roleIdFor(stack));
  }
  const signals: NewAgentSignal[] = [];
  for (const group of groups.values()) {
    if (group.traces.length < LOOKBACK_LIMITS.minTrainFailures) continue;
    signals.push({
      kind: "new_agent",
      basis: group.basis,
      proposed_role: group.role,
      discipline: DisciplineSchema.parse(group.discipline),
      stack_packs: byFrequency(group.stacks),
      failures: group.traces.length,
      escalations: 0,
      traces: group.traces.slice(-MAX_TRACES),
      evidence_only: true,
      labels: [AUTO_LABELS.needsEval],
    });
  }
  const asked = new Map<string, number>();
  for (const event of input.history) {
    if (!isEventOfType(event, "escalation.answered")) continue;
    const role = readEventData(event).answer.who_should_have_caught;
    if (role === "none" || installed.has(role)) continue;
    asked.set(role, (asked.get(role) ?? 0) + 1);
  }
  for (const [role, escalations] of asked) {
    if (escalations < NEW_AGENT_MIN_ESCALATIONS) continue;
    const index = signals.findIndex((s) => s.proposed_role === role);
    const existing = signals[index];
    if (existing !== undefined) {
      signals[index] = { ...existing, escalations };
      continue;
    }
    signals.push({
      kind: "new_agent",
      basis: "missing_role",
      proposed_role: role,
      stack_packs: [],
      failures: 0,
      escalations,
      traces: [],
      evidence_only: true,
      labels: [AUTO_LABELS.needsEval],
    });
  }
  return signals;
};
