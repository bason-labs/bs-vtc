/**
 * Gate Runner contracts (§6.3 steps 4–5 and 8, §7.2, AD-13). The Gate Runner (engine module
 * `gates/`, sub-project 2) produces them; triage, the loop controller, the merge queue, Final
 * Review and the dashboard's gate-report drill-down consume them. The `gate.result` event
 * carries one {@link GateReport}.
 */
import { z } from "zod";
import { ToolFindingSchema } from "./finding.js";
import { GateLayerSchema, GatePhaseSchema, ReportFormatSchema } from "./gates-config.js";
import {
  EvidenceSchema,
  FeatureIdSchema,
  GitShaSchema,
  GlobSchema,
  IsoDateTimeSchema,
  RelPathSchema,
  RequirementRefSchema,
  RunIdSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
} from "./primitives.js";

/**
 * Failure classification (§6.3 step 8). Deterministic rules decide first; a low-tier judge
 * handles only ambiguous cases ("unsure means product"). `environment` and `infra` go to the
 * gate-infra path (§6.8), never to the Engineer; `flaky` gets one re-run.
 */
export const FailureClassSchema = z.enum(["product", "environment", "flaky", "infra"]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const GateStatusSchema = z.enum(["pass", "fail", "error", "skipped"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

/**
 * Why gates run: per round (affected-only), in the merge queue, in Final Review, calibrating,
 * or for one of the engine's guards that need real test runs:
 * - `base_fail_check`: QA's new acceptance tests must **fail** on the base commit before the
 *   Engineer starts (§6.3 step 2, §7.3);
 * - `fault_repro`: an Engineer `out_of_scope_fault` must reproduce on the base plus published
 *   contracts without this task's diff (§6.3 step 3).
 */
export const GateRunReasonSchema = z.enum([
  "round",
  "merge_queue",
  "final_review",
  "calibration",
  "base_fail_check",
  "fault_repro",
]);
export type GateRunReason = z.infer<typeof GateRunReasonSchema>;

/** A test id as it appears in JUnit output (it carries the REQ tags, §7.4). */
export const TestIdSchema = z.string().min(1).max(500);
export type TestId = z.infer<typeof TestIdSchema>;

/** One test of an L2 run. `assertions` = the runner's count (JUnit `assertions`), `null` = not reported. */
export const TestRecordSchema = z.strictObject({
  id: TestIdSchema,
  status: z.enum(["pass", "fail", "skipped", "error"]),
  assertions: z.int().nonnegative().nullable(),
});
export type TestRecord = z.infer<typeof TestRecordSchema>;

/**
 * The test inventory of one L2 run, sorted by id with no duplicates. The Gate Runner writes it,
 * redacted, next to the run's L2 report under `.vtc/evidence/` (`TestMetrics.inventory`); it is
 * what the monotonic comparison reads (§7.3), so the event log carries only its path and counts.
 */
export const TestInventorySchema = z
  .strictObject({ v: z.literal(1), tests: z.array(TestRecordSchema) })
  .superRefine((inventory, ctx) => {
    const ids = inventory.tests.map((t) => t.id);
    if (ids.some((id, i) => i > 0 && (ids[i - 1] ?? "") >= id)) {
      ctx.addIssue({
        code: "custom",
        path: ["tests"],
        message: "tests are sorted by id, without duplicates",
      });
    }
  });
export type TestInventory = z.infer<typeof TestInventorySchema>;

/**
 * L2 metrics of one run (§7.2 L2, §7.3 monotonic metrics): counts, the inventory with every
 * executed test id and its assertion count, and coverage (`null` = not measured). Mutation score
 * is v1.1 (spine §4) and has no field yet.
 */
export const TestMetricsSchema = z.strictObject({
  executed: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  inventory: RelPathSchema,
  line_coverage_pct: z.number().min(0).max(100).nullable().default(null),
  diff_coverage_pct: z.number().min(0).max(100).nullable().default(null),
});
export type TestMetrics = z.infer<typeof TestMetricsSchema>;

/**
 * Ways L2 metrics got worse than `GateRunRequest.compare_to` (§7.3). The Gate Runner computes
 * them and fails the L2 gate (`product`) when any is found:
 * - `test_missing`: a test `compare_to` executed and this run selected did not execute;
 * - `test_skipped`: such a test is now skipped, or the skipped count grew;
 * - `assertions_dropped`: a test reports fewer assertions than before;
 * - `coverage_dropped`: line or diff coverage is lower than before.
 */
export const MonotonicViolationSchema = z.strictObject({
  kind: z.enum(["test_missing", "test_skipped", "assertions_dropped", "coverage_dropped"]),
  test: TestIdSchema.optional(),
});
export type MonotonicViolation = z.infer<typeof MonotonicViolationSchema>;

/** The result of one gate in one run. */
export const GateResultSchema = z
  .strictObject({
    gate_id: SlugSchema,
    layer: GateLayerSchema,
    phase: GatePhaseSchema,
    status: GateStatusSchema,
    /** Copied from the gate config: only L6 may be non-blocking (§8.5). */
    blocking: z.boolean(),
    /** Violations not in the baseline: only these block (§7.1). */
    new_violations: z.int().nonnegative(),
    baseline_violations: z.int().nonnegative(),
    /** L2 only. */
    tests: TestMetricsSchema.optional(),
    /** L2 only: how the metrics got worse than the request's `compare_to` (§7.3). */
    monotonic: z.array(MonotonicViolationSchema).default([]),
    /** Redacted report under `.vtc/evidence/` (§7.2: raw output stays in `.vtc/state/`). */
    report: z.strictObject({ format: ReportFormatSchema, path: RelPathSchema }).optional(),
    /**
     * The new (non-baseline) violations a scanner or linter reported, parsed by the Gate Runner
     * from its report (AD-13 rule 9). Engine-core triage turns each into a `Finding`.
     */
    findings: z.array(ToolFindingSchema).default([]),
    /** Required when status is fail or error. */
    failure_class: FailureClassSchema.optional(),
    evidence: z.array(EvidenceSchema).default([]),
    duration_ms: z.int().nonnegative(),
    /** Why a gate was skipped, e.g. `when_changed` did not match. */
    skipped_reason: z.string().min(1).max(300).optional(),
  })
  .superRefine((result, ctx) => {
    const failed = result.status === "fail" || result.status === "error";
    if (failed && result.failure_class === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["failure_class"],
        message: "a failed or errored gate must be classified",
      });
    }
    if (!failed && result.failure_class !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["failure_class"],
        message: "failure_class is only allowed on fail or error",
      });
    }
    if (result.tests !== undefined && result.layer !== "L2") {
      ctx.addIssue({ code: "custom", path: ["tests"], message: "test counts belong to L2 gates" });
    }
    if (result.monotonic.length > 0 && (result.layer !== "L2" || result.status !== "fail")) {
      ctx.addIssue({
        code: "custom",
        path: ["monotonic"],
        message: "monotonic violations belong to a failed L2 gate",
      });
    }
    if (result.findings.length > result.new_violations) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "findings are new violations: no more than new_violations",
      });
    }
    if ((result.status === "skipped") !== (result.skipped_reason !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["skipped_reason"],
        message: "skipped gates, and only skipped gates, carry a skipped_reason",
      });
    }
    if (!result.blocking && result.layer !== "L6") {
      ctx.addIssue({
        code: "custom",
        path: ["blocking"],
        message: "only L6 gates may be non-blocking",
      });
    }
  });
