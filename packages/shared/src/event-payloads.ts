/**
 * Typed payloads (`Event.data`) for every core event type (AD-7). The engine writes them, and
 * replay, Flow Studio and Lookback read them, so field names are frozen here. Event types
 * outside this map stay open: consumers ignore types they do not know (AD-3 rule 5).
 */
import { z } from "zod";
import { FeatureSchema, FeatureStatusSchema, PullRequestRefSchema } from "./feature.js";
import { FindingSchema, FindingStatusSchema, WaiverSchema } from "./finding.js";
import { GateReportSchema } from "./gate-result.js";
import { EscalationAnswerSchema, EscalationSchema } from "./escalation.js";
import {
  EscalationIdSchema,
  EvidenceSchema,
  GitShaSchema,
  HostIdSchema,
  IsoDateTimeSchema,
  RelPathSchema,
  SessionRefSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
  VerdictSubjectSchema,
} from "./primitives.js";
import { MergeLevelSchema } from "./project-config.js";
import { ArtifactRefSchema, RoleExitSchema, VerdictSchema } from "./role-result.js";
import {
  ChangeRequestArtifactSchema,
  FrozenArtifactSchema,
  HumanGateIdSchema,
  IntakeClassificationSchema,
  PhaseSchema,
} from "./run.js";
import { ParkReasonSchema, TaskSchema, TaskStatusSchema } from "./task.js";
import { UsageSnapshotSchema, UsageWindowKindSchema } from "./usage.js";

/** Why the engine rejected a submitted result (§4.2 step 4, §6.3 step 4). */
export const RejectReasonSchema = z.enum([
  "unknown_action",
  "stale_action",
  "duplicate",
  "out_of_order",
  "schema",
  "claim_check",
  "write_scope",
  "undeclared_mode",
  /** Role, task, feature or verdict subject differ from the dispatched action. */
  "dispatch_mismatch",
  /** The exit is not in the role contract's `exits`. */
  "undeclared_exit",
  /** A verdict the contract does not declare, or no verdict from a role that must give one. */
  "undeclared_verdict",
  /** Task drafts or an artifact type the contract does not declare as output. */
  "undeclared_output",
]);
export type RejectReason = z.infer<typeof RejectReasonSchema>;

/** What kind of unclean end an incident report describes (§15 incident reports). */
export const IncidentKindSchema = z.enum([
  "crash",
  "kill",
  "limit",
  "gate_infra",
  "log_corruption",
  "stale_lock",
]);
export type IncidentKind = z.infer<typeof IncidentKindSchema>;

const parkedConsistency = (
  value: { to: string; park_reason?: unknown },
  ctx: z.RefinementCtx,
): void => {
  if ((value.to === "parked") !== (value.park_reason !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["park_reason"],
      message: "park_reason is required for, and only allowed with, to = parked",
    });
  }
};

/**
 * Payload schema per core event type. Keys are the frozen core vocabulary.
 *
 * Replay (AD-7) derives every engine-owned record field from these events and nothing else:
 * - Run: `run.started` (classification, `merge_level_effective` seed, config hash),
 *   `run.phase_changed`, `run.paused`/`run.resumed`, `run.finished`, `gate.approved`/
 *   `gate.rejected` (G1/G2 state), `run.merge_level_changed`;
 * - Task: `task.created` (Planner fields incl. `risk_tags`, cap, budget), `task.status_changed`
 *   (status, round, park reason), `task.workspace_assigned` (worktree, branch, baseline),
 *   `task.session_updated` (`session_ref`), `contract.frozen` (`provides_contract.frozen_sha256`),
 *   `budget.updated` scope task (`spent_usd`), `finding.recorded` route `defer` (`deferred`);
 * - Feature: `feature.created`, `feature.status_changed`, `feature.pr_updated`, `budget.updated`
 *   scope feature;
 * - Frozen artifacts: `gate.approved`, then `change_request.decided` (re-freeze) and
 *   `spec.clarified` (wording-only, no CR, §6.2).
 * `role.submitted.session_ref` is a trace of that run only; it never sets `Task.session_ref`.
 */
