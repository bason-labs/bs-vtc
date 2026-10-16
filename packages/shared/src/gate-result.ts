/**
 * Gate Runner contracts (§6.3 steps 4–5 and 8, §7.2, AD-13). The Gate Runner (engine module
 * `gates/`, sub-project 2) produces them; triage, the loop controller, the merge queue, Final
 * Review and the dashboard's gate-report drill-down consume them. The `gate.result` event
 * carries one {@link GateReport}.
 */
import { z } from "zod";
import { ToolFindingSchema } from "./finding.js";
import { VisualRequestSchema, VisualSummarySchema } from "./visual.js";
import { GateLayerSchema, GatePhaseSchema, ReportFormatSchema } from "./gates-config.js";
import {
  EvidenceSchema,
  FeatureIdSchema,
  GitShaSchema,
  WriteScopeGlobSchema,
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
 *
 * **Several L2 gates.** When a run has more than one L2 gate, the `tests` of the **last** L2
 * result in `GateReport.results` are the run's **combined** L2 metrics (every L2 gate's tests in
 * one inventory, counts summed); the earlier L2 results carry their own gate's metrics. The
 * combined metrics are what engine core keeps as the run's L2 metrics and passes back as the
 * next run's `GateRunRequest.compare_to`, and what the monotonic comparison of the last L2 result
 * reads; per-gate metrics would report every test of the other gates as `test_missing`.
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

/**
 * The rule id of the finding a gate reports when its tool was tampered with (H-14): category
 * `security`, so the §7.6 risk rules treat it as a security problem, never as an ordinary lint
 * failure. New in 5.7.0.
 */
export const TOOL_TAMPER_RULE_ID = "vtc/tool-tampered";

/**
 * How a check gate's tool was verified (H-14; `CheckTool`): its source, the SHA-256 it was checked
 * against (a `pinned` tool's `binary_sha256`; for a `project` tool the hash of its files, sorted
 * path and content hash per line, taken before the install phase's scripts ran, or, for a gate
 * whose command names no tool in the checkout, the workspace's), and the tool files the install
 * phase changed, added or removed. A non-empty `tampered` fails the gate (`status: fail`,
 * `failure_class: product`) with one {@link TOOL_TAMPER_RULE_ID} finding. New in 5.7.0.
 *
 * Since 5.10.0 (spine §5 reading 251) a `project` gate's check does not depend on parsing its
 * command: `workspace_sha256` is the hash of every tool the workspace can run (each
 * `node_modules/.bin` entry and the package it starts, each package a check config loads, each
 * virtual environment's `bin/` and `pyvenv.cfg`), taken at the same time, and `tampered` lists
 * those lines too. `sha256` of the command's own tool is extra detail, never the only check.
 */
export const ToolIntegritySchema = z.strictObject({
  source: z.enum(["pinned", "project"]),
  sha256: Sha256HexSchema,
  tampered: z.array(RelPathSchema).max(50).default([]),
  /**
   * When a `project` tool's hash was taken (spine §5 reading 249): `after_scripts` when an install
   * gate with no scripts-free form ran its scripts before the hash (or the tool was first found
   * after one did), so what those scripts wrote into the tool is not detected and `sha256` does
   * not vouch for it. Absent: before any install-phase script ran, as reading 238 requires. New
   * in 5.8.0.
   */
  baseline: z.enum(["before_scripts", "after_scripts"]).optional(),
  /**
   * The hash of the workspace's tools (see above), sorted path and content hash per line, taken
   * when `sha256` was; a `project` gate on the run checkout always has it. New in 5.10.0.
   */
  workspace_sha256: Sha256HexSchema.optional(),
});
export type ToolIntegrity = z.infer<typeof ToolIntegritySchema>;

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
    /** L2 only. On the last L2 result of a report: the run's combined L2 metrics ({@link TestMetricsSchema}). */
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
    /** How the gate's tool was verified (H-14, {@link ToolIntegritySchema}). New in 5.7.0. */
    tool: ToolIntegritySchema.optional(),
  })
  .superRefine((result, ctx) => {
    if (
      result.tool !== undefined &&
      result.tool.tampered.length > 0 &&
      (result.status !== "fail" || result.failure_class !== "product")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["tool", "tampered"],
        message: "a tampered tool fails its gate with failure class product",
      });
    }
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
    // Informational findings (`sarif_level: none`, e.g. the scope-creep flag) are listed but are
    // not violations (spine §5 reading 125, since 4.6.0)
    if (result.findings.filter((f) => f.sarif_level !== "none").length > result.new_violations) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message:
          "findings other than sarif_level none are new violations: no more than new_violations",
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
 * the engine moves them to `~/.vtc/hidden/<repo-key>/<run>/<task>/` ({@link hiddenTestsDir}),
 * outside the repo. The Gate Runner copies them into the clean checkout only for a run with
 * `include_hidden` (§7.3: "copied in only at gate time") and never writes them to evidence.
 *
 * Keyed by run since 5.0.0 (D-ck, spine §5 reading 205; MAJOR: a persisted layout): task ids
 * repeat across runs, so a later run's task, or a Lookback replay trial, could otherwise be given
 * another run's hidden tests. The engine (writer) and the Gate Runner (reader) both build the
 * path with {@link hiddenTestsDir} only. Nothing released wrote the old `<repo-key>/<task>/`
 * layout, so there is no migration; a directory at the old depth is never read.
 */
