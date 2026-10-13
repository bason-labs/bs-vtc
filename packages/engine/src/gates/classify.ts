/**
 * Deterministic failure classification (§6.3 step 8: "deterministic rules decide first"):
 * infrastructure and timeout signatures, and tests known to be flaky from calibration. Anything
 * the rules cannot place is `product` ("unsure means product"). Pure.
 */
import type { FailureClass } from "@vtc/shared";

/** Log signatures of a broken environment rather than broken code. */
export const ENVIRONMENT_SIGNATURES: readonly RegExp[] = [
  /\bENOSPC\b|No space left on device/i,
  /\bENOMEM\b|Cannot allocate memory|JavaScript heap out of memory|\bout of memory\b/i,
  /\bEAI_AGAIN\b|\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b/,
  /Network is unreachable|Could not resolve host|Temporary failure in name resolution/i,
  /\bEMFILE\b|Too many open files/i,
  /Killed: 9|signal: killed|SIGKILL/,
  /command not found|is not recognized as an internal or external command/i,
];

/** The first log line (1-based) that matches an environment signature, or `null`. */
export const environmentSignatureLine = (log: string): number | null => {
  const lines = log.split("\n");
  for (const [i, line] of lines.entries()) {
    if (ENVIRONMENT_SIGNATURES.some((p) => p.test(line))) return i + 1;
  }
  return null;
};

export interface FailureFacts {
  /** The command could not be started (`ENOENT`, permission). */
  readonly spawnError?: string | undefined;
  readonly timedOut: boolean;
  /** The configured report is missing or unreadable. */
  readonly reportProblem?: string | undefined;
  /** The combined output of the command (only its tail). */
  readonly log: string;
  /** The new failing tests, for L2. */
  readonly failingTests?: readonly string[];
  /** Test ids calibration recorded as flaky (`gates.yml` `baseline.flaky_tests`). */
  readonly flakyTests?: readonly string[];
}

/** Classifies a failed or errored gate. */
export const classifyFailure = (facts: FailureFacts): FailureClass => {
  if (facts.timedOut) return "infra";
  if (facts.spawnError !== undefined)
    return facts.spawnError === "ENOENT" ? "environment" : "infra";
  const failing = facts.failingTests ?? [];
  if (failing.length > 0) {
    // Tests ran and failed: the report explains the failure, whatever the log mentions.
    const flaky = facts.flakyTests ?? [];
    return failing.every((id) => flaky.includes(id)) ? "flaky" : "product";
  }
  if (environmentSignatureLine(facts.log) !== null) return "environment";
  if (facts.reportProblem !== undefined) return "infra";
  return "product";
};
