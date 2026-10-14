/**
 * Final Review (spec §6.7a; spine §5 reading 91 superseded in wave 3): the whole feature on its
 * integrated branch, deterministic steps first.
 * - Steps 1, 2 and 6 are the full gate run (`finalReviewRequest`); step 5's deterministic part is
 *   its visual step on every screen (`GateRunRequest.visual` with `screens: []`, AD-24): `pass`,
 *   `fail`, `unchecked`, or `skipped` with the reason (no browser, D-ay). When that step rendered,
 *   its AI part follows: the Visual QA judge, three calls fed the visual report and renders, a
 *   2-of-3 vote per criterion (`FINAL_REVIEW_VISUAL_STEP`, spine §5 reading 149).
 * - Steps 3 and 4 are the AI reviewers, once per feature on the combined diff: the
 *   Spec-Verifier across the whole spec (plus the traceability gaps, the scope-creep flags and the
 *   deferred items) and Security verify. They run read-only in a worktree at the integrated head
 *   and cite evidence there (the gate runs' evidence, such as step 5's screenshots, in the checkout).
 * - Step 7, release readiness, is computed from the diff (migration order, config changes,
 *   rollback notes, docs, changelog, feature flags) and costs no tokens.
 * Each step is logged as `final_review.step_finished`; the evidence bundle carries the results
 * and the release readiness. After a fix round the full gates and step 7 run again, but an AI step
 * that passed the round before is carried over when the fix's diff cannot change what it reviews
 * (`fixAffectedSteps`): a failed step always runs again. Findings route as before: a risky one
 * parks the feature, the cap and a stuck loop park it, a finding one merged task owns reopens that
 * task (reading 150), anything else becomes an integration-fix task.
 */
import {
  FINAL_REVIEW_CAP,
  finalReviewStepsCovered,
  type ArtifactRef,
  ReleaseReadinessSchema,
  resolveRoleMode,
  VISUAL_SKIPPED_NO_BROWSER,
  type Evidence,
  type Finding,
  type FinalReviewStepResult,
  type GateReport,
  type GitChangedFile,
  type ReleaseReadiness,
} from "@vtc/shared";
import { removeRepoFile, runGit, writeRepoFile } from "../git/index.js";
import { effectiveVerdict } from "./gate-verdict.js";
import {
  baseBranch,
  createIntegrationFix,
  emitGateResult,
  finalReviewRequest,
  gateReportFindings,
  parkFeature,
  reopenOwningTasks,
  riskyFinding,
  runGatesRetryingFlaky,
  setFeatureStatus,
} from "./jobs.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { countsAsFailure, inFlight, renderedVisualReport, visualJudgeStep } from "./queries.js";
import { readReleaseReadiness, readTraceabilityFile, releaseReadinessPath } from "./projections.js";
import { loadResult } from "./results.js";
import { findingFromDraft, findingFromVerdict } from "./triage.js";
import { featureHasUi } from "./ui.js";
import { VISUAL_QA_CALLS } from "./router.js";

/** The AI steps of Final Review (§6.7a steps 3–4) and the role mode each runs. */
export const FINAL_REVIEW_AI_STEPS = [
  { step: 3, role: "spec_verifier", mode: undefined },
  { step: 4, role: "security", mode: "verify" },
] as const;

/**
 * Step 5's AI part (§6.7a step 5, §7.5 step 6): the Visual QA judge on every screen and state of
 * the feature together, three calls and a 2-of-3 vote per criterion, fed the round's visual
 * report. It runs every round whose visual step rendered (a fix can change any screen), never
 * carried over; without renders (skipped: no browser) step 5 stays the deterministic note.
 */
export const FINAL_REVIEW_VISUAL_STEP = { step: 5, role: "visual_qa" } as const;

/** A Final Review step the engine wants dispatched (a feature-level reviewer, no task). */
export interface FeatureStep {
  readonly key: string;
  readonly role: string;
  readonly mode?: string;
  readonly feature: string;
  /** The verdict subject (the feature); none for the Visual QA judge, which judges V1–V8. */
  readonly subject?: string;
  readonly note: string;
  readonly inputs?: readonly ArtifactRef[];
}

/** The AI steps whose role (and mode) the installed contracts have. */
const aiSteps = (k: Kernel): { step: number; role: string; mode?: string }[] =>
  FINAL_REVIEW_AI_STEPS.flatMap((s) => {
    const contract = k.deps.roles.get(s.role);
    if (contract === undefined) return [];
    if (s.mode !== undefined && !resolveRoleMode(contract, s.mode).ok) return [];
    return [{ step: s.step, role: s.role, ...(s.mode === undefined ? {} : { mode: s.mode }) }];
  });

// ------------------------------------------------------------- the round

/** The seq the feature last entered `final_review`. */
const enteredSeq = (h: RunHandle, featureId: string): number =>
  h.state.events.findLast(
    (e) =>
      e.type === "feature.status_changed" &&
      e.feature === featureId &&
      (e.data as { to?: string }).to === "final_review",
  )?.seq ?? 0;

/** The feature's Final Review gate runs of this round, last first. */
const roundReports = (h: RunHandle, featureId: string) => {
  const since = enteredSeq(h, featureId);
  return h.state.gateReports.filter(
    (r) => r.seq > since && r.report.reason === "final_review" && r.report.feature === featureId,
  );
};

/**
 * The visual report step 5's judge reads this round (`renderedVisualReport` of the round's passing
 * gate run), or `undefined`: no judge this round (no renders, or no Visual QA role installed).
 */