export const HIDDEN_TESTS = {
  artifactType: "hidden_acceptance_test",
  /**
   * Staging directory, relative to the **main checkout** (the repo root the engine runs in), not
   * to the role's worktree; one sub-directory per task. QA author mode writes
   * `<repoRoot>/<stagingDir>/<task>/**` (the task pack lists it as a write scope), the engine
   * checks the artifacts there on submit, and `vtc hook` counts that main-checkout entry as part
   * of the dispatch's effective write scope (hook rule 4, spine §5 reading 65).
   */
  stagingDir: ".vtc/state/hidden-staging",
  /** Directory under the VTC home (`~/.vtc/`); `<repo-key>/<run>/<task>/` below it. */
  homeDir: "hidden",
} as const;

/** One run's task whose hidden tests a gate run copies in: `T-n` (the request's run) or `<run>:T-n`. */
export const HiddenTestsEntrySchema = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}:)?T-[1-9]\d*$/,
    "expected a task id (T-7) or a run-qualified one (<run>:T-7)",
  );

/**
 * Pure (D-ck): the run and task a `GateRunRequest.hidden_tasks` entry names. A bare task id is the
 * request's own run's; `<run>:<task>` (the `ReplayResult.per_task` key) is another run's, which a
 * Lookback replay trial uses for the recorded dispatch's run. New in 5.0.0.
 */
export const hiddenTestsRef = (
  requestRun: string,
  entry: string,
): { readonly run: string; readonly task: string } => {
  HiddenTestsEntrySchema.parse(entry);
  const at = entry.lastIndexOf(":");
  return at === -1
    ? { run: RunIdSchema.parse(requestRun), task: entry }
    : { run: entry.slice(0, at), task: entry.slice(at + 1) };
};

/**
 * Pure (D-ck): a task's hidden-test directory relative to the VTC home,
 * `hidden/<repo-key>/<run>/<task>`. The only way to build it: the engine moves QA's staged tests
 * there and the Gate Runner copies from there. New in 5.0.0.
 */
