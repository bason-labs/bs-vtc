/**
 * Git-tracked projections of the event log (AD-7 rule 8, AD-18): plan files
 * (`.vtc/tasks/T-n.md`), the run request (`.vtc/runs/<run>/request.md`), task packs
 * (`.vtc/state/packs/<action>.md`), evidence bundles and the run summary. The engine writes them
 * and never reads them back as input. Everything git-tracked is redacted first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EvidenceBundleSchema,
  evidenceBundlePath,
  finalReviewStepsCovered,
  parsePersisted,
  redactJson,
  redactSecrets,
  renderTaskPack,
  runRequestPath,
  taskPackPath,
  TaskPackSchema,
  TraceabilityReportSchema,
  type EvidenceBundle,
  type Finding,
  type RoleRunSummary,
  type TaskPackInput,
  type TokenUsage,
  type TraceabilityReport,
} from "@vtc/shared";
import { writeRepoFile } from "../git/index.js";
import { taskPackJsonPath } from "./dispatch-scope.js";
import type { RunState } from "./state.js";
import { planFilePath } from "./views.js";
import { toYaml } from "./yaml.js";

/** What each §6.7a step is, for the PR note on what Final Review covered. */
const FINAL_REVIEW_STEPS: Readonly<Record<number, string>> = {
  1: "full gates on the integrated branch",
  2: "the full acceptance run with every hidden test",
  3: "a fresh-eyes review of the whole feature",
  4: "a security review of the whole feature",
  5: "a design and accessibility review",
  6: "architecture conformance",
  7: "release readiness",
};

/**
 * The §6.7a steps the feature's latest Final Review gate run covered (`final_review.steps_run`,
 * spine §5 reading 46e): the shared `finalReviewStepsCovered` over the engine's own request shape
 * (`finalReviewRequest`: full scope, every layer, hidden tests), the report and its traceability.
 * Empty when no Final Review gate run is logged.
 */
export const finalReviewStepsRun = (
  repoRoot: string,
  state: RunState,
  featureId: string,
): number[] => {
  const report = state.gateReports
    .map((r) => r.report)
    .filter((r) => r.reason === "final_review" && r.feature === featureId)
    .at(-1);
  if (report === undefined) return [];
  return finalReviewStepsCovered(
    { reason: report.reason, scope: report.scope, layers: undefined, include_hidden: true },
    report,
    report.traceability === undefined ? null : readTraceabilityFile(repoRoot, report.traceability),
  );
};

/** The note on what Final Review covered, stated wherever its verdict is shown (the PR body). */
export const finalReviewScopeNote = (steps: readonly number[]): string => {
  const ran = steps.map((n) => `${String(n)} (${FINAL_REVIEW_STEPS[n] ?? "?"})`);
  const missing = [1, 2, 3, 4, 5, 6, 7].filter((n) => !steps.includes(n));
  const head = `Final Review ran ${ran.length === 0 ? "no step" : `step${ran.length > 1 ? "s" : ""} ${ran.join(", ")}`} of §6.7a`;
  if (missing.length === 0) return `${head}.`;
  return `${head}; step${missing.length > 1 ? "s" : ""} ${missing.join(", ")} did not run in this VTC version, so review the PR with that in mind.`;
};

/** Agents write in the repo too: a planted symlink is refused, never followed (AD-18). */
const write = (repoRoot: string, path: string, content: string): void => {
  writeRepoFile(repoRoot, path, content);
};

/** `.vtc/runs/<run>/request.md` from `run.started.request`. */
export const writeRequestFile = (
  repoRoot: string,
  state: RunState,
  secrets: readonly string[],
): string => {
  const path = runRequestPath(state.id);
  write(repoRoot, path, `${redactSecrets(state.request, secrets).trimEnd()}\n`);
  return path;
};

/**
 * `.vtc/tasks/T-n.md`: frontmatter (`PlanFileFrontmatter` = the task record), the immutable
 * `<intent-contract>` block from `task.created`, and the append-only change and triage logs.
 */
