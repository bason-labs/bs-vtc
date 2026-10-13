/**
 * Task and feature state machines (§6.4, §6.7a; AD-8 rule 1). Every transition the engine makes
 * goes through {@link assertTaskTransition} / {@link assertFeatureTransition}; workers can never
 * set a state (`done` least of all).
 */
import type { FeatureStatus, TaskStatus } from "@vtc/shared";

/** States a parked or interrupted task can resume to: its checkpoint (§6.5, §6.8). */
const CHECKPOINTS: readonly TaskStatus[] = [
  "ready",
  "tests_authored",
  "building",
  "verifying",
  "fixing",
  "built",
  "queued",
];

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ["ready", "waiting_dependency", "dropped"],
  waiting_dependency: ["ready", "dropped"],
  ready: ["tests_authored", "parked", "interrupted", "dropped"],
  tests_authored: ["building", "parked", "interrupted", "dropped"],
  building: ["verifying", "fixing", "parked", "interrupted", "dropped"],
  verifying: ["fixing", "built", "parked", "interrupted", "dropped"],
  fixing: ["verifying", "fixing", "parked", "interrupted", "dropped"],
  built: ["queued", "parked", "dropped"],
  // A merge-queue conflict or failure is a rebase round (§6.7).
  queued: ["merged", "fixing", "parked", "dropped"],
  merged: ["done"],
  done: [],
  parked: [...CHECKPOINTS, "dropped"],
  interrupted: ["ready", "tests_authored", "building", "verifying", "fixing", "parked", "dropped"],
  // Reserved, never set in v1 (spine §5 reading 9).
  non_converged: [],
  dropped: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${entity}: ${from} → ${to} is not a valid transition`);
    this.name = "InvalidTransitionError";
  }
}

export const canTransitionTask = (from: TaskStatus, to: TaskStatus): boolean =>
  TASK_TRANSITIONS[from].includes(to);

export const assertTaskTransition = (task: string, from: TaskStatus, to: TaskStatus): void => {
  if (!canTransitionTask(from, to)) throw new InvalidTransitionError(task, from, to);
};

/** `building → integrating → final_review ⇄ fixing(n/3) → ready_to_ship → shipped`, `parked`. */
export const FEATURE_TRANSITIONS: Readonly<Record<FeatureStatus, readonly FeatureStatus[]>> = {
  building: ["integrating", "parked"],
  integrating: ["final_review", "building", "parked"],
  final_review: ["fixing", "ready_to_ship", "parked"],
  fixing: ["final_review", "integrating", "parked"],
  ready_to_ship: ["shipped", "parked"],
  shipped: [],
  parked: ["building", "integrating", "final_review", "fixing", "ready_to_ship"],
};

export const canTransitionFeature = (from: FeatureStatus, to: FeatureStatus): boolean =>
  FEATURE_TRANSITIONS[from].includes(to);

export const assertFeatureTransition = (
  feature: string,
  from: FeatureStatus,
  to: FeatureStatus,
): void => {
  if (!canTransitionFeature(from, to)) throw new InvalidTransitionError(feature, from, to);
};

/** Statuses in which a task holds its `files_scope` (§6.6: no two overlapping at once). */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  "ready",
  "tests_authored",
  "building",
  "verifying",
  "fixing",
  "interrupted",
  "built",
  "queued",
];

/** Statuses a task never leaves. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "dropped"];