export const hiddenTestsDir = (repoKey: string, run: string, task: string): string => {
  if (!/^[a-f0-9]{16}$/.test(repoKey)) throw new TypeError(`not an engineRepoKey: ${repoKey}`);
  return `${HIDDEN_TESTS.homeDir}/${repoKey}/${RunIdSchema.parse(run)}/${TaskIdSchema.parse(task)}`;
};

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
    files_scope: z.array(WriteScopeGlobSchema).default([]),
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
    /**
     * With `include_hidden` on a feature run (Final Review, §6.7a step 2 "all hidden tests"): the
     * tasks whose hidden acceptance tests ({@link hiddenTestsDir}) the Gate Runner copies in.
     * Engine core passes the feature's tasks. A task run copies its own `task`'s and needs no
     * entry here. Each entry is a task of this request's `run` (`T-n`) or, since 5.0.0, of another
     * run (`<run>:T-n`, {@link hiddenTestsRef}): a Lookback replay trial names the recorded
     * dispatch's run (D-ck). The Gate Runner never guesses a directory. Absent = none.
     */
    hidden_tasks: z.array(HiddenTestsEntrySchema).optional(),
    /**
     * SHA-256 (`sha256Hex`) of the raw bytes of the `.vtc/gates.yml` the run started with (spine
     * §5 reading 20). The Gate Runner reads `gates.yml` at `base`; when this is set and the bytes
     * there hash differently, it runs nothing and reports `error` / `infra` with that reason, so a
     * run never verifies with a config other than the one it started with. Absent: the base
     * commit's `gates.yml` as it is.
     */
    gates_config_hash: Sha256HexSchema.optional(),
    /**
     * Run the deterministic visual step (AD-24) for these screens: UI tasks name the screens
     * whose `reqs` they cover; Final Review step 5 sends `screens: []` (all). Absent: no visual
     * step. New in 4.5.0.
     */
    visual: VisualRequestSchema.optional(),
  })
  .superRefine((request, ctx) => {
    if ((request.reason === "base_fail_check") !== (request.expect === "fail")) {
      ctx.addIssue({
        code: "custom",
        path: ["expect"],
        message: "expect fail is used by, and only by, base_fail_check",
      });
    }
    const hiddenTasks = request.hidden_tasks ?? [];
    if (hiddenTasks.length > 0 && !request.include_hidden) {
      ctx.addIssue({
        code: "custom",
        path: ["hidden_tasks"],
        message: "hidden_tasks name the hidden tests of an include_hidden run",
      });
    }
    // Resolve bare ids against the request's run, so `T-1` and `<run>:T-1` count as one.
    const refs = hiddenTasks.map((entry) =>
      entry.includes(":") ? entry : `${request.run}:${entry}`,
    );
    if (new Set(refs).size !== refs.length) {
      ctx.addIssue({
        code: "custom",
        path: ["hidden_tasks"],
        message: "hidden_tasks are unique",
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
 * The OS sandbox gate commands run in (D-al, spine §5 reading 69; spec §7.2 two-phase sandbox):
 * `sandbox-exec` with a VTC-generated profile on macOS, `bwrap` with its own network namespace on
 * Linux, or `none` only when the user opted in with `~/.vtc/config.yaml`
 * `gates.allow_unsandboxed` (an `unsandboxed_gate` incident is then recorded for the gate run).
 */
export const GateSandboxKindSchema = z.enum(["sandbox-exec", "bwrap", "none"]);
export type GateSandboxKind = z.infer<typeof GateSandboxKindSchema>;

/**
 * The gate sandbox rules (D-al). Every gate command (calibration included) runs wrapped:
 * - verify phase: no network; install phase: package registries only, or the full network where
 *   the host cannot filter by registry, with the same filesystem rules;
 * - writes only to the verification checkout and a private per-command temp directory;
 * - reads denied on the VTC home and on host config and credential locations (built with
 *   `hostCredentialDenyReadPaths`; nothing opens them);
 * - `HOME` is an empty per-run temp directory, `VTC_HOME` is unset, and no credential variable is
 *   passed (the gate environment is an allowlist).
 * With no sandbox tool and no opt-in, the Gate Runner runs nothing: each gate it would have run
 * reports `error` / `infra` with `noSandboxReason` in its evidence note (as a disallowed command
 * does), so the report's verdict is `infra_error` and the task parks with `gate_infra` (§6.8)
 * showing that reason. `vtc doctor` reports which sandbox is in use.
 */
export const GATE_SANDBOX = {
  noSandboxReason: "no OS sandbox for gates",
} as const;

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
    /**
     * The OS sandbox this run's commands ran in (D-al). Absent when the run executed no command
     * (and on reports written before contracts 4.3.0); `none` only under
     * `gates.allow_unsandboxed`, which engine core records as an `unsandboxed_gate` incident.
     */
    sandbox: GateSandboxKindSchema.optional(),
    /**
     * The visual step's outcome when the request asked for it (AD-24). It does not change
     * `verdict`, which stays a function of `results`: engine core treats `fail` and `unchecked`
     * as a failed gate run (findings in `visual.findings` go through triage), `error` as gate
     * infrastructure, and `skipped` as a visible note that Level 3 never counts as a pass
     * (spine §5 reading 105). New in 4.5.0.
     */
    visual: VisualSummarySchema.optional(),
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
