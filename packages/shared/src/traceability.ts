/**
 * Traceability formats shared by QA prompts, the Gate Runner's traceability builder and triage
 * (§6.3 step 2, §7.4). REQ tags in test names (and so in JUnit output) link tests to
 * requirements; every assertion names its provenance.
 */
import { z } from "zod";
import {
  DisciplineSchema,
  EvidenceSchema,
  FeatureIdSchema,
  IsoDateTimeSchema,
  RelPathSchema,
  RequirementRefSchema,
  RoleIdSchema,
  RunIdSchema,
  Sha256HexSchema,
  TaskIdSchema,
  TokenUsageSchema,
  VerdictSubjectSchema,
  type RequirementRef,
} from "./primitives.js";
import { VerdictSchema } from "./role-result.js";

/** Tag form in a test name: `[REQ-3]` or `[REQ-3.AC-2]`; a name may carry several. */
export const formatReqTag = (ref: RequirementRef): string => `[${RequirementRefSchema.parse(ref)}]`;

const TAG = /\[((?:REQ|SEC)-[1-9]\d*(?:\.AC-[1-9]\d*)?)\]/g;

/** Every REQ/AC tag in a test name, in order of first appearance, without duplicates. */
export const parseReqTags = (testName: string): RequirementRef[] => {
  const found: RequirementRef[] = [];
  for (const match of testName.matchAll(TAG)) {
    const ref = match[1];
    if (ref !== undefined && !found.includes(ref)) found.push(ref);
  }
  return found;
};

/**
 * Where an assertion's expectation comes from (§6.3 step 2): a quoted spec reference, or
 * `observed` baseline behaviour with no spec backing. Failures on `observed` assertions route
 * as possible spec gaps, not as Engineer bugs.
 */
export const AssertionProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("spec"),
    ref: RequirementRefSchema,
    quote: z.string().min(1).max(500),
  }),
  z.strictObject({ kind: z.literal("observed") }),
]);
export type AssertionProvenance = z.infer<typeof AssertionProvenanceSchema>;

/** Text form written next to an assertion: `spec:REQ-3.AC-2 "quote"` or `observed`. */
export const formatProvenance = (provenance: AssertionProvenance): string => {
  const valid = AssertionProvenanceSchema.parse(provenance);
  return valid.kind === "observed"
    ? "observed"
    : `spec:${valid.ref} ${JSON.stringify(valid.quote)}`;
};

/** Parses the text form; `null` when it is not a valid provenance tag. */
export const parseProvenance = (text: string): AssertionProvenance | null => {
  const trimmed = text.trim();
  if (trimmed === "observed") return { kind: "observed" };
  const match = /^spec:(\S+) ("(?:[^"\\]|\\.)*")$/.exec(trimmed);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  let quote: unknown;
  try {
    quote = JSON.parse(match[2]);
  } catch {
    return null;
  }
  const parsed = AssertionProvenanceSchema.safeParse({ kind: "spec", ref: match[1], quote });
  return parsed.success ? parsed.data : null;
};

// -------------------------------------------------------------- traceability

/** Outcome of one test in the traceability matrix (from JUnit, §7.4). */
export const TraceTestStatusSchema = z.enum(["pass", "fail", "skipped", "error"]);
export type TraceTestStatus = z.infer<typeof TraceTestStatusSchema>;

export const TraceTestSchema = z.strictObject({
  /** Test id as it appears in JUnit output (carries the REQ tags). */
  id: z.string().min(1).max(500),
  status: TraceTestStatusSchema,
  /** A hidden acceptance test (§7.3), run only at gate time. */
  hidden: z.boolean().default(false),
  /** Sources of its assertions (§6.3 step 2): all spec-backed, all observed, or both. */
  provenance: z.enum(["spec", "observed", "mixed", "unknown"]).default("unknown"),
});
export type TraceTest = z.infer<typeof TraceTestSchema>;

