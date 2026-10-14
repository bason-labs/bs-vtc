/**
 * Typed payloads (`Event.data`) for every core event type (AD-7). The engine writes them, and
 * replay, Flow Studio and Lookback read them, so field names are frozen here. Event types
 * outside this map stay open: consumers ignore types they do not know (AD-3 rule 5).
 */
import { z } from "zod";
import {
  AutoMergeChecklistSchema,
  AutoMergeDisabledSchema,
  AutoMergeEnabledSchema,
  FeatureRevertedSchema,
  MergePreflightSchema,
  PostMergeCiSchema,
} from "./auto-merge.js";
import { DesignCoverageReportSchema, G2DirectionSchema } from "./design.js";
import { FeatureSchema, FeatureStatusSchema, PullRequestRefSchema } from "./feature.js";
import { HeadlessEndedSchema, HeadlessPreflightSchema, HeadlessStartedSchema } from "./headless.js";
import { CanaryStateSchema, EscapedDefectSchema, ReplayVerdictSchema } from "./lookback.js";
import {
  FactIdSchema,
  FactRowSchema,
  FactStatusSchema,
  FactWaiverSchema,
  ResearchFetchedSchema,
  UnverifiedFactSummarySchema,
} from "./research.js";
import { FinalReviewStepResultSchema } from "./traceability.js";
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
  RiskRuleReasonRuleSchema,
  RoleIdSchema,
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
import {
  checkParkRiskRule,
  IntentContractSchema,
  ParkReasonSchema,
  TaskSchema,
  TaskStatusSchema,
} from "./task.js";
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

/**
 * What an incident report describes (§15 incident reports): an unclean end, or an event the
 * human must see without the run stopping.
 * - `config_changed`: `project.yaml` or `gates.yml` changed during a run. The run keeps the
 *   config it started with (`run.started.pipeline_config_hash`) and does not pause; the new
 *   config applies to the next run (spine §5 reading 20).
 * - `checkout_write`: a write the engine's checkout or log check found that no role and no engine
 *   write explains (AD-7 rule 7), logged in full with its paths as evidence; the pause reason
 *   only summarises it.
 * - `host_config_restored` (D-ao, spine §5 reading 72): before a role dispatch or resume in a
 *   worktree, `.codex/**`, `.claude/**` or `.mcp.json` differed from the worktree's base commit;
 *   the engine restored them before the host started. The changed paths are the evidence.
 * - `unsandboxed_gate` (D-al, spine §5 reading 69): a gate run executed commands with no OS
 *   sandbox because the user opted in with `~/.vtc/config.yaml` `gates.allow_unsandboxed`
 *   (`GateReport.sandbox: "none"`). Recorded for every such gate run.
 */
export const IncidentKindSchema = z.enum([
  "crash",
  "kill",
  "limit",
  "gate_infra",
  "log_corruption",
  "stale_lock",
  "config_changed",
  "checkout_write",
  "host_config_restored",
  "unsandboxed_gate",
  /** A human adopted a run another clone started (spine §5 reading 88). New in 4.4.0. */
  "run_adopted",
  /** git refused a milestone commit of the `.vtc/` files (spine §5 reading 90). New in 4.4.0. */
  "milestone_commit",
  /**
   * An engine-launched start or resume was refused because the host is not signed in
   * (`HostAdapter.authStatus()`, AD-25 rule 3; spine §5 reading 111). The run pauses; nothing
   * retries. New in 4.6.0.
   */
  "auth",
]);
export type IncidentKind = z.infer<typeof IncidentKindSchema>;

const parkedConsistency = (
  value: {
    to: string;
    park_reason?: z.infer<typeof ParkReasonSchema> | undefined;
    risk_rule?: unknown;
  },
  ctx: z.RefinementCtx,
): void => {
  if ((value.to === "parked") !== (value.park_reason !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["park_reason"],
      message: "park_reason is required for, and only allowed with, to = parked",
    });
  }
  checkParkRiskRule(value, ctx);
};

