import type {
  ReleaseReadiness,
  AutoMergeChecklistItemId,
  AutoMergeDisabled,
  AutoMergeState,
  Evidence,
  FinalReviewStepResult,
  MergePreflightFailure,
  RequiredCheckState,
  VtcEvent,
} from "@vtc/shared";
import { eventData, eventsOfType } from "./events";
import type { StatusMeta } from "./states";

/**
 * Level-3 auto-merge (spec §6.7, spine AD-23) and Final Review steps (§6.7a), read from the run's
 * events (spine §5 reading 109): the preflight at run start, the safe-to-auto-merge checklist,
 * the auto-merge state, base CI after the merge and reverts. VTC never changes repository
 * settings, so a failed preflight says what the human should configure.
 */
export const PREFLIGHT_FIXES: Readonly<Record<MergePreflightFailure, string>> = {
  not_github: "The push remote is not on GitHub; Level 3 is GitHub-only.",
  gh_unauthenticated: "gh is not logged in: run gh auth login.",
  auto_merge_disallowed: "Allow auto-merge in the repository settings.",
  no_required_checks:
    "Add at least one required status check on the base branch; without one GitHub would merge without waiting for CI.",
  no_merge_method: "Enable a merge method (merge, squash or rebase) for the repository.",
};

export interface PreflightView {
  readonly at: string;
  readonly configured: number;
  readonly effective: number;
  readonly ok: boolean;
  readonly fixes: readonly string[];
  readonly detail: string | null;
  /** What the remote enforces on the base, one line each. */
  readonly policy: readonly string[];
}

/** The run's latest Level-3 preflight, or `null` when the run never asked for Level 3. */
export const mergePreflight = (events: readonly VtcEvent[]): PreflightView | null => {
  const last = eventsOfType(events, "merge.preflight").at(-1);
  if (last === undefined) return null;
  const { data } = last;
  const p = data.policy;
  return {
    at: last.event.ts,
    configured: data.configured_level,
    effective: data.effective_level,
    ok: data.ok,
    fixes: data.failed.map((f) => PREFLIGHT_FIXES[f]),
    detail: data.detail ?? null,
    policy:
      p === null
        ? []
        : [
            `Base ${p.base}`,
            p.auto_merge_allowed === null
              ? "Auto-merge setting unreadable"
              : p.auto_merge_allowed
                ? "Auto-merge allowed"
                : "Auto-merge not allowed",
            p.required_checks.length === 0
              ? "No required checks"
              : `Required checks: ${p.required_checks.join(", ")}`,
            p.merge_methods.length === 0
              ? "No merge method"
              : `Merge methods: ${p.merge_methods.join(", ")}`,
            ...(p.merge_queue ? ["Merge queue"] : []),
            ...(p.requires_review ? ["Requires an approving review"] : []),
            ...(p.signatures_required ? ["Requires signed commits"] : []),
          ],
  };
};

// ---------------------------------------------------------------- checklist

export const CHECKLIST_LABELS: Readonly<Record<AutoMergeChecklistItemId, string>> = {
  final_review: "Final Review passed and every gate is green",
  reviewers: "Every reviewer passed with evidence, no open findings at the threshold",
  coverage: "Requirement coverage is complete",
  test_integrity: "The test-integrity check is clean",
  risk_rules: "No risk rule fired",
  waivers: "No waivers and no parked dependencies",
  remote_ci: "Remote CI is green on the gated commit",
};

export const AUTO_MERGE_STATES: Readonly<Record<AutoMergeState, StatusMeta>> = {
  not_requested: { label: "Not requested", tone: "neutral" },
  awaiting_checks: { label: "Awaiting required checks", tone: "accent", live: true },
  awaiting_review: { label: "Awaiting an approving review", tone: "warn" },
  enabled: { label: "Auto-merge enabled", tone: "brand" },
  queued: { label: "In the merge queue", tone: "accent", live: true },
  merged: { label: "Merged", tone: "ok" },
  disabled: { label: "Auto-merge disabled", tone: "warn" },
};

export const REQUIRED_CHECK_STATES: Readonly<Record<RequiredCheckState, StatusMeta>> = {
  success: { label: "Success", tone: "ok" },
  pending: { label: "Pending", tone: "accent" },
  failure: { label: "Failure", tone: "danger" },
  skipped: { label: "Skipped", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "warn" },
  unknown: { label: "Unknown", tone: "neutral" },
};

export const AUTO_MERGE_DISABLED: Readonly<Record<AutoMergeDisabled["reason"], string>> = {
  paused: "vtc pause turned it off",
  head_moved: "the PR head moved past the gated commit",
  base_changed: "the base branch changed",
  conflict: "a merge conflict",
  by_host: "GitHub turned it off",
  timeout: "it waited too long for checks or a review",
};

const evidenceText = (e: readonly Evidence[]): string[] => e.map((x) => `${x.type}: ${x.ref}`);

export interface ChecklistView {
  readonly at: string;
  readonly ok: boolean;
  readonly items: readonly {
    readonly id: AutoMergeChecklistItemId;
    readonly label: string;
    readonly ok: boolean;
    readonly detail: string;
    readonly evidence: readonly string[];
  }[];
}

export interface Level3Item {
  readonly seq: number;
  readonly at: string;
  readonly tone: StatusMeta["tone"];
  readonly title: string;
  readonly detail: string | null;
}

const short = (sha: string): string => sha.slice(0, 8);