const roundVisualReport = (k: Kernel, h: RunHandle, featureId: string): string | undefined => {
  if (k.deps.roles.get(FINAL_REVIEW_VISUAL_STEP.role) === undefined) return undefined;
  const last = roundReports(h, featureId).at(-1);
  return last !== undefined && effectiveVerdict(last.report) === "pass"
    ? renderedVisualReport(last.report)
    : undefined;
};

/** True once this round's gates concluded (pass or not): they do not run again this round. */
export const finalReviewGatesDone = (h: RunHandle, featureId: string): boolean =>
  roundReports(h, featureId).some((r) => r.report.verdict !== "infra_error");

/** The seq of this round's passing gate run (the AI steps count after it), if it passed. */
const gatesPassedSeq = (h: RunHandle, featureId: string): number | undefined => {
  const last = roundReports(h, featureId).at(-1);
  return last !== undefined && effectiveVerdict(last.report) === "pass" ? last.seq : undefined;
};

const runsSince = (h: RunHandle, featureId: string, seq: number) =>
  [...h.state.roleRuns.values()].filter(
    (r) => r.feature === featureId && r.task === undefined && r.seq > seq,
  );

/** This round's Visual QA judge runs of the feature. */
const judgeRuns = (h: RunHandle, featureId: string, seq: number) =>
  runsSince(h, featureId, seq).filter((r) => r.role === FINAL_REVIEW_VISUAL_STEP.role);

/** Whether step 5's judge reported: three accepted calls this round (or no judge this round). */
const judgeDone = (k: Kernel, h: RunHandle, featureId: string, seq: number): boolean =>
  roundVisualReport(k, h, featureId) === undefined ||
  judgeRuns(h, featureId, seq).filter((r) => r.status === "submitted").length >= VISUAL_QA_CALLS;

/** The AI steps this round already settled at its gate run: carried over from the round before. */
const carriedSteps = (h: RunHandle, featureId: string, seq: number): Set<number> =>
  new Set(
    h.state.events
      .filter(
        (e) => e.seq > seq && e.feature === featureId && e.type === "final_review.step_finished",
      )
      .map((e) => (e.data as { step?: number }).step ?? 0)
      .filter((step) => FINAL_REVIEW_AI_STEPS.some((s) => s.step === step)),
  );

/** The source-code extensions a test file can have: data and config (yaml, json, toml, rego, env, sh) never count. */
const TEST_SOURCE_EXT =
  "(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rb|java|kt|kts|scala|rs|cs|php|swift|ex|exs)";

/**
 * A test file by its name alone (`*.test.*`, `*.spec.*`, `*_test.*`, `*_spec.*`, `test_*.py`), never
 * by a directory it sits in: `api/specs/` or `src/spec/` can hold production code and configuration.
 * The extension must be source code (`openapi.spec.yaml`, `appsettings.test.json` and
 * `docker-compose.test.yml` are configuration), a hyphen does not make a test (`policy-spec.ts`),
 * and a `test_*.py` settings or config module (`test_settings.py`) is configuration.
 */
const TEST_NAME = new RegExp(
  `(^|/)[^/]+[._](test|spec)\\.${TEST_SOURCE_EXT}$|(^|/)test_(?![^/]*(settings|conf))[^/]+\\.py$`,
  "i",
);

/** Directories whose files configure CI, deployment or infrastructure, whatever their names. */
const NON_TEST_DIR =
  /(^|\/)(\.github|\.gitlab|\.circleci|\.buildkite|ci|deploy|deployments?|infra|infrastructure)\//i;

/** A test by name and extension, outside the CI, deploy and infrastructure directories. If unsure, it is code. */
const isTestFile = (path: string): boolean => TEST_NAME.test(path) && !NON_TEST_DIR.test(path);

/**
 * The `.vtc/` files no AI step judges: the engine's own records (the event log, evidence and
 * release readiness, the plan-file projections, the merge-level ledger, Lookback, the gitignored
 * state). Everything else under `.vtc/` (the frozen spec, architecture, design, research) is what
 * step 3 verifies against.
 */
const ENGINE_RECORD =
  /^\.vtc\/(?:state|runs|evidence|tasks|lookback)\/|^\.vtc\/merge-level\.jsonl$/;

/**
 * Pure (§6.7a "re-runs only the steps affected by the fix"): the AI steps a fix's diff (the
 * previous round's gated head … this round's) can change the outcome of. The engine's own records,
 * docs and the changelog affect none (step 7 and the gates run every round). An added test only
 * adds coverage, which the gates' traceability checks again each round (and a gap there runs step
 * 3 again). A changed or deleted test can weaken the coverage step 3 judged, and so can a change
 * to the spec, architecture or design under `.vtc/`. Anything else (code, configuration,
 * dependencies, migrations) can change both the coverage and scope step 3 judged and the combined
 * diff step 4 reviewed, and so does a fixture or helper next to the tests: only a file
 * {@link isTestFile} names as a test counts as one. If unsure, run it.
 */
export const fixAffectedSteps = (changes: readonly GitChangedFile[]): number[] => {
  const affected = new Set<number>();
  for (const change of changes) {
    const paths = [change.path, ...(change.oldPath === undefined ? [] : [change.oldPath])];
    if (paths.every((p) => ENGINE_RECORD.test(p) || DOCS.test(p) || CHANGELOG.test(p))) continue;
    if (paths.every((p) => p.startsWith(".vtc/") && !ENGINE_RECORD.test(p))) {
      affected.add(3);
      continue;
    }
    if (paths.every(isTestFile)) {
      if (change.status !== "added") affected.add(3);
      continue;
    }
    affected.add(3);
    affected.add(4);
  }
  return [...affected].sort((a, b) => a - b);
};