export type GateResult = z.infer<typeof GateResultSchema>;
export type GateResultInput = z.input<typeof GateResultSchema>;

/**
 * Hidden acceptance tests (§6.3 step 2, §7.3). QA author mode writes them as artifact type
 * `hidden_acceptance_test` into the staging directory (gitignored); after accepting the result
 * the engine moves them to `~/.vtc/hidden/<repo-key>/<task>/`, outside the repo. The Gate Runner
 * copies them into the clean checkout only for a run with `include_hidden` (§7.3: "copied in
 * only at gate time") and never writes them to evidence.
 */
export const HIDDEN_TESTS = {
  artifactType: "hidden_acceptance_test",
  /** Repo-relative staging directory; one sub-directory per task. */
  stagingDir: ".vtc/state/hidden-staging",
  /** Directory under the VTC home (`~/.vtc/`); `<repo-key>/<task>/` below it. */
  homeDir: "hidden",
} as const;

/**
 * Visible acceptance tests (§6.3 step 2). QA author mode writes them inside the project's
 * `GatesConfig.tests.acceptance_globs` (its effective write scope) and declares them as artifacts
 * of this type; it names their JUnit ids in `RoleResult.acceptance_tests`, which become the
 * `tests` of the `base_fail_check` run. After acceptance the engine protects each file by
 * checksum (`GateRunRequest.protected`, §7.3).
 */
