/**
 * Triage routing (§6.3 step 8). Pure: the engine decides where a finding goes from the finding's
 * source, category, kind and normalised severity, never from the reviewer's opinion of a route.
 */
import type { FindingCategory, FindingKind, FindingRoute, FindingSource } from "../finding.js";
import type { Severity } from "../primitives.js";

export interface RouteInput {
  readonly source: FindingSource;
  readonly category: FindingCategory;
  /** Reviewer-supplied for role findings; absent for tool findings. */
  readonly kind?: FindingKind | undefined;
  /** Normalised severity (`normalizeSeverity`). */
  readonly severity: Severity;
}

const ROUTE_BY_KIND: Readonly<Record<FindingKind, FindingRoute>> = {
  implementation_deviation: "patch",
  design_ambiguity: "design_gap",
  observed_mismatch: "spec_gap",
  spec_ambiguity: "spec_gap",
  test_defect: "bad_test",
};

/**
 * The route of one finding:
 * 1. any secret → `risky` (§7.6 rule 1 escalates at once, no loop);
 * 2. test adequacy (QA judge) → `bad_test`;
 * 3. `info` severity → `defer` (recorded in `deferred[]`, never blocks);
 * 4. tool findings → `patch`;
 * 5. role findings by kind: implementation deviation → `patch`, design ambiguity → `design_gap`,
 *    an observed-assertion mismatch or spec ambiguity → `spec_gap`, a test defect → `bad_test`.
 * Other risk rules (§7.6) park the task in the Risk Router, outside this function. The seventh
 * route, `out_of_scope`, comes from a guarded Engineer exit, never from a finding.
 */
export const routeForFinding = (input: RouteInput): FindingRoute => {
  if (input.category === "secret") return "risky";
  if (input.category === "test_adequacy") return "bad_test";
  if (input.severity === "info") return "defer";
  if (input.source === "tool" || input.kind === undefined) return "patch";
  return ROUTE_BY_KIND[input.kind];
};
