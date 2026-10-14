/**
 * How engine core reads a gate run (spine AD-24 rule 5, §5 reading 105). Pure. `GateReport.verdict`
 * stays a function of the gate results; the deterministic visual step's status is read beside
 * it: `fail` and `unchecked` fail the run (an unreached render or an axe `incomplete` item never
 * passes, §7.5), `error` is gate infrastructure, `skipped` (no browser, D-ay) is a visible note
 * that passes at Levels 1–2 and that Level 3 never counts as a pass (`autoMergeChecklist`).
 */
import {
  VISUAL_RULE_PREFIX,
  type GateReport,
  type GateVerdict,
  type ToolFinding,
} from "@vtc/shared";

/** The verdict the engine acts on: the report's, failed or infra-failed by its visual step. */
export const effectiveVerdict = (report: Pick<GateReport, "verdict" | "visual">): GateVerdict => {
  if (report.verdict !== "pass") return report.verdict;
  switch (report.visual?.status) {
    case "fail":
    case "unchecked":
      return "fail";
    case "error":
      return "infra_error";
    default:
      return "pass";
  }
};

/**
 * The visual step's findings when it failed the run, for triage like any tool finding. A failed
 * or unchecked step that reported none still yields one, so the round cannot pass unexplained.
 */
export const visualFindings = (report: Pick<GateReport, "visual">): ToolFinding[] => {
  const visual = report.visual;
  if (visual === undefined || (visual.status !== "fail" && visual.status !== "unchecked"))
    return [];
  if (visual.findings.length > 0) return [...visual.findings];
  const where = visual.report ?? ".vtc/design/screens.yaml";
  return [
    {
      tool: "visual",
      rule_id: VISUAL_RULE_PREFIX.unreached,
      category: "design",
      title:
        visual.status === "unchecked"
          ? `the visual step left ${String(visual.counts.unreached)} render(s) unreached or ${String(visual.counts.axe_incomplete)} axe item(s) to review`
          : "the visual step failed",
      location: { path: where },
      evidence: { type: "file", ref: where },
    },
  ];
};