/**
 * Payload schema per core event type. Keys are the frozen core vocabulary.
 *
 * Replay (AD-7) derives every engine-owned record field from these events and nothing else:
 * - Run: `run.started` (the request, classification, `merge_level_effective` seed, config hash),
 *   `run.phase_changed`, `run.paused`/`run.resumed`, `run.finished`, `gate.approved`/
 *   `gate.rejected` (G1/G2 state), `run.merge_level_changed`;
 * - Task: `task.created` (Planner fields incl. `risk_tags`, cap, budget, origin, and the
 *   immutable intent contract), `task.status_changed` (status, round, park reason and rule),
 *   `task.workspace_assigned` (worktree, branch, baseline),
 *   `task.session_updated` (`session_ref`), `contract.frozen` (`provides_contract.frozen_sha256`),
 *   `budget.updated` scope task (`spent_usd`), `finding.recorded` route `defer` (`deferred`);
 * - Feature: `feature.created`, `feature.task_added` (appends to `tasks`),
 *   `feature.status_changed`, `feature.pr_updated` (incl. the Level-3 merge into main),
 *   `branch.pushed` (Level-2 `done`), `budget.updated` scope feature;
 * - Frozen artifacts: `gate.approved`, then `change_request.decided` (re-freeze) and
 *   `spec.clarified` (wording-only, no CR, §6.2).
 * `role.submitted.session_ref` is a trace of that run only; it never sets `Task.session_ref`.
 */