/** The head the round before last reviewed: its passing Final Review gate run's, if any. */
const previousRoundHead = (h: RunHandle, featureId: string): string | undefined => {
  const since = enteredSeq(h, featureId);
  return h.state.gateReports
    .filter(
      (r) =>
        r.seq < since &&
        r.report.reason === "final_review" &&
        r.report.feature === featureId &&
        effectiveVerdict(r.report) === "pass",
    )
    .at(-1)?.report.head;
};

/** Each AI step's last result before this round, by step. */
const lastStepResults = (h: RunHandle, featureId: string): Map<number, FinalReviewStepResult> => {
  const since = enteredSeq(h, featureId);
  const out = new Map<number, FinalReviewStepResult>();
  for (const e of h.state.events) {
    if (e.seq >= since || e.feature !== featureId || e.type !== "final_review.step_finished")
      continue;
    const result = e.data as unknown as FinalReviewStepResult;
    out.set(result.step, result);
  }
  return out;
};

/** The AI reviewer steps Final Review wants now (feature-level, read-only, at the integrated head). */
export const finalReviewSteps = (k: Kernel, h: RunHandle): FeatureStep[] => {
  const steps: FeatureStep[] = [];
  for (const feature of h.state.features.values()) {
    if (feature.status !== "final_review") continue;
    const seq = gatesPassedSeq(h, feature.id);
    if (seq === undefined) continue;
    const runs = runsSince(h, feature.id, seq);
    const carried = carriedSteps(h, feature.id, seq);
    for (const s of aiSteps(k)) {
      if (carried.has(s.step)) continue;
      const mine = runs.filter((r) => r.role === s.role && r.mode === s.mode);
      if (mine.some((r) => r.status === "submitted" || r.status === "in_flight")) continue;
      if (inFlight(h.state).some((r) => r.role === s.role && r.feature === feature.id)) continue;
      if (mine.filter(countsAsFailure).length >= 3) continue;
      const rejected = mine.findLast((r) => r.status === "rejected")?.rejection;
      steps.push({
        key: `final:${feature.id}:${s.role}`,
        role: s.role,
        ...(s.mode === undefined ? {} : { mode: s.mode }),
        feature: feature.id,
        subject: feature.id,
        note: [
          s.step === 3
            ? `Final Review step 3 (§6.7a): verify feature ${feature.id} across the whole spec on its integrated branch: every requirement covered by a passing test, scope creep flagged, deferred items listed. Give one verdict on subject ${feature.id}.`
            : `Final Review step 4 (§6.7a): review feature ${feature.id}'s combined diff for cross-task data flows, authorization gaps between layers, and secrets or configuration across services. Give one verdict on subject ${feature.id}.`,
          ...(rejected === undefined
            ? []
            : [
                `Your previous result was rejected (${rejected.reason}): ${rejected.issues.join("; ")}`,
              ]),
        ].join("\n"),
      });
    }
    // step 5's judge: three independent calls, counted like a UI round's (§7.5 step 6)
    const report = roundVisualReport(k, h, feature.id);
    if (report === undefined) continue;
    const judges = judgeRuns(h, feature.id, seq);
    if (judges.filter(countsAsFailure).length >= 3) continue;
    const taken = judges.filter((r) => r.status === "submitted" || r.status === "in_flight").length;
    const judge = visualJudgeStep(report, `feature ${feature.id}'s user journeys`);
    const rejected = judges.findLast((r) => r.status === "rejected")?.rejection;
    for (let call = taken + 1; call <= VISUAL_QA_CALLS; call += 1) {
      steps.push({
        key: `final:${feature.id}:visual_qa:${String(call)}`,
        role: FINAL_REVIEW_VISUAL_STEP.role,
        feature: feature.id,
        inputs: judge.inputs,
        note: [
          `Final Review step 5 (§6.7a): Visual QA on feature ${feature.id}'s full user journeys: every screen and state together, design drift and accessibility across flows. One verdict per criterion V1–V8 (no feature subject).`,
          judge.note,
          ...(rejected === undefined
            ? []
            : [
                `Your previous result was rejected (${rejected.reason}): ${rejected.issues.join("; ")}`,
              ]),
        ].join("\n"),
      });
    }
  }
  return steps;
};

// ----------------------------------------------------------- step results

const stepFinished = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  result: FinalReviewStepResult,
): void => {
  k.emit(h, {
    type: "final_review.step_finished",
    actor: "engine",
    feature: featureId,
    data: result,
  });
};

/** Step 5's deterministic result from the gate run's visual step (AD-24 rule 5, reading 105). */
export const visualStep = (
  report: Pick<GateReport, "visual">,
  hasUi: boolean,
): FinalReviewStepResult => {
  const visual = report.visual;
  const evidence: Evidence[] =
    visual?.report === undefined || visual.report === null
      ? []
      : [{ type: "file", ref: visual.report }];
  if (visual === undefined)
    return hasUi
      ? {
          step: 5,
          status: "unchecked",
          reason: "the visual step did not run on the feature's screens",
          evidence,
        }
      : { step: 5, status: "not_run", reason: "the feature has no UI", evidence };
  switch (visual.status) {
    case "pass":
    case "fail":
      return { step: 5, status: visual.status, evidence };
    case "skipped":
      return {
        step: 5,
        status: "skipped",
        reason: visual.skipped_reason ?? VISUAL_SKIPPED_NO_BROWSER,
        evidence,
      };
    case "unchecked":
      return {
        step: 5,
        status: "unchecked",
        reason: `${String(visual.counts.unreached)} render(s) unreached, ${String(visual.counts.axe_incomplete)} axe item(s) to review`,
        evidence,
      };
    case "error":
      return {
        step: 5,
        status: "unchecked",
        reason: "the visual step failed as infrastructure",
        evidence,
      };
  }
};