export const EVENT_PAYLOAD_SCHEMAS = {
  "run.started": IntakeClassificationSchema.extend({
    merge_level: MergeLevelSchema,
    pipeline_config_hash: Sha256HexSchema,
  }),
  "run.phase_changed": z.strictObject({ from: PhaseSchema.nullable(), to: PhaseSchema }),
  "run.paused": z.strictObject({ reason: z.string().min(1).max(300) }),
  "run.resumed": z.strictObject({
    /** True when the engine resumed after a usage reset without a human (§6.9). */
    auto: z.boolean(),
  }),
  "run.finished": z.strictObject({
    outcome: z.enum(["done", "aborted"]),
    summary: RelPathSchema.optional(),
  }),
  /** Auto-downgrade after a revert or post-merge CI failure, or a human change (§6.7). */
  "run.merge_level_changed": z
    .strictObject({
      from: MergeLevelSchema,
      to: MergeLevelSchema,
      reason: z.enum(["revert", "post_merge_ci_failure", "human"]),
    })
    .refine((v) => v.from !== v.to, { message: "the level must change", path: ["to"] }),
  "gate.approved": z.strictObject({
    gates: z.array(HumanGateIdSchema).min(1).max(2),
    frozen: z.array(FrozenArtifactSchema).min(1),
    design_direction: SlugSchema.optional(),
    waived_facts: z.array(SlugSchema).default([]),
    note: z.string().max(4000).optional(),
  }),
  "gate.rejected": z.strictObject({
    gates: z.array(HumanGateIdSchema).min(1).max(2),
    note: z.string().max(4000).optional(),
  }),
  "task.created": z.strictObject({ task: TaskSchema }),
  /** The task's worktree and branch exist (§6.6); baseline = the base it builds on. */
  "task.workspace_assigned": z.strictObject({
    worktree: RelPathSchema,
    branch: z.string().regex(/^vtc\/T-[1-9]\d*$/, "expected branch vtc/T-n"),
    baseline_revision: GitShaSchema,
  }),
  /** The host session later rounds of this task resume (§6.3 step 8, §6.5). */
  "task.session_updated": z.strictObject({ session_ref: SessionRefSchema }),
  /** The provider task's interface contract is frozen; consumers may start (§6.6). */
  "contract.frozen": z.strictObject({ path: RelPathSchema, sha256: Sha256HexSchema }),
  "task.status_changed": z
    .strictObject({
      from: TaskStatusSchema,
      to: TaskStatusSchema,
      round: z.int().nonnegative(),
      cap: z.int().min(3).max(5),
      park_reason: ParkReasonSchema.optional(),
    })
    .superRefine(parkedConsistency),
  "feature.created": z.strictObject({ feature: FeatureSchema }),
  "feature.status_changed": z
    .strictObject({
      from: FeatureStatusSchema,
      to: FeatureStatusSchema,
      round: z.int().nonnegative(),
      park_reason: ParkReasonSchema.optional(),
    })
    .superRefine(parkedConsistency),
  /** The feature's PR was opened or changed state (Level 2 draft → ready, §6.7). */
  "feature.pr_updated": z.strictObject({ pr: PullRequestRefSchema }),
  "role.dispatched": z.strictObject({
    action_id: SlugSchema,
    mode: SlugSchema.optional(),
    /** The one subject this call judges (e.g. the AC of a Spec-Verifier call, §7.4). */
    subject: VerdictSubjectSchema.optional(),
    /** `subagent` = a Lead action; `headless` = launched by the engine (AD-4 rule 4). */
    dispatch: z.enum(["subagent", "headless"]),
    agent: z.string().min(1).max(128),
    pack: RelPathSchema,
    resume: SessionRefSchema.nullable(),
  }),
  "role.submitted": z.strictObject({
    action_id: SlugSchema,
    exit: RoleExitSchema,
    /** Each verdict's subject and value; the cited evidence stays in the evidence files. */
    verdicts: z
      .array(z.strictObject({ subject: VerdictSubjectSchema, verdict: VerdictSchema }))
      .default([]),
    findings: z.int().nonnegative(),
    questions: z.int().nonnegative(),
    artifacts: z.array(ArtifactRefSchema).default([]),
    session_ref: SessionRefSchema.nullable(),
  }),
  "role.rejected": z.strictObject({
    action_id: SlugSchema,
    reason: RejectReasonSchema,
    issues: z.array(z.string().min(1).max(500)).max(20).default([]),
  }),
  "role.failed": z.strictObject({
    action_id: SlugSchema,
    kind: z.enum(["auth", "error"]),
    message: z.string().max(2000),
    retryable: z.boolean(),
  }),
  "gate.result": GateReportSchema,
  "finding.recorded": z.strictObject({ finding: FindingSchema }),
  "finding.status_changed": z.strictObject({
    fingerprint: Sha256HexSchema,
    from: FindingStatusSchema,
    to: FindingStatusSchema,
    waiver: WaiverSchema.optional(),
  }),
  "escalation.opened": z.strictObject({ escalation: EscalationSchema }),
  "escalation.answered": z.strictObject({
    escalation: EscalationIdSchema,
    answer: EscalationAnswerSchema,
  }),
  /** A change request was opened against a frozen artifact; its escalation decides it (§6.2). */
  "change_request.opened": z
    .strictObject({
      escalation: EscalationIdSchema,
      artifact: ChangeRequestArtifactSchema,
      /** The artifact as currently frozen. */
      frozen: FrozenArtifactSchema,
      /** The provider task, for an interface contract (§6.6). */
      task: TaskIdSchema.optional(),
      summary: z.string().min(1).max(300),
    })
    .refine((v) => (v.artifact === "interface_contract") === (v.task !== undefined), {
      message: "task is required for, and only allowed with, interface_contract",
      path: ["task"],
    }),
  /** The human decided a CR; an approved CR re-freezes the artifact at its new hash. */
  "change_request.decided": z
    .strictObject({
      escalation: EscalationIdSchema,
      decision: z.enum(["approved", "rejected"]),
      /** The artifact as frozen before the CR. */
      frozen: FrozenArtifactSchema,
      new_sha256: Sha256HexSchema.optional(),
    })
    .refine((v) => (v.decision === "approved") === (v.new_sha256 !== undefined), {
      message: "new_sha256 is required for, and only allowed with, an approved CR",
      path: ["new_sha256"],
    }),
  /** A wording-only BA clarification of the frozen spec: no CR, logged for the run summary (§6.2). */
  "spec.clarified": z.strictObject({
    path: RelPathSchema,
    old_sha256: Sha256HexSchema,
    new_sha256: Sha256HexSchema,
    summary: z.string().min(1).max(300),
  }),
  "budget.updated": z.strictObject({
    scope: z.enum(["task", "feature", "run"]),
    budget_usd: z.number().positive(),
    spent_usd: z.number().nonnegative(),
  }),
  "usage.updated": z.strictObject({ snapshot: UsageSnapshotSchema }),
  "limit.hit": z.strictObject({
    host: HostIdSchema,
    window: UsageWindowKindSchema.nullable(),
    model: z.string().min(1).max(200).nullable(),
    resets_at: IsoDateTimeSchema.nullable(),
    session_ref: SessionRefSchema.nullable(),
    /** Steps marked `interrupted`, re-dispatched after the reset (§6.9 steps 2–3). */
    pending_action_ids: z.array(SlugSchema).default([]),
    auto_resume_at: IsoDateTimeSchema.nullable(),
  }),
  "merge.completed": z.strictObject({
    into: z.string().min(1).max(255),
    commit: GitShaSchema,
    level: MergeLevelSchema,
  }),
  "incident.recorded": z.strictObject({
    kind: IncidentKindSchema,
    detail: z.string().min(1).max(2000),
    /** For `log_corruption`: 1-based lines `parseEventLog` reported. */
    invalid_lines: z.array(z.int().positive()).default([]),
    evidence: z.array(EvidenceSchema).default([]),
  }),
} as const;