export const EVENT_PAYLOAD_SCHEMAS = {
  "run.started": IntakeClassificationSchema.extend({
    /**
     * The idea or change request as the Lead passed it to `start` (redacted by the append path,
     * AD-7 rule 12). The only record of the run's input: DISCOVER and SPECIFY read it through the
     * engine's projection `runRequestPath(run)` (pack input type `request`), and the feature title
     * is its first line (`FeatureSchema`).
     */
    request: z.string().min(1).max(20000),
    merge_level: MergeLevelSchema,
    pipeline_config_hash: Sha256HexSchema,
    /**
     * The engine install that started the run (spine §5 reading 88): a random id kept in that
     * install's private directory. Another clone's engine opens the run read-only until a human
     * adopts it, so a git-shared log keeps one writer. Absent on runs started before 4.4.0
     * (treated as another clone's when this install's ledger does not know the log). New in 4.4.0.
     */
    origin: z
      .string()
      .regex(/^[0-9a-f-]{8,64}$/)
      .optional(),
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
  /**
   * Auto-downgrade after a revert or post-merge CI failure, or a human change (§6.7).
   * `no_remote`: Level 2+ in a repo without the push remote; the engine downgrades the run to
   * Level 1 and its tasks reach `done` under the Level-1 rule (spine §5 reading 18).
   */
  "run.merge_level_changed": z
    .strictObject({
      from: MergeLevelSchema,
      to: MergeLevelSchema,
      reason: z.enum(["revert", "post_merge_ci_failure", "human", "no_remote"]),
    })
    .refine((v) => v.from !== v.to, { message: "the level must change", path: ["to"] }),
  "gate.approved": z.strictObject({
    gates: z.array(HumanGateIdSchema).min(1).max(2),
    frozen: z.array(FrozenArtifactSchema).min(1),
    design_direction: SlugSchema.optional(),
    waived_facts: z.array(SlugSchema).default([]),
    /** The reason given for each waived fact (`ApproveInput.fact_waivers`). New in 4.5.0. */
    fact_waivers: z.array(FactWaiverSchema).optional(),
    note: z.string().max(4000).optional(),
  }),
  /**
   * The engine asked the Lead to show a gate (`approve_gate`): what was shown, so Flow Studio can
   * show the same G2 directions and unverified facts. New in 4.5.0.
   */
  "gate.requested": z.strictObject({
    gates: z.array(HumanGateIdSchema).min(1).max(2),
    artifacts: z.array(FrozenArtifactSchema).min(1),
    design_directions: z.array(SlugSchema).max(3).default([]),
    unverified_facts: z.array(SlugSchema).default([]),
    directions: z.array(G2DirectionSchema).max(3).optional(),
    facts: z.array(UnverifiedFactSummarySchema).optional(),
    /** The DESIGN REQ → component → screen check, when the run has UI. */
    design_coverage: DesignCoverageReportSchema.optional(),
  }),
  "gate.rejected": z.strictObject({
    gates: z.array(HumanGateIdSchema).min(1).max(2),
    note: z.string().max(4000).optional(),
  }),
  /**
   * `intent` is the Planner's `TaskDraft.intent`, recorded once (AD-7 rule 8): the immutable
   * `<intent-contract>` block of the plan file and every task pack are rebuilt from it. Absent for
   * engine-created tasks (`origin` other than `planner`), whose pack carries the source finding.
   */
  "task.created": z
    .strictObject({ task: TaskSchema, intent: IntentContractSchema.optional() })
    .refine((v) => (v.task.origin === "planner") === (v.intent !== undefined), {
      message: "intent is required for, and only allowed on, Planner tasks",
      path: ["intent"],
    }),
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
      risk_rule: RiskRuleReasonRuleSchema.optional(),
    })
    .superRefine(parkedConsistency),
  "feature.created": z.strictObject({ feature: FeatureSchema }),
  /**
   * The engine added a task to the feature after PLAN: an integration-fix or out-of-scope task
   * (`Task.origin`, §6.3 step 3, §6.7a). Its `task.created` comes first; Final Review re-runs
   * once it merges.
   */
  "feature.task_added": z.strictObject({ task: TaskIdSchema }),
  "feature.status_changed": z
    .strictObject({
      from: FeatureStatusSchema,
      to: FeatureStatusSchema,
      round: z.int().nonnegative(),
      park_reason: ParkReasonSchema.optional(),
      risk_rule: RiskRuleReasonRuleSchema.optional(),
    })
    .superRefine(parkedConsistency),
  /**
   * The feature's PR was opened or changed: draft → ready after Final Review (Level 2), CI
   * status, and `state: merged` for the Level-3 merge into main (§6.7).
   */
  "feature.pr_updated": z.strictObject({ pr: PullRequestRefSchema }),
  /**
   * The engine pushed the feature's integration branch (Level 2+, §6.7). A merged task is `done`
   * at Level 2 once a push includes its merge commit and the feature's PR is open (§6.4); a
   * failed push leaves it `merged`.
   */
  "branch.pushed": z.strictObject({
    branch: z.string().regex(/^vtc\/F-[1-9]\d*$/, "expected integration branch vtc/F-n"),
    commit: GitShaSchema,
  }),
  /**
   * A Level-2+ push of the integration branch failed (§6.7). Its merged tasks stay `merged`;
   * the next push retries. `detail` is git's redacted message.
   */
  "branch.push_failed": z.strictObject({
    branch: z.string().regex(/^vtc\/F-[1-9]\d*$/, "expected integration branch vtc/F-n"),
    detail: z.string().min(1).max(2000),
  }),
  /** Opening, updating or readying the feature's PR failed (§6.7); `detail` is redacted. */
  "feature.pr_failed": z.strictObject({ detail: z.string().min(1).max(2000) }),
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
    /**
     * SHA-256 of the editable section the pack carried (AD-21): with the compiled locked core it
     * gives the prompt version (`effectivePromptSha`), which the envelope's `prompt_sha` records.
     * New in 4.5.0.
     */
    editable_sha256: Sha256HexSchema.optional(),
    /** The Lookback canary arm this dispatch ran in, when a canary covers the role. New in 4.5.0. */
    canary_arm: z.enum(["candidate", "baseline"]).optional(),
  }),
  "role.submitted": z
    .strictObject({
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
      /**
       * The commit the result refers to (§6.3 steps 4–5). On submit of a role that wrote to the
       * task worktree (Engineer family, QA author) the engine commits the worktree onto the task
       * branch itself (roles never need to commit) and records the commit here; the write-scope
       * check and the gates run on `base..head`, and stuck detection compares heads' trees.
       * Required for `built`.
       */
      head: GitShaSchema.optional(),
    })
    .refine((v) => v.exit !== "built" || v.head !== undefined, {
      message: "a built result names the commit it built (head)",
      path: ["head"],
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
  /**
   * The merge queue merged a task into the feature's integration branch (§6.7). The Level-3 merge
   * of the feature PR into main has no task and is a `feature.pr_updated` with `state: merged`.
   */
  "merge.completed": z.strictObject({
    into: z.string().min(1).max(255),
    commit: GitShaSchema,
    level: MergeLevelSchema,
  }),
  // ---- headless runs (AD-25), new in 4.5.0
  /** The checks before an engine-launched start or resume (auth, usage, pause, config, budget). */
  "headless.preflight": HeadlessPreflightSchema,
  "headless.started": HeadlessStartedSchema,
  "headless.ended": HeadlessEndedSchema,
  // ---- Level 3 (AD-23), new in 4.5.0
  /** The Level-3 preflight at run start; a failure starts the run at Level 2. */
  "merge.preflight": MergePreflightSchema,
  /** The §6.7 safe-to-auto-merge checklist, evaluated before enabling auto-merge. */
  "feature.checklist": AutoMergeChecklistSchema,
  "feature.auto_merge_enabled": AutoMergeEnabledSchema,
  "feature.auto_merge_disabled": AutoMergeDisabledSchema,
  "feature.post_merge_ci": PostMergeCiSchema,
  "feature.reverted": FeatureRevertedSchema,
  // ---- Final Review (§6.7a), new in 4.5.0
  "final_review.step_finished": FinalReviewStepResultSchema,
  // ---- research (AD-22), new in 4.5.0
  "research.fetched": ResearchFetchedSchema,
  "fact.recorded": z.strictObject({ fact: FactRowSchema }),
  /** A fact's status changed after (re)verification or a re-fetch before G2. */
  "fact.verified": z.strictObject({
    id: FactIdSchema,
    status: FactStatusSchema,
    detail: z.string().min(1).max(500).optional(),
  }),
  "fact.waived": FactWaiverSchema,
  // ---- Lookback (AD-21), new in 4.5.0
  /** The engine queued the lookback role for one (role, host) at run end. */
  "lookback.dispatched": z.strictObject({
    target_role: RoleIdSchema,
    target_mode: SlugSchema.optional(),
    target_host: HostIdSchema,
    train_failures: z.int().nonnegative(),
  }),
  "lookback.proposal_recorded": z.strictObject({
    proposal: SlugSchema,
    path: RelPathSchema,
    changes: z.int().min(1).max(3),
  }),
  "lookback.replay_finished": z.strictObject({
    proposal: SlugSchema,
    verdict: ReplayVerdictSchema,
    path: RelPathSchema,
    /**
     * SHA-256 of the replay result file's bytes as the engine wrote them, so `vtc lookback
     * approve` can tell the engine's file from an edited one (spine §5 reading 128). New in 4.6.0.
     */
    sha256: Sha256HexSchema.optional(),
  }),
  /** A task's canary arm (sticky across its fix rounds). */
  "lookback.canary_assigned": z.strictObject({
    arm: z.enum(["candidate", "baseline"]),
    candidate: Sha256HexSchema,
    baseline: Sha256HexSchema,
  }),
  "lookback.canary_evaluated": CanaryStateSchema,
  /** The engine rolled a canary back (`pins.yaml` history `auto_rollback`). */
  "lookback.rolled_back": z.strictObject({
    target_role: RoleIdSchema,
    target_mode: SlugSchema.optional(),
    target_host: HostIdSchema,
    from: Sha256HexSchema,
    to: Sha256HexSchema,
    reason: z.string().min(1).max(300),
  }),
  /** A Level-3 merge was reverted or broke base CI: an escaped defect for attribution (§6.7). */
  "lookback.escaped_defect": EscapedDefectSchema,
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
 * `null` (unknown or unpriced) but never absent. A host-reported cost is kept even when the model
 * is unknown and counts toward budgets (D-at, `RunUsageSchema`).
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
  "feature.task_added": ["feature"],
  "feature.status_changed": ["feature"],
  "feature.pr_updated": ["feature"],
  "branch.pushed": ["feature"],
  "branch.push_failed": ["feature"],
  "feature.pr_failed": ["feature"],
  "role.dispatched": ["role", "prompt_sha", "host", "model"],
  "role.submitted": ["role", "prompt_sha", "host", "model", "tokens", "cost_usd"],
  "role.rejected": ["role"],
  "role.failed": ["role"],
  "merge.completed": ["task"],
  "headless.started": ["role", "host"],
  "headless.ended": ["role", "host"],
  "feature.checklist": ["feature"],
  "feature.auto_merge_enabled": ["feature"],
  "feature.auto_merge_disabled": ["feature"],
  "feature.post_merge_ci": ["feature"],
  "feature.reverted": ["feature"],
  "final_review.step_finished": ["feature"],
  "lookback.canary_assigned": ["task", "role"],
  "lookback.escaped_defect": ["feature"],
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