/** One requirement or AC with the tests that cover it. Covered = at least one passing test. */
export const TraceRowSchema = z
  .strictObject({
    req: RequirementRefSchema,
    tests: z.array(TraceTestSchema).default([]),
    covered: z.boolean(),
  })
  .superRefine((row, ctx) => {
    if (row.covered !== row.tests.some((t) => t.status === "pass")) {
      ctx.addIssue({
        code: "custom",
        path: ["covered"],
        message: "covered is true exactly when at least one test passes",
      });
    }
  });
export type TraceRow = z.infer<typeof TraceRowSchema>;

/**
 * The traceability report the Gate Runner builds by code (§7.4): REQ tags in JUnit output,
 * per-test coverage and the diff. A REQ with no passing test is a gap; a changed file no REQ
 * covers is a scope-creep flag. Written to `.vtc/evidence/<T-n|F-n>/traceability.json`.
 */
export const TraceabilityReportSchema = z
  .strictObject({
    run: RunIdSchema,
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    rows: z.array(TraceRowSchema),
    gaps: z.array(RequirementRefSchema).default([]),
    scope_creep: z.array(RelPathSchema).default([]),
    built_at: IsoDateTimeSchema,
  })
  .superRefine((report, ctx) => {
    if ((report.task === undefined) === (report.feature === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["task"],
        message: "a traceability report is for exactly one task or one feature",
      });
    }
    const uncovered = report.rows.filter((r) => !r.covered).map((r) => r.req);
    if ([...uncovered].sort().join() !== [...new Set(report.gaps)].sort().join()) {
      ctx.addIssue({
        code: "custom",
        path: ["gaps"],
        message: "gaps are exactly the rows that are not covered",
      });
    }
  });
export type TraceabilityReport = z.infer<typeof TraceabilityReportSchema>;
export type TraceabilityReportInput = z.input<typeof TraceabilityReportSchema>;

// ------------------------------------------------------------ final review steps

/**
 * One §6.7a Final Review step's result (new in 4.5.0): `pass`/`fail`; `not_run` (the step does
 * not apply, e.g. Visual QA on a feature without UI, with the reason); `unchecked` (it should
 * have run and could not, which never counts as a pass); `skipped` (the visual step had no
 * browser, D-ay). AI steps (3–5) cite the role verdicts they rest on.
 */
export const FinalReviewStepResultSchema = z
  .strictObject({
    step: z.int().min(1).max(7),
    status: z.enum(["pass", "fail", "not_run", "unchecked", "skipped"]),
    reason: z.string().min(1).max(500).optional(),
    evidence: z.array(EvidenceSchema).default([]),
  })
  .refine((r) => r.status === "pass" || r.status === "fail" || r.reason !== undefined, {
    message: "a step that did not run says why",
    path: ["reason"],
  });
export type FinalReviewStepResult = z.infer<typeof FinalReviewStepResultSchema>;

/** The §6.7a step 7 checklist items, in spec order. */
export const RELEASE_READINESS_ITEMS = [
  "migration_order",
  "config_changes",
  "rollback_notes",
  "docs",
  "changelog",
  "feature_flags",
] as const;

/** Release readiness (§6.7a step 7): each item passes, fails or does not apply, with evidence. */
export const ReleaseReadinessSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          id: z.enum(RELEASE_READINESS_ITEMS),
          status: z.enum(["pass", "fail", "not_applicable"]),
          note: z.string().min(1).max(1000).optional(),
          evidence: z.array(EvidenceSchema).default([]),
        }),
      )
      .length(RELEASE_READINESS_ITEMS.length),
    ok: z.boolean(),
  })
  .superRefine((r, ctx) => {
    if (r.items.some((item, i) => item.id !== RELEASE_READINESS_ITEMS[i])) {
      ctx.addIssue({ code: "custom", path: ["items"], message: "items in spec order, once each" });
    }
    if (r.ok !== r.items.every((item) => item.status !== "fail")) {
      ctx.addIssue({
        code: "custom",
        path: ["ok"],
        message: "ok is true exactly when no item fails",
      });
    }
  });
export type ReleaseReadiness = z.infer<typeof ReleaseReadinessSchema>;