/** Steps 1, 2, 5 and 6 from the round's passing gate run (§6.7a, reading 46e). */
const recordGateSteps = (k: Kernel, h: RunHandle, featureId: string, report: GateReport): void => {
  const traceability =
    report.traceability === undefined
      ? null
      : readTraceabilityFile(k.deps.repoRoot, report.traceability);
  const covered = finalReviewStepsCovered(
    { reason: report.reason, scope: report.scope, layers: undefined, include_hidden: true },
    report,
    traceability,
  );
  const evidence: Evidence[] = [{ type: "commit", ref: report.head }];
  const notRun: Readonly<Record<1 | 2 | 6, string>> = {
    1: "a gate errored, so the full gate run is not complete",
    2: "no hidden acceptance test ran with the full suite",
    6: "no L6 architecture fitness gate is configured (gates.yml)",
  };
  for (const step of [1, 2, 5, 6] as const) {
    if (step === 5) {
      stepFinished(k, h, featureId, visualStep(report, featureHasUi(h.state, featureId)));
      continue;
    }
    stepFinished(
      k,
      h,
      featureId,
      covered.includes(step)
        ? { step, status: "pass", evidence }
        : { step, status: "not_run", reason: notRun[step], evidence },
    );
  }
};

/** The requirements this gate run's traceability report has no passing test for. */
const traceabilityGaps = (k: Kernel, report: GateReport): string[] => {
  const path = report.traceability;
  return path === undefined ? [] : (readTraceabilityFile(k.deps.repoRoot, path)?.gaps ?? []);
};

/**
 * Carries over the AI steps of `steps` that passed the round before (§6.7a: the fix did not touch
 * what they review), each as this round's `final_review.step_finished` with the earlier evidence.
 */
const carryOver = (k: Kernel, h: RunHandle, featureId: string, steps: readonly number[]): void => {
  const current = h.state.features.get(featureId);
  if (current === undefined) return;
  const last = lastStepResults(h, featureId);
  for (const s of aiSteps(k)) {
    const before = last.get(s.step);
    if (!steps.includes(s.step) || before?.status !== "pass") continue;
    stepFinished(k, h, featureId, {
      step: s.step,
      status: "pass",
      reason:
        `carried over from round ${String(current.round)}: the fix changed nothing this step reviews`.slice(
          0,
          500,
        ),
      evidence: before.evidence,
    });
  }
};

// --------------------------------------------------------- release readiness

const MIGRATION = /(^|\/)(migrations?|migrate)\/[^/]+$/i;
const CONFIG =
  /(^|\/)(\.env\.(example|sample|template)|config\/.+|[^/]+\.config\.[cm]?[jt]s|docker-compose[^/]*\.ya?ml|Dockerfile|\.github\/workflows\/.+|helm\/.+|k8s\/.+|terraform\/.+)$/i;
const CHANGELOG = /(^|\/)CHANGELOG[^/]*$/i;
const DOCS = /(^|\/)(README[^/]*|docs?\/.+\.mdx?)$/i;
const FLAGS = /(^|\/|[-_.])(feature[-_]?flags?|flags?)([-_./]|$)/i;

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const listed = (paths: readonly string[]): string =>
  `${paths.slice(0, 8).join(", ")}${paths.length > 8 ? ` and ${String(paths.length - 8)} more` : ""}`;

/**
 * Pure (§6.7a step 7): release readiness from the feature's diff (`changes`, base…integrated) and
 * the files at the base. Only migration order can fail on its own evidence: a new migration that
 * sorts before one the base already has would run out of order. A changelog the repo keeps but the
 * feature did not update fails too. Everything else passes with a note or does not apply.
 */
