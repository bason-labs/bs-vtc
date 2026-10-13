/**
 * Which §6.7a Final Review steps a gate run covers, for `EvidenceBundle.final_review.steps_run`.
 * Shared so engine core can fill `steps_run` without importing the Gate Runner (AD-13 rule 1).
 * Only the deterministic steps can come from gates:
 * - step 1 "full gates": a `final_review` run at `full` scope where every configured layer ran
 *   (none narrowed away by `layers`) and no gate errored;
 * - step 2 "full acceptance run": that run asked for hidden tests (`include_hidden`), executed L2
 *   tests, and its traceability report shows hidden acceptance tests that actually ran
 *   (`hidden: true`). `include_hidden` alone is not enough: a feature run that copied no hidden
 *   tests (no `hidden_tasks`) is not a full acceptance run;
 * - step 6 "architecture conformance": an L6 fitness gate ran (pass or fail, not skipped or
 *   errored).
 * Steps 3–5 are AI reviewers and step 7 is release readiness; gates never cover them. Pure.
 */
import type { GateReport, GateRunRequest } from "../gate-result.js";
import type { TraceabilityReport } from "../traceability.js";

export const finalReviewStepsCovered = (
  request: Pick<GateRunRequest, "reason" | "scope" | "layers" | "include_hidden">,
  report: Pick<GateReport, "results">,
  /** The run's traceability report (`GateReport.traceability`), or `null` without one. */
  traceability: Pick<TraceabilityReport, "rows"> | null = null,
): number[] => {
  if (request.reason !== "final_review" || request.scope !== "full") return [];
  const steps: number[] = [];
  const ran = report.results.filter((r) => r.status === "pass" || r.status === "fail");
  const errored = report.results.some((r) => r.status === "error");
  if (request.layers === undefined && !errored) steps.push(1);
  const hiddenRan = traceability?.rows.some((row) => row.tests.some((t) => t.hidden)) ?? false;
  const l2Ran = ran.some((r) => r.layer === "L2" && r.tests !== undefined);
  if (request.include_hidden && hiddenRan && l2Ran) steps.push(2);
  if (ran.some((r) => r.layer === "L6")) steps.push(6);
  return steps;
};
