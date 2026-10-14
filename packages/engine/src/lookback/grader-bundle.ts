/**
 * The grader bundle (spec §13 "Protection"; AD-21 rule 5): what scores a prompt version. Graders
 * are the gates (named by the committed gates config hash), the metric code is this module's
 * version together with the attribution tree and the Lookback limits, and the judge model is fixed
 * in the bundle. Every scorecard and replay stores the bundle's SHA, so a score computed by other
 * graders is never compared with it. All of it is engine code the lookback role cannot write.
 */
import { ATTRIBUTION_TREE, LOOKBACK_LIMITS, sha256Hex } from "@vtc/shared";

/** Bump when a metric's definition changes (scorecards.ts, attribution.ts). */
export const LOOKBACK_METRICS_VERSION = 1;

export interface GraderBundle {
  /** The model AI review verdicts in replays come from; `null` when replays use gates only. */
  readonly judgeModel: string | null;
  /** `gatesConfigHash` of the committed `.vtc/gates.yml`; `null` before calibration. */
  readonly gatesConfigHash: string | null;
}

/** SHA-256 of the bundle's canonical JSON. */
export const graderBundleSha = (bundle: GraderBundle): string =>
  sha256Hex(
    JSON.stringify({
      metrics_version: LOOKBACK_METRICS_VERSION,
      attribution_tree: Object.entries(ATTRIBUTION_TREE).sort(([a], [b]) => a.localeCompare(b)),
      limits: Object.entries(LOOKBACK_LIMITS).sort(([a], [b]) => a.localeCompare(b)),
      judge_model: bundle.judgeModel,
      gates_config_hash: bundle.gatesConfigHash,
    }),
  );
