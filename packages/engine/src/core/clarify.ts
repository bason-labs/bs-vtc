/**
 * Spec and design gaps (§6.3 steps 3 and 8, §6.2): a `spec_gap` finding or an Engineer's
 * `spec_conflict` exit goes to the BA, a `design_gap` finding to the Designer, for the task
 * whose round found it. They work in the user's checkout (a checkout role, `phase-scope.ts`).
 * A wording-only fix of the frozen spec is logged as `spec.clarified`; a change in meaning (any
 * requirement or acceptance criterion added, removed or renamed, a frozen design artifact
 * changed, or the role's own `spec_conflict` exit) becomes a change request the human decides.
 * Only the clarifier's `blocked` or `unknown`, or a task that keeps coming back
 * ({@link MAX_CLARIFICATIONS}), parks the task for the human directly.
 */
import type { FindingRoute, FrozenArtifact } from "@vtc/shared";
import type { Kernel, RunHandle } from "./kernel.js";
import { openTaskEscalation, setTaskStatus } from "./parking.js";
import { taskFindings } from "./queries.js";
import type { RunState } from "./state.js";

/** Who answers each gap route. */
export const CLARIFIER_OF: Readonly<Partial<Record<FindingRoute, "ba" | "designer">>> = {
  spec_gap: "ba",
  design_gap: "designer",
};

export const isClarifier = (role: string): role is "ba" | "designer" =>
  role === "ba" || role === "designer";

/** After this many accepted clarifications of one task, its next gap goes to the human. */
export const MAX_CLARIFICATIONS = 3;

/** The task's open gap findings, BA's first (the spec decides before the design). */
export const openGaps = (state: RunState, taskId: string) =>
  taskFindings(state, taskId)
    .filter((f) => f.status === "open" && (f.route === "spec_gap" || f.route === "design_gap"))
    .sort((a, b) => (a.route === b.route ? 0 : a.route === "spec_gap" ? -1 : 1));

/** Clarifier runs of a task that were accepted. */
export const clarifications = (state: RunState, taskId: string): number =>
  [...state.roleRuns.values()].filter(
    (r) => r.task === taskId && isClarifier(r.role) && r.status === "submitted",
  ).length;

/** The frozen artifacts a clarifier answers for: the spec (G1) or the design (G2). */
export const frozenFor = (state: RunState, role: "ba" | "designer"): FrozenArtifact[] => {
  const prefix = role === "ba" ? ".vtc/spec/" : ".vtc/design/";
  return [...state.run.gates.G1.frozen, ...state.run.gates.G2.frozen].filter((f) =>
    f.path.startsWith(prefix),
  );
};

/** Gap findings the clarifier answered are resolved (the Engineer continues with the answer). */
export const resolveGaps = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
  routes: readonly FindingRoute[],
): void => {
  for (const f of taskFindings(h.state, taskId)) {
    if (f.status !== "open" || !routes.includes(f.route)) continue;
    k.emit(h, {
      type: "finding.status_changed",
      actor: "engine",
      task: taskId,
      data: { fingerprint: f.fingerprint, from: "open", to: "resolved" },
    });
  }
};

/**
 * A change in meaning (§6.2): the task parks with a `change_request` escalation and the
 * `change_request.opened` record of the frozen artifact; the human's decision re-freezes it (or
 * not) and the task continues (`applyAnswer`).
 */
export const openChangeRequest = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
  input: {
    readonly artifact: "spec" | "design";
    readonly frozen: FrozenArtifact;
    readonly summary: string;
    readonly detail: string;
    readonly raisedBy: string;
  },
): void => {
  setTaskStatus(k, h, taskId, "parked", { parkReason: "change_request" });
  const escalation = openTaskEscalation(k, h, taskId, {
    reason: "change_request",
    detail: input.detail,
    evidence: [{ type: "file", ref: input.frozen.path }],
    raisedBy: input.raisedBy,
  });
  k.emit(h, {
    type: "change_request.opened",
    actor: "engine",
    task: taskId,
    data: {
      escalation: escalation.id,
      artifact: input.artifact,
      frozen: input.frozen,
      summary: (input.summary.trim() || `${input.artifact} change for ${taskId}`).slice(0, 300),
    },
  });
};