/**
 * The scope-creep flag (§7.4): the Gate Runner emits one `ToolFinding` with this rule id per
 * `TraceabilityReport.scope_creep` path (a changed file no REQ covers), `category`
 * `spec_mismatch`, `sarif_level` `none` (so it is `info` and routes `defer`: it is listed in the
 * evidence bundle and shown at Final Review step 3, never blocks by itself). New in 4.5.0.
 */
export const SCOPE_CREEP_RULE_ID = "vtc/scope-creep";

// ------------------------------------------------------------ evidence bundle

const SpendSchema = z.strictObject({
  /** List-price-equivalent USD (§11); `null` when a model was missing from the price table. */
  usd: z.number().nonnegative().nullable(),
  tokens: TokenUsageSchema,
});

const FindingCountsSchema = z.strictObject({
  open: z.int().nonnegative(),
  resolved: z.int().nonnegative(),
  deferred: z.int().nonnegative(),
  waived: z.int().nonnegative(),
  discarded: z.int().nonnegative(),
});

/**
 * The evidence bundle (§6.7a output, §14): per task, and per feature for the PR description.
 * Written by the engine to `.vtc/evidence/<T-n|F-n>/bundle.json` (`evidenceBundlePath`), after
 * redaction (AD-18); Flow Studio reads it through the artifacts route.
 */
export const EvidenceBundleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("task"),
    run: RunIdSchema,
    task: TaskIdSchema,
    feature: FeatureIdSchema.optional(),
    discipline: DisciplineSchema,
    rounds: z.int().nonnegative(),
    cap: z.int().min(3).max(5),
    traceability: TraceabilityReportSchema,
    findings: FindingCountsSchema,
    /** Redacted gate reports under `.vtc/evidence/`. */
    gate_reports: z.array(RelPathSchema).default([]),
    verdicts: z
      .array(
        z.strictObject({
          role: RoleIdSchema,
          subject: VerdictSubjectSchema,
          verdict: VerdictSchema,
          prompt_sha: Sha256HexSchema,
        }),
      )
      .default([]),
    spend: SpendSchema,
    written_at: IsoDateTimeSchema,
  }),
  z.strictObject({
    kind: z.literal("feature"),
    run: RunIdSchema,
    feature: FeatureIdSchema,
    tasks: z
      .array(
        z.strictObject({
          task: TaskIdSchema,
          discipline: DisciplineSchema,
          rounds: z.int().nonnegative(),
          spend: SpendSchema,
        }),
      )
      .min(1),
    by_discipline: z.array(z.strictObject({ discipline: DisciplineSchema, spend: SpendSchema })),
    traceability: TraceabilityReportSchema,
    findings: FindingCountsSchema,
    /** Fingerprints of deferred findings (§6.7a step 3: deferred items are listed). */
    deferred: z.array(Sha256HexSchema).default([]),
    final_review: z.strictObject({
      verdict: z.enum(["pending", "pass", "fail", "parked"]),
      rounds: z.int().min(0).max(3),
      /**
       * The §6.7a steps (1 full gates … 7 release readiness) whose results produced the verdict,
       * ascending and unique. Empty = not recorded (bundles written before 4.1.0).
       */
      steps_run: z
        .array(z.int().min(1).max(7))
        .max(7)
        .default([])
        .refine((steps) => steps.every((step, i) => i === 0 || step > (steps[i - 1] ?? 0)), {
          message: "steps_run is ascending and unique",
        }),
    }),
    /** One result per §6.7a step, in step order (absent on bundles before 4.5.0). */
    final_review_steps: z.array(FinalReviewStepResultSchema).max(7).optional(),
    /** §6.7a step 7, when it ran. New in 4.5.0. */
    release_readiness: ReleaseReadinessSchema.optional(),
    spend: SpendSchema,
    written_at: IsoDateTimeSchema,
  }),
]);
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

/** `.vtc/evidence/<T-n|F-n>/bundle.json`. */
export const evidenceBundlePath = (id: string): string => {
  if (!/^[TF]-[1-9]\d*$/.test(id)) throw new TypeError(`expected a task or feature id, got ${id}`);
  return `.vtc/evidence/${id}/bundle.json`;
};