export type CoreEventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;
export type EventData<T extends CoreEventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;
export type EventDataInput<T extends CoreEventType> = z.input<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

/** Envelope fields a core event type can require. */
export type EnvelopeField =
  "task" | "feature" | "role" | "prompt_sha" | "host" | "model" | "tokens" | "cost_usd";

/**
 * Envelope fields a core event must carry: task events name the task, feature events the
 * feature, role events the role. Every AI call is traceable to a role, a host/model and a
 * prompt version (§1.1 #3, §13): `role.dispatched` and `role.submitted` require `prompt_sha`,
 * `host` and `model`, and `role.submitted` also carries `tokens` and `cost_usd`, which may be
 * `null` (unknown or unpriced) but never absent.
 */
export const EVENT_ENVELOPE_REQUIREMENTS: Readonly<
  Partial<Record<CoreEventType, readonly EnvelopeField[]>>
> = {
  "task.created": ["task"],
  "task.status_changed": ["task"],
  "task.workspace_assigned": ["task"],
  "task.session_updated": ["task"],
  "contract.frozen": ["task"],
  "feature.created": ["feature"],
  "feature.status_changed": ["feature"],
  "feature.pr_updated": ["feature"],
  "role.dispatched": ["role", "prompt_sha", "host", "model"],
  "role.submitted": ["role", "prompt_sha", "host", "model", "tokens", "cost_usd"],
  "role.rejected": ["role"],
  "role.failed": ["role"],
  "merge.completed": ["task"],
};

export const isCoreEventType = (type: string): type is CoreEventType =>
  Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, type);

export type EventDataCheck =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly z.core.$ZodIssue[] };

/**
 * Validates `data` for a core event type. Unknown types are accepted unchanged (open
 * vocabulary). On success, `data` is the parsed payload (defaults applied).
 */
export const validateEventData = (
  type: string,
  data: Readonly<Record<string, unknown>>,
): EventDataCheck => {
  if (!isCoreEventType(type)) return { ok: true, data: { ...data } };
  const parsed = EVENT_PAYLOAD_SCHEMAS[type].safeParse(data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, issues: parsed.error.issues };
};
