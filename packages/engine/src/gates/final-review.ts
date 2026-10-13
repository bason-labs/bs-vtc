/**
 * Which §6.7a Final Review steps a gate run covers, for `EvidenceBundle.final_review.steps_run`.
 * Only the deterministic steps can come from gates:
 * - step 1 "full gates": a `final_review` run at `full` scope where every configured layer ran
 *   (none narrowed away by `layers`), L5 aside, and nothing errored;
 * - step 2 "full acceptance run": that run executed L2 tests with the hidden tests included;
 * - step 6 "architecture conformance": an L6 fitness gate ran (pass or fail, not skipped or errored).
 * Steps 3–5 are AI reviewers and step 7 is release readiness; gates never cover them. Pure.
 */
import type { GateReport, GateRunRequest } from "@vtc/shared";

export const finalReviewStepsCovered = (
  request: Pick<GateRunRequest, "reason" | "scope" | "layers" | "include_hidden">,
  report: Pick<GateReport, "results">,
): number[] => {
  if (request.reason !== "final_review" || request.scope !== "full") return [];
  const steps: number[] = [];
  const ran = report.results.filter((r) => r.status === "pass" || r.status === "fail");
  const errored = report.results.some((r) => r.status === "error");
  if (request.layers === undefined && !errored) steps.push(1);
  if (request.include_hidden && ran.some((r) => r.layer === "L2" && r.tests !== undefined))
    steps.push(2);
  if (ran.some((r) => r.layer === "L6")) steps.push(6);
  return steps;
};