export const ACCEPTANCE_TESTS = { artifactType: "acceptance_test" } as const;

/** What a run expects of the selected tests: `fail` only for `base_fail_check`. */
export const GateExpectSchema = z.enum(["pass", "fail"]);
export type GateExpect = z.infer<typeof GateExpectSchema>;

/**
 * What the engine asks the Gate Runner to verify. `checkout` is the clean verification checkout
 * (§6.3 step 5), repo-relative under `.vtc/state/`.
 */
export const GateRunRequestSchema = z
  .strictObject({
    run: RunIdSchema,
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    reason: GateRunReasonSchema,
    /** `affected` per round; `full` in the merge queue and Final Review (§7.2). */
    scope: z.enum(["affected", "full"]),
    base: GitShaSchema,
    head: GitShaSchema,
    checkout: RelPathSchema,
    /** Layers to run; default all configured layers. */
    layers: z.array(GateLayerSchema).optional(),
    /** L5 write scope (the task's files_scope). */
    files_scope: z.array(GlobSchema).default([]),
    /** L5 protected files with their expected checksums (QA-owned tests, configs; §7.3). */
    protected: z
      .array(z.strictObject({ path: RelPathSchema, sha256: Sha256HexSchema }))
      .default([]),
    /** Affected-only selection input (§7.2): REQ tags of the task. */
    req_tags: z.array(RequirementRefSchema).default([]),
    /** Run exactly these test ids (JUnit ids) instead of the selection rules; e.g. QA's new tests. */
    tests: z.array(TestIdSchema).optional(),
    /**
     * L2 metrics to compare against (§7.3 monotonic metrics): engine core passes the task's
     * previous L2 metrics at the same `scope`, or for a feature's full run its previous full run;
     * absent on the first run. The Gate Runner itself keeps no history: it reads
     * `compare_to.inventory` and reports {@link MonotonicViolation}s.
     */
    compare_to: TestMetricsSchema.optional(),
    /** `fail` for `base_fail_check`: the selected tests are expected to fail (product failures). */
    expect: GateExpectSchema.default("pass"),
    /** Copy the task's hidden acceptance tests into the checkout for this run (§7.3). */
    include_hidden: z.boolean().default(false),
  })
  .superRefine((request, ctx) => {
    if ((request.reason === "base_fail_check") !== (request.expect === "fail")) {
      ctx.addIssue({
        code: "custom",
        path: ["expect"],
        message: "expect fail is used by, and only by, base_fail_check",
      });
    }
    if (request.reason === "base_fail_check" && (request.tests ?? []).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["tests"],
        message: "base_fail_check names the new acceptance tests",
      });
    }
  });
export type GateRunRequest = z.infer<typeof GateRunRequestSchema>;
export type GateRunRequestInput = z.input<typeof GateRunRequestSchema>;