export const writePlanFile = (
  repoRoot: string,
  state: RunState,
  taskId: string,
  secrets: readonly string[],
): string | null => {
  const task = state.tasks.get(taskId);
  if (task === undefined) return null;
  const intent = state.intents.get(taskId);
  const changes = state.events
    .filter((e) => e.task === taskId && e.type === "task.status_changed")
    .map((e) => {
      const d = e.data as { from: string; to: string; round: number; park_reason?: string };
      return `- ${e.ts} ${d.from} → ${d.to} (round ${String(d.round)})${d.park_reason === undefined ? "" : `, ${d.park_reason}`}`;
    });
  const triage = [...state.findings.values()]
    .filter((r) => r.finding.task === taskId)
    .map(
      (r) =>
        `- ${r.finding.fingerprint.slice(0, 12)} ${r.finding.severity} ${r.finding.route} ${r.finding.status}: ${r.finding.title}`,
    );
  const body = [
    "---",
    toYaml(redactJson(task, secrets)).trimEnd(),
    "---",
    "",
    `# ${task.id} ${task.title}`,
    "",
    "<intent-contract>",
    intent === undefined
      ? "(engine-created task: see its source finding)"
      : toYaml(redactJson(intent, secrets)).trimEnd(),
    "</intent-contract>",
    "",
    "## Change log",
    "",
    ...(changes.length > 0 ? changes : ["(none)"]),
    "",
    "## Triage log",
    "",
    ...(triage.length > 0 ? triage : ["(none)"]),
    "",
  ].join("\n");
  const path = planFilePath(taskId);
  write(repoRoot, path, body);
  return path;
};

/**
 * Renders and writes one task pack (gitignored, AD-14 rule 5), plus the same pack as `TaskPack`
 * JSON next to it (`taskPackJsonPath`): the structured write scope `vtc hook` reads (reading 67).
 */
export const writeTaskPack = (repoRoot: string, pack: TaskPackInput): string => {
  const path = taskPackPath(pack.action_id);
  write(
    repoRoot,
    taskPackJsonPath(pack.action_id),
    `${JSON.stringify(TaskPackSchema.parse(pack))}\n`,
  );
  write(repoRoot, path, renderTaskPack(pack));
  return path;
};

const ZERO_TOKENS: TokenUsage = { in: 0, out: 0, cache_r: 0, cache_w: 0 };

const addTokens = (a: TokenUsage, b: TokenUsage | null): TokenUsage =>
  b === null
    ? a
    : {
        in: a.in + b.in,
        out: a.out + b.out,
        cache_r: a.cache_r + b.cache_r,
        cache_w: a.cache_w + b.cache_w,
      };

/** Spend of a set of role runs; `usd` is `null` when any run was unpriced (§11). */
export const spendOf = (
  runs: readonly {
    readonly tokens: TokenUsage | null;
    readonly costUsd: number | null;
    readonly status: string;
  }[],
): { usd: number | null; tokens: TokenUsage } => {
  const done = runs.filter((r) => r.status === "submitted");
  const unpriced = done.some((r) => r.costUsd === null);
  return {
    usd: unpriced
      ? null
      : Math.round(done.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 10_000) / 10_000,
    tokens: done.reduce((t, r) => addTokens(t, r.tokens), ZERO_TOKENS),
  };
};

const countFindings = (findings: readonly Finding[]): EvidenceBundle["findings"] => ({
  open: findings.filter((f) => f.status === "open").length,
  resolved: findings.filter((f) => f.status === "resolved").length,
  deferred: findings.filter((f) => f.status === "deferred").length,
  waived: findings.filter((f) => f.status === "waived").length,
  discarded: findings.filter((f) => f.status === "discarded").length,
});

/**
 * The traceability report the Gate Runner wrote for `id`, or, when it wrote none, an honest one
 * built from the covered requirements with no tests (every REQ is then a gap).
 */
