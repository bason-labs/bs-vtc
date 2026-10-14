/**
 * What Lookback hands the upstream module for an automatic issue or PR to bs-vtc (D-bv, D-cb, D-cd;
 * spine §5 readings 190, 193, 196 and 198): the VTC-side fields of an `UpstreamReport` only (role,
 * host, prompt SHA and numbers), never a run id, task, path or text from the project (D-by). The
 * upstream module adds the fingerprint, version, occurrence counts and dates, validates the whole
 * report against its allowlist schema and redacts it before anything leaves the machine.
 * - {@link improvementReportFields}: a replay verdict `improve` opens the bs-vtc PR; the human's
 *   merge of it is the promotion for everyone (D-cb, reading 196), and `vtc lookback approve|pin`
 *   stays a local canary on one machine.
 * - {@link costReportFields}: a cost regression (D-bv).
 * - {@link newAgentReportFields}: a missing specialist (D-cd), evidence-only with `needs-eval`.
 */
import type { ReplayResult, UpstreamReportInput } from "@vtc/shared";
import type { CostRegression } from "./cost-regression.js";
import type { NewAgentSignal } from "./new-agent.js";

export type LookbackReportFields = Pick<
  UpstreamReportInput,
  "kind" | "role" | "mode" | "host" | "prompt_sha" | "metrics"
>;

/** The `lookback` report of a replay that decided `improve`, or `null` for any other verdict. */
export const improvementReportFields = (result: ReplayResult): LookbackReportFields | null => {
  if (result.verdict !== "improve") return null;
  return {
    kind: "lookback",
    role: result.role,
    ...(result.mode === undefined ? {} : { mode: result.mode }),
    host: result.host,
    prompt_sha: result.candidate,
    metrics: {
      "replay.k": result.k,
      "replay.tasks": result.per_task.length,
      "replay.n_discordant": result.sign_test.n_discordant,
      "replay.wins_b": result.sign_test.wins_b,
      "replay.p": result.sign_test.p,
      "replay.aa_flip_rate": result.aa_flip_rate,
      "replay.tokens_delta_pct": result.tokens_delta_pct,
      "replay.read_denied": result.isolation === "read_denied" ? 1 : 0,
      "replay.verdict_graded": result.grader === "verdict" ? 1 : 0,
    },
  };
};

/** The `cost` report of a regression: the metric before and after, and both n. */
export const costReportFields = (r: CostRegression): LookbackReportFields => ({
  kind: "cost",
  role: r.role,
  ...(r.mode === undefined ? {} : { mode: r.mode }),
  host: r.host,
  prompt_sha: r.current.effective_sha256,
  metrics: {
    [`${r.metric}.baseline`]: r.baseline_value,
    [`${r.metric}.current`]: r.current_value,
    [`${r.metric}.delta_pct`]: r.delta_pct,
    "n.baseline": r.n.baseline,
    "n.current": r.n.current,
  },
});

/** The `new_agent` report of a signal: the proposed role and the counts behind it. */
export const newAgentReportFields = (s: NewAgentSignal): LookbackReportFields => ({
  kind: "new_agent",
  role: s.proposed_role,
  metrics: { failures: s.failures, escalations: s.escalations },
});