export const releaseReadiness = (
  changes: readonly GitChangedFile[],
  baseFiles: readonly string[],
): ReleaseReadiness => {
  const changed = changes.filter((c) => !c.path.startsWith(".vtc/")).map((c) => c.path);
  const added = changes.filter((c) => c.status === "added").map((c) => c.path);
  const migrations = changed.filter((p) => MIGRATION.test(p));
  const outOfOrder = added
    .filter((p) => MIGRATION.test(p))
    .flatMap((p) => {
      const later = baseFiles.filter(
        (b) => MIGRATION.test(b) && dirOf(b) === dirOf(p) && nameOf(b) > nameOf(p),
      );
      return later.length === 0 ? [] : [`${p} sorts before ${nameOf(later[0] ?? "")}`];
    });
  const config = changed.filter((p) => CONFIG.test(p));
  const docs = changed.filter((p) => DOCS.test(p));
  const changelogKept = baseFiles.some((b) => CHANGELOG.test(b));
  const changelog = changed.filter((p) => CHANGELOG.test(p));
  const flags = changed.filter((p) => FLAGS.test(p));
  const files = (paths: readonly string[]): Evidence[] =>
    paths.slice(0, 10).map((ref) => ({ type: "file", ref }));
  const items: ReleaseReadiness["items"] = [
    migrations.length === 0
      ? {
          id: "migration_order",
          status: "not_applicable",
          note: "no migration changed",
          evidence: [],
        }
      : outOfOrder.length > 0
        ? {
            id: "migration_order",
            status: "fail",
            note: `migrations would run out of order: ${outOfOrder.slice(0, 5).join("; ")}`.slice(
              0,
              1000,
            ),
            evidence: files(migrations),
          }
        : {
            id: "migration_order",
            status: "pass",
            note: `new migrations sort after the base's: ${listed(migrations)}; check each can be reversed`.slice(
              0,
              1000,
            ),
            evidence: files(migrations),
          },
    config.length === 0
      ? {
          id: "config_changes",
          status: "not_applicable",
          note: "no configuration or environment file changed",
          evidence: [],
        }
      : {
          id: "config_changes",
          status: "pass",
          note: `configuration changed, apply it with the release: ${listed(config)}`.slice(
            0,
            1000,
          ),
          evidence: files(config),
        },
    {
      id: "rollback_notes",
      status: "pass",
      note: [
        "revert the feature's merge commit",
        ...(migrations.length === 0 ? [] : [`roll back the migrations ${listed(migrations)}`]),
        ...(config.length === 0 ? [] : [`restore the configuration in ${listed(config)}`]),
      ]
        .join("; ")
        .slice(0, 1000),
      evidence: [],
    },
    docs.length === 0
      ? {
          id: "docs",
          status: "not_applicable",
          note: "no documentation changed; check none was needed",
          evidence: [],
        }
      : {
          id: "docs",
          status: "pass",
          note: `updated: ${listed(docs)}`.slice(0, 1000),
          evidence: files(docs),
        },
    changelog.length > 0
      ? {
          id: "changelog",
          status: "pass",
          note: `updated: ${listed(changelog)}`.slice(0, 1000),
          evidence: files(changelog),
        }
      : changelogKept
        ? {
            id: "changelog",
            status: "fail",
            note: "the repo keeps a changelog and this feature adds no entry",
            evidence: files(baseFiles.filter((b) => CHANGELOG.test(b))),
          }
        : {
            id: "changelog",
            status: "not_applicable",
            note: "the repo keeps no changelog",
            evidence: [],
          },
    flags.length === 0
      ? {
          id: "feature_flags",
          status: "not_applicable",
          note: "no feature flag changed",
          evidence: [],
        }
      : {
          id: "feature_flags",
          status: "pass",
          note: `feature flags changed: ${listed(flags)}`.slice(0, 1000),
          evidence: files(flags),
        },
  ];
  return ReleaseReadinessSchema.parse({ items, ok: items.every((i) => i.status !== "fail") });
};

const readinessFindings = (
  featureId: string,
  readiness: ReleaseReadiness,
  round: number,
): Finding[] =>
  readiness.items
    .filter((i) => i.status === "fail")
    .map((item) => {
      const path =
        item.evidence.find((e) => e.type === "file")?.ref ??
        (item.id === "changelog" ? "CHANGELOG.md" : releaseReadinessPath(featureId));
      return findingFromDraft(
        {
          rule_id: `release.${item.id}`,
          category: "docs",
          kind: "implementation_deviation",
          title: `release readiness: ${item.id.replace(/_/g, " ")}`,
          message: item.note,
          confidence: 1,
          location: { path },
          evidence: { type: "file", ref: path },
          req_ids: [],
        },
        "final_review",
        { feature: featureId, round },
      );
    });

// ------------------------------------------------------------- conclusion

/**
 * A failing Final Review round (§6.7a routing and caps): a risky finding parks the feature for
 * the human; the cap parks it; a finding the last fix round left in place parks it as stuck;
 * otherwise a finding a merged task owns reopens that task, and the rest become an integration-fix
 * task for the owning discipline.
 */
export const failFinalReview = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  findings: readonly Finding[],
  evidence: readonly Evidence[],
): void => {
  const current = h.state.features.get(featureId);
  if (current?.status !== "final_review") return;
  if (current.round + 1 > FINAL_REVIEW_CAP) {
    parkFeature(
      k,
      h,
      featureId,
      "cap",
      `Final Review reached its ${String(FINAL_REVIEW_CAP)}-round cap`,
      evidence,
    );
    return;
  }
  const before = new Set(
    [...h.state.findings.values()]
      .map((r) => r.finding)
      .filter((f) => f.feature === featureId && f.round_first_seen === current.round)
      .map((f) => f.fingerprint),
  );
  const repeated = findings.filter((f) => before.has(f.fingerprint));
  const risky = riskyFinding(findings);
  if (risky !== undefined) {
    parkFeature(
      k,
      h,
      featureId,
      "risk_rule",
      `Final Review found ${risky.finding.title} (${risky.finding.category}, ${risky.finding.severity}) at ${risky.finding.location.path}: a human decides before any fix round`,
      evidence,
      risky.rule,
    );
    return;
  }
  // a spec or design gap is a question for the human or the BA (§6.3 step 8), never an engineer
  // fix round: the feature parks with it
  const gaps = findings.filter((f) => f.route === "spec_gap" || f.route === "design_gap");
  if (gaps.length > 0) {
    parkFeature(
      k,
      h,
      featureId,
      "spec_conflict",
      `Final Review found ${String(gaps.length)} spec or design gap(s): ${gaps
        .slice(0, 3)
        .map((f) => `${f.route}: ${f.title}`)
        .join("; ")}`.slice(0, 2000),
      [...gaps.map((f) => f.evidence), ...evidence].slice(0, 5),
    );
    return;
  }
  if (current.round > 0 && repeated.length > 0) {
    parkFeature(
      k,
      h,
      featureId,
      "stuck",
      `Final Review round ${String(current.round + 1)} found ${String(repeated.length)} finding(s) the last fix round did not resolve: ${repeated
        .slice(0, 3)
        .map((f) => f.title)
        .join("; ")}`,
      evidence,
    );
    return;
  }
  setFeatureStatus(k, h, featureId, "fixing", { round: current.round + 1 });
  // a finding a merged task owns reopens it; the rest becomes one integration-fix task
  const rest = reopenOwningTasks(k, h, featureId, findings);
  if (rest.length > 0) createIntegrationFix(k, h, featureId, rest);
  if (h.state.run.phase !== "build")
    k.emit(h, {
      type: "run.phase_changed",
      actor: "engine",
      data: { from: h.state.run.phase, to: "build" },
    });
};

