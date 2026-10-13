/** Finding contract (§6.3 step 8 triage, §16 Finding). */
import { z } from "zod";
import {
  EvidenceSchema,
  FeatureIdSchema,
  IsoDateTimeSchema,
  LocationSchema,
  RequirementRefSchema,
  SeveritySchema,
  Sha256HexSchema,
  TaskIdSchema,
} from "./primitives.js";

/** CWE id, required on Security verify-mode findings by the role prompt (§5.2). */
export const CweIdSchema = z.string().regex(/^CWE-[1-9]\d*$/, "expected a CWE id like CWE-79");
export type CweId = z.infer<typeof CweIdSchema>;

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
 * defer → `deferred[]`.
 * `out_of_scope` is a spine extension (AD-3 rule 7), not a §6.3 step 8 route: it records an
 * Engineer `out_of_scope_fault` whose guards passed, routed to the owning task or a new
 * integration-fix task (§6.3 step 3, §6.7a).
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

/**
 * What the reviewer says went wrong; the routing signal triage needs (§6.3 step 8,
 * `routeForFinding`):
 * - `implementation_deviation`: the code does not do what the spec, design or tests say → Engineer;
 * - `design_ambiguity`: the design does not say what to do (§7.5 "ambiguity → Designer");
 * - `observed_mismatch`: a failure on an `observed` assertion with no spec backing, a possible
 *   spec gap (§6.3 step 2);
 * - `spec_ambiguity`: the spec is unclear or contradictory → BA;
 * - `test_defect`: the test is wrong, or passes while behaviour is wrong → QA (§13).
 */
export const FindingKindSchema = z.enum([
  "implementation_deviation",
  "design_ambiguity",
  "observed_mismatch",
  "spec_ambiguity",
  "test_defect",
]);
export type FindingKind = z.infer<typeof FindingKindSchema>;
export type FindingSource = z.infer<typeof FindingSourceSchema>;

/**
 * What a reviewer role submits inside a RoleResult. The engine adds fingerprint, severity,
 * route and status. `claimed_severity` is recorded for Lookback but never used (§6.3 step 8).
 */
export const FindingDraftSchema = z.strictObject({
  rule_id: z.string().min(1).max(200),
  category: FindingCategorySchema,
  kind: FindingKindSchema,
  title: z.string().min(1).max(200),
  message: z.string().max(4000).optional(),
  confidence: z.number().min(0).max(1),
  location: LocationSchema,
  evidence: EvidenceSchema,
  req_ids: z.array(RequirementRefSchema).default([]),
  /** Code the finding is about; whitespace-normalised into the fingerprint. */
  snippet: z.string().max(4000).optional(),
  cwe: CweIdSchema.optional(),
  claimed_severity: SeveritySchema.optional(),
});
export type FindingDraft = z.infer<typeof FindingDraftSchema>;

/** SARIF 2.1.0 `result.level`, carried raw so triage can normalise it (`normalizeSeverity`). */
export const SarifLevelSchema = z.enum(["error", "warning", "note", "none"]);

/**
 * One new (non-baseline) violation a tool reported, as the Gate Runner extracts it from a
 * scanner or linter report (SARIF, JSON, text; AD-13 rule 9: the Gate Runner owns every report
 * parser). It carries the tool's raw severity signals, never a normalised severity: engine-core
 * triage turns each into a {@link Finding} (`fingerprintFinding`, `normalizeSeverity` with
 * `source: "tool"`, `routeForFinding`, dedupe), exactly as for role findings (§6.3 step 8).
 */
export const ToolFindingSchema = z.strictObject({
  /** Tool name, e.g. `opengrep`, `gitleaks`, `osv-scanner`, `eslint`. Becomes `source_name`. */
  tool: z.string().min(1).max(100),
  rule_id: z.string().min(1).max(200),
  category: FindingCategorySchema,
  title: z.string().min(1).max(200),
  message: z.string().max(4000).optional(),
  location: LocationSchema,
  /** Points into the redacted report, e.g. `sarif` `report-path#result-index`. */
  evidence: EvidenceSchema,
  /** Code the finding is about, redacted; whitespace-normalised into the fingerprint. */
  snippet: z.string().max(4000).optional(),
  cwe: CweIdSchema.optional(),
  /** Raw severity inputs, in `normalizeSeverity` precedence: score, then label, then level. */
  score: z.number().min(0).max(10).optional(),
  label: z.string().min(1).max(50).optional(),
  sarif_level: SarifLevelSchema.optional(),
});
export type ToolFinding = z.infer<typeof ToolFindingSchema>;

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
    /** Role findings carry the reviewer's kind; tool findings have none. */
    kind: FindingKindSchema.optional(),
    title: z.string().min(1).max(200),
    message: z.string().max(4000).optional(),
    severity: SeveritySchema,
    claimed_severity: SeveritySchema.optional(),
    confidence: z.number().min(0).max(1),
    location: LocationSchema,
    evidence: EvidenceSchema,
    req_ids: z.array(RequirementRefSchema).default([]),
    snippet: z.string().max(4000).optional(),
    cwe: CweIdSchema.optional(),
    route: FindingRouteSchema,
    /**
     * For `out_of_scope`: the task that owns the cited location; absent = the engine opens an
     * integration-fix task (`Task.origin`, `source_finding` = this fingerprint).
     */
    owner_task: TaskIdSchema.optional(),
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    /**
     * Round the finding was first seen in: the task's round (`Task.round`) for task findings, the
     * feature's Final Review round (`Feature.round`) for feature findings without a task (§6.7a).
     */
    round_first_seen: z.int().positive(),
    round_last_seen: z.int().positive().optional(),
    status: FindingStatusSchema,
    waiver: WaiverSchema.optional(),
  })
  .superRefine((finding, ctx) => {
    if (finding.source === "role" && finding.kind === undefined) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: "role findings carry a kind" });
    }
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
