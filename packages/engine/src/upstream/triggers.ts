/**
 * Trigger evaluation (D-bv, D-cd; spine §5 reading 190): from the engine facts the daemon hands
 * over, which automatic item (if any) to raise, its target, kind and fingerprint. Upstream items
 * carry only the facts the allowlist projection reads; project items may carry project details,
 * because they stay in the project's repo. A Lookback `improve` verdict is a PR, not an issue
 * (`lookback-pr.ts`).
 */
import {
  LOOKBACK_LIMITS,
  type AutoFingerprint,
  type AutoKind,
  type ScorecardMetricId,
} from "@vtc/shared";
import { autoFingerprint, vtcFramesFromStack } from "./fingerprint.js";
import type { UpstreamFacts } from "./privacy.js";

type ProjectKind = "parked" | "ci_failure" | "escaped_defect" | "finding" | "final_review";

/** A recurring VTC defect raises an issue from this many occurrences (D-bv "recurring"). */
export const DEFECT_MIN_OCCURRENCES = 2;

/** Facts the daemon hands the upstream module (engine core wires them, AD-27 rule 8). */
export type AutomationFact =
  | {
      /** An engine incident, `gate_infra` error, adapter parse failure, crash or stuck loop. */
      readonly type: "vtc_defect";
      readonly errorClass: string;
      readonly role?: string | undefined;
      readonly mode?: string | undefined;
      readonly host?: string | undefined;
      readonly model?: string | undefined;
      readonly promptSha?: string | undefined;
      /** A raw stack; only VTC frames are kept (`vtcFramesFromStack`). */
      readonly stack?: string | undefined;
      readonly at: string;
    }
  | {
      /** A role's quality per token or cost per task against its baseline prompt. */
      readonly type: "cost_regression";
      readonly role: string;
      readonly host?: string | undefined;
      readonly model?: string | undefined;
      readonly metric: ScorecardMetricId | "tokens_per_task";
      readonly baselinePromptSha: string;
      readonly promptSha?: string | undefined;
      readonly baseline: number;
      readonly current: number;
      readonly at: string;
    }
  | {
      /** An OSV or scanner finding in VTC's own dependencies (no version: a bump updates it). */
      readonly type: "security_advisory";
      readonly advisoryId: string;
      readonly package: string;
      readonly at: string;
    }
  | {
      /** D-cd: a missing specialist, a recurring script, a cap/budget/routing change, a capability. */
      readonly type: "improvement";
      readonly kind: "new_agent" | "tool" | "config" | "capability";
      /** A role, discipline or capability id (VTC vocabulary, never project text). */
      readonly subject: string;
      readonly role?: string | undefined;
      readonly metrics?: Readonly<Record<string, number>> | undefined;
      readonly at: string;
    }
  | {
      /** A problem in the app VTC builds (D-bv project targets). */
      readonly type: "project_problem";
      readonly kind: ProjectKind;
      readonly ruleId: string;
      /** Project-relative path, when the problem has one. */
      readonly path?: string | undefined;
      readonly taskKind?: string | undefined;
      /** Issue title and Markdown details (project details allowed; redacted before sending). */
      readonly title: string;
      readonly detail: string;
      readonly run?: string | undefined;
      readonly at: string;
    };

/** What a fact raises. */
export type AutoWorkItem =
  | {
      readonly target: "upstream";
      readonly kind: AutoKind;
      readonly fingerprint: AutoFingerprint;
      readonly minOccurrences: number;
      /** Without occurrence counts: the module adds them from the ledger at send time. */
      readonly facts: Omit<UpstreamFacts, "occurrences" | "firstSeen" | "lastSeen">;
      readonly at: string;
    }
  | {
      readonly target: "project";
      readonly kind: ProjectKind;
      readonly fingerprint: AutoFingerprint;
      readonly minOccurrences: number;
      readonly title: string;
      readonly detail: string;
      readonly run?: string | undefined;
      readonly at: string;
    };

const pct = (baseline: number, current: number): number =>
  baseline === 0 ? (current > 0 ? Infinity : 0) : ((current - baseline) / baseline) * 100;

/**
 * Pure: whether a cost or quality metric worsened beyond `LOOKBACK_LIMITS` against its baseline:
 * tokens per success or per task rising more than `maxTokenRisePct`, or the escalation or cap-hit
 * rate reaching `rollbackRateRatio` times its baseline.
 */