/**
 * Overall verdict, deterministic from the results (`gateReportVerdict`): an infra or
 * environment problem on a blocking gate parks with `gate_infra` (§6.8) and wins over a product
 * failure, because the other results cannot be trusted.
 */
export const GateVerdictSchema = z.enum(["pass", "fail", "infra_error"]);
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

/** One Gate Runner invocation: the payload of the `gate.result` event. */
export const GateReportSchema = z
  .strictObject({
    run: RunIdSchema,
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    reason: GateRunReasonSchema,
    scope: z.enum(["affected", "full"]),
    base: GitShaSchema,
    head: GitShaSchema,
    /** Echo of the request's expectation; `verdict` is always the raw outcome. */
    expect: GateExpectSchema.default("pass"),
    results: z.array(GateResultSchema).min(1),
    /**
     * The `TraceabilityReport` the Gate Runner built for this run (§7.4, AD-18 rule 3), written
     * redacted to `.vtc/evidence/<T-n|F-n>/traceability.json`; set on every run that executed L2
     * tests for a task or feature. Engine core embeds it in the evidence bundle.
     */
    traceability: RelPathSchema.optional(),
    verdict: GateVerdictSchema,
    started_at: IsoDateTimeSchema,
    finished_at: IsoDateTimeSchema,
  })
  .superRefine((report, ctx) => {
    const expected = gateReportVerdict(report.results);
    if (report.verdict !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: `verdict must be ${expected} for these results`,
      });
    }
  });
export type GateReport = z.infer<typeof GateReportSchema>;
export type GateReportInput = z.input<typeof GateReportSchema>;

/** Pure: the overall verdict of a set of gate results. Non-blocking (warn) gates never fail it. */
export function gateReportVerdict(
  results: readonly Pick<GateResult, "status" | "blocking" | "failure_class">[],
): GateVerdict {
  const blocking = results.filter((r) => r.blocking);
  const infra = blocking.some(
    (r) =>
      (r.status === "fail" || r.status === "error") &&
      (r.failure_class === "infra" || r.failure_class === "environment"),
  );
  if (infra) return "infra_error";
  if (blocking.some((r) => r.status === "fail" || r.status === "error")) return "fail";
  return "pass";
}

/**
 * Whether a report met its request's expectation: `pass` expects verdict `pass`; `fail`
 * (`base_fail_check`) expects verdict `fail` with every failing blocking gate classified
 * `product`. `null` when the infrastructure failed and nothing can be concluded (§6.8).
 */
export const gateExpectationMet = (
  report: Pick<GateReport, "expect" | "verdict" | "results">,
): boolean | null => {
  if (report.verdict === "infra_error") return null;
  if (report.expect === "pass") return report.verdict === "pass";
  if (report.verdict !== "fail") return false;
  return report.results
    .filter((r) => r.blocking && (r.status === "fail" || r.status === "error"))
    .every((r) => r.failure_class === "product");
};

/** Kinds of L5 violation (§7.2 L5, §7.3). */
export const WriteScopeViolationKindSchema = z.enum([
  "out_of_scope_write",
  "protected_modified",
  "protected_deleted",
  "new_skip",
  "new_suppression",
  "snapshot_rewrite",
]);
export type WriteScopeViolationKind = z.infer<typeof WriteScopeViolationKindSchema>;

/**
 * Result of the L5 write-scope and test-integrity check. The engine core calls it on every
 * `submit` (§4.2 step 3, §6.3 step 4); the Gate Runner also runs it as layer L5.
 */
export const WriteScopeReportSchema = z
  .strictObject({
    ok: z.boolean(),
    violations: z
      .array(z.strictObject({ kind: WriteScopeViolationKindSchema, path: RelPathSchema }))
      .default([]),
  })
  .superRefine((report, ctx) => {
    if (report.ok !== (report.violations.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ok"],
        message: "ok must be true exactly when there are no violations",
      });
    }
  });
export type WriteScopeReport = z.infer<typeof WriteScopeReportSchema>;
