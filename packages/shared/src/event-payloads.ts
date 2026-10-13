/**
 * Typed payloads (`Event.data`) for every core event type (AD-7). The engine writes them, and
 * replay, Flow Studio and Lookback read them, so field names are frozen here. Event types
 * outside this map stay open: consumers ignore types they do not know (AD-3 rule 5).
 */
import { z } from "zod";
import { FeatureSchema, FeatureStatusSchema } from "./feature.js";
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
} from "./primitives.js";
import { MergeLevelSchema } from "./project-config.js";
import { ArtifactRefSchema, RoleExitSchema, VerdictSchema } from "./role-result.js";
import {
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

/** Payload schema per core event type. Keys are the frozen core vocabulary. */
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
  "role.dispatched": z.strictObject({
    action_id: SlugSchema,
    mode: SlugSchema.optional(),
    /** `subagent` = a Lead action; `headless` = launched by the engine (AD-4 rule 4). */
    dispatch: z.enum(["subagent", "headless"]),
    agent: z.string().min(1).max(128),
    pack: RelPathSchema,
    resume: SessionRefSchema.nullable(),
  }),
  "role.submitted": z.strictObject({
    action_id: SlugSchema,
    exit: RoleExitSchema,
    verdict: VerdictSchema.optional(),
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

/**
 * Envelope fields a core event must carry: task events name the task, feature events the
 * feature, role events the role.
 */
export const EVENT_ENVELOPE_REQUIREMENTS: Readonly<
  Partial<Record<CoreEventType, readonly ("task" | "feature" | "role")[]>>
> = {
  "task.created": ["task"],
  "task.status_changed": ["task"],
  "feature.created": ["feature"],
  "feature.status_changed": ["feature"],
  "role.dispatched": ["role"],
  "role.submitted": ["role"],
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