export const costRegressed = (
  metric: ScorecardMetricId | "tokens_per_task",
  baseline: number,
  current: number,
): boolean => {
  switch (metric) {
    case "tokens_per_success":
    case "tokens_per_task":
      return pct(baseline, current) > LOOKBACK_LIMITS.maxTokenRisePct;
    case "escalations_per_100":
    case "cap_hits_per_100":
      return baseline > 0 && current >= baseline * LOOKBACK_LIMITS.rollbackRateRatio;
    default:
      return false;
  }
};

/** Pure: the item `fact` raises, or `null` when it raises nothing. */
export const evaluateTrigger = (
  fact: AutomationFact,
  options: { readonly vtcVersion: string; readonly vtcRoots?: readonly string[] },
): AutoWorkItem | null => {
  const base = { vtcVersion: options.vtcVersion };
  switch (fact.type) {
    case "vtc_defect": {
      const frames =
        fact.stack === undefined ? [] : vtcFramesFromStack(fact.stack, options.vtcRoots);
      const fingerprint = autoFingerprint({
        kind: "defect",
        errorClass: fact.errorClass,
        ...(fact.host === undefined ? {} : { host: fact.host }),
        ...(fact.role === undefined ? {} : { role: fact.role }),
        frames,
      });
      return {
        target: "upstream",
        kind: "defect",
        fingerprint,
        minOccurrences: DEFECT_MIN_OCCURRENCES,
        facts: {
          ...base,
          kind: "defect",
          fingerprint,
          role: fact.role,
          mode: fact.mode,
          host: fact.host,
          model: fact.model,
          promptSha: fact.promptSha,
          errorClass: fact.errorClass,
          frames,
        },
        at: fact.at,
      };
    }
    case "cost_regression": {
      if (!costRegressed(fact.metric, fact.baseline, fact.current)) return null;
      const fingerprint = autoFingerprint({
        kind: "cost",
        role: fact.role,
        metric: fact.metric,
        baselinePromptSha: fact.baselinePromptSha,
      });
      const delta = pct(fact.baseline, fact.current);
      return {
        target: "upstream",
        kind: "cost",
        fingerprint,
        minOccurrences: 1,
        facts: {
          ...base,
          kind: "cost",
          fingerprint,
          role: fact.role,
          host: fact.host,
          model: fact.model,
          promptSha: fact.promptSha ?? fact.baselinePromptSha,
          metrics: {
            [`baseline.${fact.metric}`]: fact.baseline,
            [`current.${fact.metric}`]: fact.current,
            ...(Number.isFinite(delta) ? { "delta.pct": Math.round(delta * 10) / 10 } : {}),
          },
        },
        at: fact.at,
      };
    }
    case "security_advisory": {
      const fingerprint = autoFingerprint({
        kind: "security",
        advisoryId: fact.advisoryId,
        package: fact.package,
      });
      return {
        target: "upstream",
        kind: "security",
        fingerprint,
        minOccurrences: 1,
        facts: {
          ...base,
          kind: "security",
          fingerprint,
          advisory: { id: fact.advisoryId, package: fact.package },
        },
        at: fact.at,
      };
    }
    case "improvement": {
      const fingerprint =
        fact.kind === "new_agent"
          ? autoFingerprint({ kind: "new_agent", subject: fact.subject, proposalKind: "role" })
          : autoFingerprint({ kind: fact.kind, subject: fact.subject });
      return {
        target: "upstream",
        kind: fact.kind,
        fingerprint,
        minOccurrences: 1,
        facts: { ...base, kind: fact.kind, fingerprint, role: fact.role, metrics: fact.metrics },
        at: fact.at,
      };
    }
    case "project_problem": {
      const fingerprint = autoFingerprint({
        kind: fact.kind,
        ruleId: fact.ruleId,
        ...(fact.path === undefined ? {} : { path: fact.path }),
        ...(fact.taskKind === undefined ? {} : { taskKind: fact.taskKind }),
      });
      return {
        target: "project",
        kind: fact.kind,
        fingerprint,
        minOccurrences: 1,
        title: fact.title,
        detail: fact.detail,
        run: fact.run,
        at: fact.at,
      };
    }
  }
};