/**
 * Step 5's judge (§7.5 step 6): the 2-of-3 vote per criterion over this round's three accepted
 * calls; a criterion that is not `pass` (`fail`, `unknown`, `unchecked`) in two calls is a
 * finding, and every finding a call reported counts (once per fingerprint). `null` when no judge
 * ran this round; `unchecked` when a call's result is missing.
 */
const judgeVote = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  seq: number,
  round: number,
): { readonly result: FinalReviewStepResult; readonly findings: Finding[] } | null => {
  const report = roundVisualReport(k, h, featureId);
  if (report === undefined) return null;
  const runs = judgeRuns(h, featureId, seq)
    .filter((r) => r.status === "submitted")
    .slice(-VISUAL_QA_CALLS);
  const results = runs.map((r) => loadResult(k.deps.repoRoot, r.action_id));
  if (runs.length < VISUAL_QA_CALLS || results.some((r) => r === undefined))
    return {
      result: {
        step: 5,
        status: "unchecked",
        reason: "a Visual QA judge's result is missing",
        evidence: [{ type: "file", ref: report }],
      },
      findings: [],
    };
  const role = FINAL_REVIEW_VISUAL_STEP.role;
  const fallbackPath = `.vtc/evidence/${featureId}/bundle.json`;
  const byFingerprint = new Map<string, Finding>();
  for (const result of results)
    for (const d of result?.findings ?? []) {
      const f = findingFromDraft(d, role, { feature: featureId, round });
      if (f.route !== "defer" && !byFingerprint.has(f.fingerprint))
        byFingerprint.set(f.fingerprint, f);
    }
  const verdicts = results.flatMap((r) => r?.verdicts ?? []);
  const failingSubjects: string[] = [];
  for (const subject of [...new Set(verdicts.map((v) => v.subject))]) {
    const failing = verdicts.filter((v) => v.subject === subject && v.verdict !== "pass");
    const first = failing[0];
    if (failing.length < 2 || first === undefined) continue;
    failingSubjects.push(subject);
    const f = findingFromVerdict(first, role, { feature: featureId, round, fallbackPath });
    if (f.route !== "defer" && !byFingerprint.has(f.fingerprint))
      byFingerprint.set(f.fingerprint, f);
  }
  const findings = [...byFingerprint.values()];
  const reportEvidence: Evidence = { type: "file", ref: report };
  const cited: Evidence[] = [
    reportEvidence,
    ...verdicts.filter((v) => v.verdict !== "pass").flatMap((v) => v.evidence),
  ].slice(0, 10);
  const ok = findings.length === 0;
  return {
    result: {
      step: 5,
      status: ok ? "pass" : "fail",
      ...(ok
        ? {}
        : {
            reason: [
              ...(failingSubjects.length > 0
                ? [`2 of 3 judges did not pass ${failingSubjects.slice(0, 8).join(", ")}`]
                : []),
              `${String(findings.length)} finding(s)`,
            ]
              .join("; ")
              .slice(0, 500),
          }),
      evidence: cited,
    },
    findings,
  };
};

