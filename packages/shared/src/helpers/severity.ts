/**
 * Severity normalisation (§6.3 step 8: "ignore the reviewer's own severity: the engine
 * normalises severity itself"). Pure functions, no I/O.
 */
import type { FindingCategory } from "../finding.js";
import type { Severity } from "../primitives.js";

/** Most severe first. */
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

/** Higher number = more severe. */
export const severityRank = (severity: Severity): number =>
  SEVERITY_ORDER.length - 1 - SEVERITY_ORDER.indexOf(severity);

/** True when `severity` is at or above `threshold` (e.g. the auto-merge block threshold, §6.7). */
export const isAtLeast = (severity: Severity, threshold: Severity): boolean =>
  severityRank(severity) >= severityRank(threshold);

/**
 * Severity a role finding gets from its category. Reviewer claims are ignored.
 *
 * Only security-class categories are `high` or above, because §7.6 rule 9 parks a task on any
 * high/critical finding still open after one round (`openHighRuleFires`). An ordinary
 * correctness bug is `medium`: it goes through the normal fix loop up to the 3–5 round cap
 * (D6, §6.3 step 9) and still blocks Level-3 auto-merge at the default threshold (§6.7).
 */
export const ROLE_CATEGORY_SEVERITY: Readonly<Record<FindingCategory, Severity>> = {
  secret: "critical",
  security: "high",
  supply_chain: "high",
  test_integrity: "high",
  correctness: "medium",
  spec_mismatch: "medium",
  test_adequacy: "medium",
  accessibility: "medium",
  architecture: "medium",
  performance: "medium",
  design: "low",
  maintainability: "low",
  docs: "info",
};

/** SARIF 2.1.0 `result.level`. */
export type SarifLevel = "error" | "warning" | "note" | "none";

const SARIF_LEVEL_SEVERITY: Readonly<Record<SarifLevel, Severity>> = {
  error: "high",
  warning: "medium",
  note: "low",
  none: "info",
};

/** Tool-specific labels (Opengrep, Gitleaks, osv-scanner, Checkov, Bandit, gosec…), lower-cased. */
const LABEL_SEVERITY: Readonly<Record<string, Severity>> = {
  critical: "critical",
  crit: "critical",
  blocker: "critical",
  fatal: "critical",
  high: "high",
  error: "high",
  major: "high",
  severe: "high",
  medium: "medium",
  moderate: "medium",
  med: "medium",
  warning: "medium",
  warn: "medium",
  low: "low",
  minor: "low",
  note: "low",
  info: "info",
  informational: "info",
  information: "info",
  none: "info",
  hint: "info",
};

/**
 * Maps a CVSS-style score (0–10) to a severity, using the same bands as GitHub code
 * scanning's `security-severity`: >= 9 critical, >= 7 high, >= 4 medium, > 0 low, 0 info.
 */
export const severityFromScore = (score: number): Severity => {
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    throw new RangeError(`security score must be within 0..10, got ${String(score)}`);
  }
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "info";
};

export interface ToolSeverityInput {
  readonly source: "tool";
  /** CVSS-style score, e.g. SARIF `properties["security-severity"]`. Wins when present. */
  readonly score?: number;
  /** The tool's own label, e.g. `HIGH`, `moderate`. Used when there is no score. */
  readonly label?: string;
  /** SARIF `level`. Used when there is neither a score nor a known label. */
  readonly sarifLevel?: SarifLevel;
}

export interface RoleSeverityInput {
  readonly source: "role";
  readonly category: FindingCategory;
}

export type SeverityInput = ToolSeverityInput | RoleSeverityInput;

/**
 * Deterministic severity for any finding.
 * - Role findings: from the category table; the reviewer's claim is never an input.
 * - Tool findings: score, then known label, then SARIF level; anything unrecognised is
 *   `medium`, so an unknown never silently passes the default auto-merge threshold (§6.7).
 */
export const normalizeSeverity = (input: SeverityInput): Severity => {
  if (input.source === "role") return ROLE_CATEGORY_SEVERITY[input.category];
  if (input.score !== undefined) return severityFromScore(input.score);
  if (input.label !== undefined) {
    const mapped = LABEL_SEVERITY[input.label.trim().toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  if (input.sarifLevel !== undefined) return SARIF_LEVEL_SEVERITY[input.sarifLevel];
  return "medium";
};

/** Sum of severities for stuck detection ("weighted severity does not drop", §6.3 step 9). */
export const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = {
  critical: 27,
  high: 9,
  medium: 3,
  low: 1,
  info: 0,
};

export const weightedSeverity = (severities: readonly Severity[]): number =>
  severities.reduce((sum, severity) => sum + SEVERITY_WEIGHT[severity], 0);

/**
 * §7.6 rule 9: a high or critical finding still open after one fix round parks the task
 * (`risk_rule` `open_high_finding`). `currentRound` is the round being verified; a finding first
 * seen in an earlier round has had its fix round.
 */
export const openHighRuleFires = (
  finding: {
    readonly severity: Severity;
    readonly status: string;
    readonly round_first_seen: number;
  },
  currentRound: number,
): boolean =>
  finding.status === "open" &&
  isAtLeast(finding.severity, "high") &&
  currentRound > finding.round_first_seen;
