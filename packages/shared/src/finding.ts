/** Finding contract (§6.3 step 8 triage, §16 Finding). */
import { z } from "zod";
import {
  EvidenceSchema,
  FeatureIdSchema,
  IsoDateTimeSchema,
  LocationSchema,
  RequirementIdSchema,
  SeveritySchema,
  Sha256HexSchema,
  TaskIdSchema,
} from "./primitives.js";

/** What kind of problem a finding describes. Role findings get their severity from this (§6.3). */
export const FindingCategorySchema = z.enum([
  "secret",
  "security",
  "supply_chain",
  "test_integrity",
  "correctness",
  "spec_mismatch",
  "test_adequacy",
  "accessibility",
  "architecture",
  "performance",
  "design",
  "maintainability",
  "docs",
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

/**
 * Where triage sends a finding (§6.3 step 8):
 * patch → Engineer; spec_gap → BA; design_gap → Designer; bad_test → QA; risky → park;
 * defer → `deferred[]`; out_of_scope → owning task or a new integration-fix task (§6.3 step 3).
 */
export const FindingRouteSchema = z.enum([
  "patch",
  "spec_gap",
  "design_gap",
  "bad_test",
  "risky",
  "defer",
  "out_of_scope",
]);
export type FindingRoute = z.infer<typeof FindingRouteSchema>;

/** `discarded` = cited evidence did not resolve (§6.3 step 8). `waived` needs an expiring human waiver (§8.5). */
export const FindingStatusSchema = z.enum(["open", "resolved", "deferred", "waived", "discarded"]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingSourceSchema = z.enum(["tool", "role"]);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

/**
 * What a reviewer role submits inside a RoleResult. The engine adds fingerprint, severity,
 * route and status. `claimed_severity` is recorded for Lookback but never used (§6.3 step 8).
 */
export const FindingDraftSchema = z.strictObject({
  rule_id: z.string().min(1).max(200),
  category: FindingCategorySchema,
  title: z.string().min(1).max(200),
  message: z.string().max(4000).optional(),
  confidence: z.number().min(0).max(1),
  location: LocationSchema,
  evidence: EvidenceSchema,
  req_ids: z.array(RequirementIdSchema).default([]),
  /** Code the finding is about; whitespace-normalised into the fingerprint. */
  snippet: z.string().max(4000).optional(),
  claimed_severity: SeveritySchema.optional(),
});
export type FindingDraft = z.infer<typeof FindingDraftSchema>;

export const WaiverSchema = z.strictObject({
  by: z.literal("human"),
  reason: z.string().min(1).max(2000),
  expires_at: IsoDateTimeSchema,
});
export type Waiver = z.infer<typeof WaiverSchema>;

/** A finding as recorded by the engine after triage. */
export const FindingSchema = z
  .strictObject({
    fingerprint: Sha256HexSchema,
    source: FindingSourceSchema,
    /** Tool name (e.g. `opengrep`) or role id (e.g. `security`). */
    source_name: z.string().min(1).max(100),
    rule_id: z.string().min(1).max(200),
    category: FindingCategorySchema,
    title: z.string().min(1).max(200),
    message: z.string().max(4000).optional(),
    severity: SeveritySchema,
    claimed_severity: SeveritySchema.optional(),
    confidence: z.number().min(0).max(1),
    location: LocationSchema,
    evidence: EvidenceSchema,
    req_ids: z.array(RequirementIdSchema).default([]),
    snippet: z.string().max(4000).optional(),
    route: FindingRouteSchema,
    /** For `out_of_scope`: the task that owns the cited location; absent = open an integration-fix task. */
    owner_task: TaskIdSchema.optional(),
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    round_first_seen: z.int().positive(),
    round_last_seen: z.int().positive().optional(),
    status: FindingStatusSchema,
    waiver: WaiverSchema.optional(),
  })
  .superRefine((finding, ctx) => {
    if (finding.status === "waived" && finding.waiver === undefined) {
      ctx.addIssue({ code: "custom", path: ["waiver"], message: "waived requires a waiver" });
    }
    if (finding.owner_task !== undefined && finding.route !== "out_of_scope") {
      ctx.addIssue({
        code: "custom",
        path: ["owner_task"],
        message: "owner_task is only allowed on out_of_scope findings",
      });
    }
    if (
      finding.round_last_seen !== undefined &&
      finding.round_last_seen < finding.round_first_seen
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["round_last_seen"],
        message: "round_last_seen must be >= round_first_seen",
      });
    }
  });
export type Finding = z.infer<typeof FindingSchema>;