/** Steps 3, 4 and 7, then the feature's verdict, once every AI step of the round reported. */
const conclude = (k: Kernel, h: RunHandle, featureId: string, seq: number): void => {
  const feature = h.state.features.get(featureId);
  if (feature?.status !== "final_review") return;
  const round = feature.round + 1;
  const runs = runsSince(h, featureId, seq).filter((r) => r.status === "submitted");
  const blocking: Finding[] = [];
  const evidence: Evidence[] = [];
  const unchecked: number[] = [];
  const carried = carriedSteps(h, featureId, seq);
  for (const s of aiSteps(k)) {
    if (carried.has(s.step)) continue;
    const run = runs.filter((r) => r.role === s.role && r.mode === s.mode).at(-1);
    const result = run === undefined ? undefined : loadResult(k.deps.repoRoot, run.action_id);
    if (run === undefined || result === undefined) {
      stepFinished(k, h, featureId, {
        step: s.step,
        status: "unchecked",
        reason: "the reviewer's result is missing",
        evidence: [],
      });
      unchecked.push(s.step);
      continue;
    }
    const cited = result.verdicts.flatMap((v) => v.evidence).slice(0, 10);
    const found = result.findings.map((d) =>
      findingFromDraft(d, s.role, { feature: featureId, round }),
    );
    const failing = result.verdicts.filter((v) => v.verdict !== "pass");
    const fresh = [
      ...found,
      ...(found.length > 0
        ? []
        : failing.map((v) =>
            findingFromVerdict(v, s.role, {
              feature: featureId,
              round,
              fallbackPath: `.vtc/evidence/${featureId}/bundle.json`,
            }),
          )),
    ].filter((f) => f.route !== "defer");
    // step 3 also checks the gate run's traceability: a REQ with no passing test fails it; with
    // no traceability report the step rests on the reviewer alone, and says so
    let gaps: string[] = [];
    let noTraceability = false;
    if (s.step === 3) {
      const path = h.state.gateReports
        .filter(
          (r) =>
            r.seq <= seq && r.report.reason === "final_review" && r.report.feature === featureId,
        )
        .at(-1)?.report.traceability;
      const report = path === undefined ? null : readTraceabilityFile(k.deps.repoRoot, path);
      if (report === null) noTraceability = true;
      else gaps = report.gaps;
    }
    const ok = failing.length === 0 && fresh.length === 0 && gaps.length === 0;
    stepFinished(k, h, featureId, {
      step: s.step,
      status: ok ? "pass" : "fail",
      ...(ok
        ? noTraceability
          ? { reason: "no traceability report: requirement coverage rests on the reviewer" }
          : {}
        : {
            reason: [
              ...(failing.length > 0 ? [`${String(failing.length)} verdict(s) not pass`] : []),
              ...(fresh.length > 0 ? [`${String(fresh.length)} finding(s)`] : []),
              ...(gaps.length > 0 ? [`no passing test for ${gaps.slice(0, 5).join(", ")}`] : []),
            ]
              .join("; ")
              .slice(0, 500),
          }),
      evidence: cited,
    });
    blocking.push(...fresh);
    evidence.push(...cited);
  }
  const judged = judgeVote(k, h, featureId, seq, round);
  if (judged !== null) {
    stepFinished(k, h, featureId, judged.result);
    if (judged.result.status === "unchecked") unchecked.push(5);
    blocking.push(...judged.findings);
    evidence.push(...judged.result.evidence);
  }
  const readiness = readReleaseReadiness(k.deps.repoRoot, featureId);
  const readinessFailed = readiness === null ? [] : readinessFindings(featureId, readiness, round);
  stepFinished(
    k,
    h,
    featureId,
    readiness === null
      ? {
          step: 7,
          status: "unchecked",
          reason: "release readiness could not be computed",
          evidence: [],
        }
      : {
          step: 7,
          status: readiness.ok ? "pass" : "fail",
          ...(readiness.ok
            ? {}
            : {
                reason: readiness.items
                  .filter((i) => i.status === "fail")
                  .map((i) => `${i.id}: ${i.note ?? "fails"}`)
                  .join("; ")
                  .slice(0, 500),
              }),
          evidence: [{ type: "file", ref: releaseReadinessPath(featureId) }],
        },
  );
  const all = [...blocking, ...readinessFailed];
  if (all.length > 0) {
    failFinalReview(k, h, featureId, all, evidence.slice(0, 5));
    return;
  }
  if (unchecked.length > 0) {
    // an AI step with no verdict is never a pass (AD-8 rule 2; AD-23 rule 3)
    parkFeature(
      k,
      h,
      featureId,
      "blocked",
      `Final Review step(s) ${unchecked.join(", ")} could not be checked: the reviewer's result is missing or does not parse. Answer to run Final Review again`,
      [{ type: "file", ref: `.vtc/evidence/${featureId}/bundle.json` }],
    );
    return;
  }
  setFeatureStatus(k, h, featureId, "ready_to_ship");
};

/**
 * After a Final Review reviewer was accepted (callers hold the run's lock): once every AI step
 * of the round reported, the round concludes.
 */
export const featureReviewDone = (k: Kernel, h: RunHandle, featureId: string): void => {
  const seq = gatesPassedSeq(h, featureId);
  if (seq === undefined) return;
  const runs = runsSince(h, featureId, seq);
  const carried = carriedSteps(h, featureId, seq);
  const done =
    aiSteps(k).every(
      (s) =>
        carried.has(s.step) ||
        runs.some((r) => r.role === s.role && r.mode === s.mode && r.status === "submitted"),
    ) && judgeDone(k, h, featureId, seq);
  if (done) conclude(k, h, featureId, seq);
};

/** A Final Review reviewer that failed or was rejected three times this round parks the feature. */
export const checkFinalReviewStuck = (k: Kernel, h: RunHandle): void => {
  for (const feature of [...h.state.features.values()]) {
    if (feature.status !== "final_review") continue;
    const seq = gatesPassedSeq(h, feature.id);
    if (seq === undefined) continue;
    const runs = runsSince(h, feature.id, seq);
    const carried = carriedSteps(h, feature.id, seq);
    const stuck = aiSteps(k).find(
      (s) =>
        !carried.has(s.step) &&
        !runs.some((r) => r.role === s.role && r.mode === s.mode && r.status === "submitted") &&
        runs.filter((r) => r.role === s.role && r.mode === s.mode && countsAsFailure(r)).length >=
          3,
    );
    const judgeStuck =
      roundVisualReport(k, h, feature.id) !== undefined &&
      !judgeDone(k, h, feature.id, seq) &&
      judgeRuns(h, feature.id, seq).filter(countsAsFailure).length >= 3;
    const which =
      stuck !== undefined
        ? stuck
        : judgeStuck
          ? { step: FINAL_REVIEW_VISUAL_STEP.step, role: FINAL_REVIEW_VISUAL_STEP.role }
          : undefined;
    if (which !== undefined)
      parkFeature(
        k,
        h,
        feature.id,
        "stuck",
        `Final Review step ${String(which.step)} (${which.role}) failed or was rejected 3 times`,
        [{ type: "file", ref: `.vtc/evidence/${feature.id}/bundle.json` }],
      );
  }
};