const timelineItem = (event: VtcEvent): Omit<Level3Item, "seq" | "at"> | null => {
  const enabled = eventData(event, "feature.auto_merge_enabled");
  if (enabled !== null) {
    return {
      tone: "accent",
      title: `Auto-merge enabled on PR #${String(enabled.pr_number)}`,
      detail: `${enabled.method}, bound to the gated commit ${short(enabled.head_sha)}${
        enabled.merge_queue ? ", through the merge queue" : ""
      }`,
    };
  }
  const disabled = eventData(event, "feature.auto_merge_disabled");
  if (disabled !== null) {
    return {
      tone: "warn",
      title: `Auto-merge turned off: ${AUTO_MERGE_DISABLED[disabled.reason]}`,
      detail: disabled.detail === AUTO_MERGE_DISABLED[disabled.reason] ? null : disabled.detail,
    };
  }
  const ci = eventData(event, "feature.post_merge_ci");
  if (ci !== null) {
    const failed = ci.runs.filter((r) => r.required && r.conclusion === "failure");
    return {
      tone: ci.status === "green" ? "ok" : ci.status === "red" ? "danger" : "accent",
      title: `Base CI after the merge: ${ci.status}`,
      detail:
        failed.length > 0
          ? `Failed required runs: ${failed.map((r) => r.name).join(", ")}`
          : `Merge commit ${short(ci.merge_commit)}`,
    };
  }
  const reverted = eventData(event, "feature.reverted");
  if (reverted !== null) {
    const by = reverted.revert;
    return {
      tone: "danger",
      title: "Merge reverted on the base branch",
      detail: `${reverted.detail}${
        by === undefined
          ? ""
          : ` (revert ${short(by.commit)}, found by ${by.detected_by.replace(/_/g, " ")})`
      }`,
    };
  }
  return null;
};

/** The feature's latest checklist and its auto-merge timeline, newest first. */
export const featureLevel3 = (
  events: readonly VtcEvent[],
  feature: string,
): { readonly checklist: ChecklistView | null; readonly timeline: readonly Level3Item[] } => {
  const own = events.filter((e) => e.feature === feature);
  const last = eventsOfType(own, "feature.checklist").at(-1);
  const timeline = own.flatMap((event): Level3Item[] => {
    const item = timelineItem(event);
    return item === null ? [] : [{ seq: event.seq, at: event.ts, ...item }];
  });
  return {
    checklist:
      last === undefined
        ? null
        : {
            at: last.event.ts,
            ok: last.data.ok,
            items: last.data.items.map((i) => ({
              id: i.id,
              label: CHECKLIST_LABELS[i.id],
              ok: i.ok,
              detail: i.detail,
              evidence: evidenceText(i.evidence),
            })),
          },
    timeline: timeline.sort((a, b) => b.seq - a.seq),
  };
};

// ------------------------------------------------------------ final review

/** The seven §6.7a steps, deterministic first. */
export const FINAL_REVIEW_STEP_NAMES: readonly string[] = [
  "Full gates",
  "Full acceptance run",
  "Spec-Verifier across the whole spec",
  "Security on the combined diff",
  "Visual QA on full user journeys",
  "Architecture conformance",
  "Release readiness",
];

const STEP_STATUS: Readonly<Record<FinalReviewStepResult["status"], StatusMeta>> = {
  pass: { label: "Passed", tone: "ok" },
  fail: { label: "Failed", tone: "danger" },
  not_run: { label: "Does not apply", tone: "neutral" },
  unchecked: { label: "Not passed: unchecked", tone: "danger" },
  skipped: { label: "Not passed: skipped", tone: "warn" },
};

export interface FinalReviewStepRow {
  readonly step: number;
  readonly name: string;
  /** `null` while the step has not reported. */
  readonly status: StatusMeta | null;
  /** Only `pass` counts: `skipped` and `unchecked` never do (spine §5 reading 105). */
  readonly passed: boolean;
  readonly reason: string | null;
  readonly evidence: readonly string[];
}

/** Rows for a list of step results (an evidence bundle's or the events'), the latest per step. */
export const stepRows = (results: readonly FinalReviewStepResult[]): FinalReviewStepRow[] =>
  FINAL_REVIEW_STEP_NAMES.map((name, i) => {
    const r = results.filter((x) => x.step === i + 1).at(-1);
    return {
      step: i + 1,
      name,
      status: r === undefined ? null : STEP_STATUS[r.status],
      passed: r?.status === "pass",
      reason: r?.reason ?? null,
      evidence: r === undefined ? [] : evidenceText(r.evidence),
    };
  });

/** The feature's Final Review steps from `final_review.step_finished` events. */
export const finalReviewStepRows = (
  events: readonly VtcEvent[],
  feature: string,
): FinalReviewStepRow[] =>
  stepRows(
    eventsOfType(
      events.filter((e) => e.feature === feature),
      "final_review.step_finished",
    ).map((e) => e.data),
  );

// -------------------------------------------------------- release readiness

export const RELEASE_READINESS_LABELS: Readonly<
  Record<ReleaseReadiness["items"][number]["id"], string>
> = {
  migration_order: "Migration order and reversibility",
  config_changes: "Configuration and environment changes",
  rollback_notes: "Rollback notes",
  docs: "Docs updated",
  changelog: "Changelog",
  feature_flags: "Feature flag plan",
};

const READINESS_STATUS: Readonly<Record<ReleaseReadiness["items"][number]["status"], StatusMeta>> =
  {
    pass: { label: "Passed", tone: "ok" },
    fail: { label: "Failed", tone: "danger" },
    not_applicable: { label: "Does not apply", tone: "neutral" },
  };

/** §6.7a step 7, one row per item in spec order. */
export const releaseReadinessRows = (
  readiness: ReleaseReadiness,
): { id: string; label: string; status: StatusMeta; note: string | null; evidence: string[] }[] =>
  readiness.items.map((i) => ({
    id: i.id,
    label: RELEASE_READINESS_LABELS[i.id],
    status: READINESS_STATUS[i.status],
    note: i.note ?? null,
    evidence: evidenceText(i.evidence),
  }));