/** A traceability report the Gate Runner wrote, or `null` when it is missing or invalid. */
const readTraceabilityFile = (repoRoot: string, path: string): TraceabilityReport | null => {
  try {
    const parsed = parsePersisted(
      TraceabilityReportSchema,
      JSON.parse(readFileSync(join(repoRoot, path), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const readTraceability = (
  repoRoot: string,
  state: RunState,
  scope: { readonly task: string } | { readonly feature: string },
  covers: readonly string[],
  now: Date,
): TraceabilityReport => {
  const id = "task" in scope ? scope.task : scope.feature;
  const report = state.gateReports
    .filter((r) => ("task" in scope ? r.report.task === id : r.report.feature === id))
    .map((r) => r.report.traceability)
    .filter((p): p is string => p !== undefined)
    .at(-1);
  const read = report === undefined ? null : readTraceabilityFile(repoRoot, report);
  if (read !== null) return read;
  return TraceabilityReportSchema.parse({
    run: state.id,
    ...scope,
    rows: covers.map((req) => ({ req, tests: [], covered: false })),
    gaps: covers,
    built_at: now.toISOString(),
  });
};

/** The task evidence bundle (§6.7a, §14), written redacted to `.vtc/evidence/T-n/bundle.json`. */
export const writeTaskEvidenceBundle = (
  repoRoot: string,
  state: RunState,
  taskId: string,
  now: Date,
  secrets: readonly string[],
): string | null => {
  const task = state.tasks.get(taskId);
  if (task === undefined) return null;
  const runs = [...state.roleRuns.values()].filter((r) => r.task === taskId);
  const findings = [...state.findings.values()]
    .filter((r) => r.finding.task === taskId)
    .map((r) => r.finding);
  const bundle = EvidenceBundleSchema.parse({
    kind: "task",
    run: state.id,
    task: taskId,
    feature: task.feature,
    discipline: task.discipline,
    rounds: task.round,
    cap: task.cap,
    traceability: readTraceability(repoRoot, state, { task: taskId }, task.covers, now),
    findings: countFindings(findings),
    gate_reports: state.gateReports
      .filter((r) => r.report.task === taskId)
      .flatMap((r) =>
        r.report.results.flatMap((g) => (g.report === undefined ? [] : [g.report.path])),
      ),
    verdicts: runs.flatMap((r) =>
      r.verdicts.map((v) => ({
        role: r.role,
        subject: v.subject,
        verdict: v.verdict,
        prompt_sha: r.prompt_sha,
      })),
    ),
    spend: spendOf(runs),
    written_at: now.toISOString(),
  });
  const path = evidenceBundlePath(taskId);
  write(repoRoot, path, `${JSON.stringify(redactJson(bundle, secrets), null, 2)}\n`);
  return path;
};

/** The feature evidence bundle (§6.7a output), written redacted to `.vtc/evidence/F-n/bundle.json`. */
export const writeFeatureEvidenceBundle = (
  repoRoot: string,
  state: RunState,
  featureId: string,
  verdict: "pending" | "pass" | "fail" | "parked",
  now: Date,
  secrets: readonly string[],
): { path: string; bundle: EvidenceBundle } | null => {
  const feature = state.features.get(featureId);
  if (feature === undefined) return null;
  const tasks = feature.tasks.flatMap((id) => {
    const t = state.tasks.get(id);
    return t === undefined || t.status === "dropped" ? [] : [t];
  });
  if (tasks.length === 0) return null;
  const runsOf = (id: string) => [...state.roleRuns.values()].filter((r) => r.task === id);
  const disciplines = [...new Set(tasks.map((t) => t.discipline))];
  const findings = [...state.findings.values()]
    .filter((r) => r.finding.feature === featureId || tasks.some((t) => t.id === r.finding.task))
    .map((r) => r.finding);
  const bundle = EvidenceBundleSchema.parse({
    kind: "feature",
    run: state.id,
    feature: featureId,
    tasks: tasks.map((t) => ({
      task: t.id,
      discipline: t.discipline,
      rounds: t.round,
      spend: spendOf(runsOf(t.id)),
    })),
    by_discipline: disciplines.map((d) => ({
      discipline: d,
      spend: spendOf(tasks.filter((t) => t.discipline === d).flatMap((t) => runsOf(t.id))),
    })),
    traceability: readTraceability(
      repoRoot,
      state,
      { feature: featureId },
      [...new Set(tasks.flatMap((t) => t.covers))],
      now,
    ),
    findings: countFindings(findings),
    deferred: findings.filter((f) => f.status === "deferred").map((f) => f.fingerprint),
    final_review: {
      verdict,
      rounds: feature.round,
      steps_run: finalReviewStepsRun(repoRoot, state, featureId),
    },
    spend: spendOf(tasks.flatMap((t) => runsOf(t.id))),
    written_at: now.toISOString(),
  });
  const path = evidenceBundlePath(featureId);
  write(repoRoot, path, `${JSON.stringify(redactJson(bundle, secrets), null, 2)}\n`);
  return { path, bundle };
};

/** Markdown summary of a feature bundle for the PR description (§6.7 Level 2). */
export const bundleMarkdown = (bundle: EvidenceBundle): string => {
  if (bundle.kind !== "feature") return "";
  const usd = (v: number | null): string => (v === null ? "unpriced" : `$${v.toFixed(2)}`);
  return [
    `## VTC evidence: ${bundle.feature}`,
    "",
    `Final Review: ${bundle.final_review.verdict} (${String(bundle.final_review.rounds)} rounds)`,
    "",
    "| Task | Discipline | Rounds | Spend |",
    "| --- | --- | --- | --- |",
    ...bundle.tasks.map(
      (t) => `| ${t.task} | ${t.discipline} | ${String(t.rounds)} | ${usd(t.spend.usd)} |`,
    ),
    "",
    `Requirements covered: ${String(bundle.traceability.rows.filter((r) => r.covered).length)}/${String(bundle.traceability.rows.length)}` +
      (bundle.traceability.gaps.length > 0
        ? ` (gaps: ${bundle.traceability.gaps.join(", ")})`
        : ""),
    `Findings: ${String(bundle.findings.open)} open, ${String(bundle.findings.resolved)} resolved, ${String(bundle.findings.deferred)} deferred, ${String(bundle.findings.waived)} waived`,
    `Spend: ${usd(bundle.spend.usd)}`,
    "",
    `Full bundle: \`${evidenceBundlePath(bundle.feature)}\``,
    "",
  ].join("\n");
};

/** `.vtc/runs/<run>/summary.md` (RETRO, §6.1): what happened, with unpriced spend flagged (§11). */
export const writeRunSummary = (
  repoRoot: string,
  state: RunState,
  roleRuns: readonly RoleRunSummary[],
  secrets: readonly string[],
): string => {
  const tasks = [...state.tasks.values()];
  const unpriced = [...state.roleRuns.values()].filter(
    (r) => r.status === "submitted" && r.costUsd === null,
  );
  const clarified = state.events.filter((e) => e.type === "spec.clarified").length;
  const lines = [
    `# Run ${state.id}`,
    "",
    `Track: ${state.run.track}. Phase: ${state.run.phase}. Merge level: ${String(state.run.merge_level_effective)}.`,
    "",
    "## Tasks",
    "",
    ...tasks.map(
      (t) =>
        `- ${t.id} ${t.title}: ${t.status} (round ${String(t.round)}/${String(t.cap)}, $${t.spent_usd.toFixed(2)} of $${t.budget_usd.toFixed(2)})`,
    ),
    "",
    `Role runs: ${String(roleRuns.length)}.`,
    ...(unpriced.length > 0
      ? [`Unpriced role runs (model missing from the price table): ${String(unpriced.length)}.`]
      : []),
    ...(clarified > 0 ? [`Wording-only spec clarifications: ${String(clarified)}.`] : []),
    "",
  ];
  const path = `.vtc/runs/${state.id}/summary.md`;
  write(repoRoot, path, redactSecrets(lines.join("\n"), secrets));
  return path;
};