// ------------------------------------------------------------- the gates

/**
 * Final Review's gate run (§6.7a steps 1, 2, 5's visual step and 6) on the integrated branch, once
 * per round; then release readiness (step 7) from the diff. A passing run hands over to the AI
 * steps (or concludes at once when no reviewer role is installed); a failing one routes its
 * findings (`failFinalReview`).
 */
export const startFinalReview = (k: Kernel, h: RunHandle, featureId: string): void => {
  if (finalReviewGatesDone(h, featureId)) return;
  k.spawn(h, `final:${featureId}`, async () => {
    const feature = h.state.features.get(featureId);
    if (feature === undefined) return;
    const ws = k.deps.workspace;
    let reports: GateReport[];
    let readiness: ReleaseReadiness | null = null;
    // the AI steps the fix since the round before cannot have changed (null: all of them run)
    let unaffected: number[] | null = null;
    try {
      const head = await ws.resolve(feature.integration_branch);
      const base =
        (
          await runGit(k.deps.repoRoot, ["merge-base", await baseBranch(k.deps.repoRoot), head], {
            allowFailure: true,
          })
        ).stdout
          .toString("utf8")
          .trim() || head;
      const covers = [...new Set(feature.tasks.flatMap((t) => h.state.tasks.get(t)?.covers ?? []))];
      const request = finalReviewRequest(h, featureId, { base, head, req_tags: covers });
      reports = await runGatesRetryingFlaky(k, h, {
        ...request,
        // step 5's deterministic part: every screen of a feature with UI (AD-24)
        ...(featureHasUi(h.state, featureId) ? { visual: { screens: [] } } : {}),
      });
      try {
        const listedFiles = (
          await runGit(k.deps.repoRoot, ["ls-tree", "-r", "--name-only", "-z", base])
        ).stdout
          .toString("utf8")
          .split("\0")
          .filter((p) => p !== "");
        readiness = releaseReadiness(await k.deps.git.changedFiles(base, head), listedFiles);
      } catch {
        readiness = null; // step 7 then says it could not be computed
      }
      const previous = feature.round > 0 ? previousRoundHead(h, featureId) : undefined;
      if (previous !== undefined) {
        try {
          const affected = fixAffectedSteps(await k.deps.git.changedFiles(previous, head));
          unaffected = FINAL_REVIEW_AI_STEPS.map((s) => s.step).filter(
            (step) => !affected.includes(step),
          );
        } catch {
          unaffected = null; // if unsure, run it
        }
      }
    } catch (error) {
      await k.serial(h, () => {
        parkFeature(
          k,
          h,
          featureId,
          "gate_infra",
          `Final Review gates could not run: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
          [],
        );
        return Promise.resolve();
      });
      return;
    }
    await k.serial(h, () => {
      for (const r of reports) emitGateResult(k, h, r);
      const report = reports.at(-1);
      const current = h.state.features.get(featureId);
      if (report === undefined || current?.status !== "final_review") return Promise.resolve();
      const verdict = effectiveVerdict(report);
      const evidence = report.results.flatMap((r) => r.evidence).slice(0, 5);
      if (verdict === "infra_error") {
        parkFeature(
          k,
          h,
          featureId,
          "gate_infra",
          report.verdict === "infra_error"
            ? "Final Review gates failed for infrastructure reasons"
            : "Final Review's visual step failed for infrastructure reasons",
          evidence,
        );
        return Promise.resolve();
      }
      if (verdict === "fail") {
        stepFinished(k, h, featureId, {
          step: 1,
          status: "fail",
          evidence: [{ type: "commit", ref: report.head }],
        });
        if (report.visual !== undefined)
          stepFinished(k, h, featureId, visualStep(report, featureHasUi(h.state, featureId)));
        failFinalReview(
          k,
          h,
          featureId,
          gateReportFindings(k, report, current.round + 1).map((f) => ({
            ...f,
            feature: featureId,
          })),
          evidence,
        );
        return Promise.resolve();
      }
      // this round's result only: a readiness that could not be computed removes the last
      // round's file, so step 7 says so instead of reading the old one back
      if (readiness !== null)
        writeRepoFile(
          k.deps.repoRoot,
          releaseReadinessPath(featureId),
          `${JSON.stringify(readiness, null, 2)}\n`,
        );
      else removeRepoFile(k.deps.repoRoot, releaseReadinessPath(featureId));
      recordGateSteps(k, h, featureId, report);
      // step 3 is never carried over a traceability gap of this round: it runs and fails on it
      if (unaffected !== null)
        carryOver(
          k,
          h,
          featureId,
          unaffected.filter((step) => step !== 3 || traceabilityGaps(k, report).length === 0),
        );
      const seq = gatesPassedSeq(h, featureId);
      if (seq !== undefined) {
        const carried = carriedSteps(h, featureId, seq);
        // nothing left to dispatch: no reviewer role installed, or every step carried over
        if (
          aiSteps(k).every((s) => carried.has(s.step)) &&
          roundVisualReport(k, h, featureId) === undefined
        )
          conclude(k, h, featureId, seq);
      }
      return Promise.resolve();
    });
  });
};
