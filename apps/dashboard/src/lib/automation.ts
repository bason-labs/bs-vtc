import {
  EVIDENCE_BRANCH,
  type AutoKind,
  type AutomationItem,
  type AutomationReport,
  type AutomationSkipReason,
  type AutoTargetRef,
  type EvidenceHosting,
  type EvidencePartialReason,
} from "@vtc/shared";
import { webUrl } from "./events";
import type { StatusMeta } from "./states";

/**
 * The Automation view (D-ca, spine AD-27 rule 7): whether VTC raises issues and opens pull
 * requests for this project and why not (`AutomationReport.notes`), every issue and PR it opened
 * with links and state, and the latest actions it did not take with the reason. VTC never merges
 * what it opens (D-bw): a human reviews and merges each PR.
 */
export const AUTO_KIND_LABELS: Readonly<Record<AutoKind, string>> = {
  lookback: "Lookback prompt change",
  defect: "VTC defect",
  cost: "Cost regression",
  security: "Security finding in VTC's dependencies",
  new_agent: "New agent",
  tool: "New engine tool",
  config: "Workflow or config change",
  capability: "Missing capability",
  parked: "Parked task",
  ci_failure: "Post-merge CI failure",
  escaped_defect: "Escaped defect",
  finding: "Finding outside a task's scope",
  final_review: "Final Review leftover",
};

export const SKIP_REASONS: Readonly<Record<AutomationSkipReason, string>> = {
  paused: "VTC is paused (vtc pause)",
  disabled: "turned off in the project config",
  no_github_remote: "the project has no GitHub remote",
  gh_unavailable: "gh is missing or not logged in",
  share_off: "upstream sharing is off",
  no_upstream_checkout: "no local bs-vtc checkout to build the PR in",
  rate_limit: "a VTC rate limit was reached",
  github_rate_limit: "GitHub's rate limit, after backing off",
  duplicate: "already raised and commented on recently",
  muted: "a human muted it",
  privacy: "the privacy check refused the content",
  evidence_failed: "evidence capture failed twice, so no PR was opened",
  weekly_window: "the Lead host's weekly window is too low for replays",
  budget: "the Lookback budget is spent",
  trial_cap: "the replay trial cap for this retro is reached",
  plugin_locked: "a replay arm's plugin did not load (managed settings)",
  stale_baseline: "the replay measured another prompt than VTC's default branch now has",
  error: "it failed with an error (the detail says which)",
  out_of_scope: "the PR changed files its kind may not change (the detail names them)",
};

/**
 * Why an automatic PR's evidence is partial (D-ct; spine §5 reading 223), as
 * `upstream.pr_opened.partial_reason` names it.
 */
export const PARTIAL_EVIDENCE_REASONS: Readonly<Record<EvidencePartialReason, string>> = {
  base_build_failed: "the base commit did not build, so there is no before picture",
  base_serve_failed: "the base commit did not serve, so there is no before picture",
  no_visual_app: "the project names no app to render (gates.yml visual.app)",
  no_browser: "no browser is installed for the capture (vtc doctor installs one)",
  video_off: "video is turned off (automation.evidence.video: false)",
  no_ffmpeg: "ffmpeg is not installed, so the recording is linked as WebM only (no GIF or MP4)",
  capture_failed: "a capture failed after its retry",
};

const HOSTING: Readonly<Record<EvidenceHosting, string>> = {
  branch: `committed to the orphan ${EVIDENCE_BRANCH} branch`,
  attach: "uploaded with gh --attach",
};

const ISSUE_STATES: Readonly<Record<"open" | "closed", StatusMeta>> = {
  open: { label: "open", tone: "accent" },
  closed: { label: "closed", tone: "neutral" },
};

const PR_STATES: Readonly<Record<"draft" | "open" | "closed" | "merged", StatusMeta>> = {
  draft: { label: "draft", tone: "neutral" },
  open: { label: "open for review", tone: "accent" },
  closed: { label: "closed", tone: "neutral" },
  merged: { label: "merged", tone: "ok" },
};

const EVIDENCE: Readonly<Record<"complete" | "partial", StatusMeta>> = {
  complete: { label: "evidence complete", tone: "ok" },
  partial: { label: "evidence partial", tone: "warn" },
};

/** `This project · owner/name` or `VTC · owner/name`. */
export const targetText = (target: AutoTargetRef): string =>
  `${target.kind === "upstream" ? "VTC" : "This project"} · ${target.repo}`;

export interface AutomationLink {
  readonly label: string;
  /** http(s) only, else `null` (shown without a link). */
  readonly href: string | null;
  readonly state: StatusMeta;
}

export interface AutomationItemView {
  readonly key: string;
  readonly kind: string;
  readonly target: string;
  readonly fingerprint: string;
  readonly issue: AutomationLink | null;
  readonly pr:
    | (AutomationLink & {
        readonly evidence: StatusMeta;
        /** Why the evidence is partial, when it is and the engine knows (D-ct), else `null`. */
        readonly partialReason: string | null;
      })
    | null;
  readonly first: string;
  readonly last: string;
}

export interface AutomationSkipView {
  readonly key: string;
  readonly at: string;
  readonly reason: string;
  readonly kind: string | null;
  readonly detail: string;
}

export interface AutomationView {
  readonly switches: readonly {
    readonly id: string;
    readonly label: string;
    readonly on: boolean;
  }[];
  /** Neither issues nor PRs are raised for this project. */
  readonly off: boolean;
  readonly hosting: string;
  readonly notes: readonly string[];
  readonly items: readonly AutomationItemView[];
  readonly skipped: readonly AutomationSkipView[];
}

const itemView = (item: AutomationItem): AutomationItemView => ({
  key: `${item.target.repo}|${item.kind}|${item.fingerprint}`,
  kind: AUTO_KIND_LABELS[item.kind],
  target: targetText(item.target),
  fingerprint: item.fingerprint,
  issue:
    item.issue === null
      ? null
      : {
          label: `Issue #${String(item.issue.number)}`,
          href: webUrl(item.issue.url),
          state: ISSUE_STATES[item.issue.state],
        },
  pr:
    item.pr === null
      ? null
      : {
          label: `PR #${String(item.pr.number)}`,
          href: webUrl(item.pr.url),
          state: PR_STATES[item.pr.state],
          evidence: EVIDENCE[item.pr.evidence],
          partialReason:
            item.pr.evidence === "partial" && item.pr.partial_reason !== undefined
              ? PARTIAL_EVIDENCE_REASONS[item.pr.partial_reason]
              : null,
        },
  first: item.first_at,
  last: item.last_at,
});

const newestFirst = <T>(rows: readonly T[], at: (row: T) => string): T[] =>
  [...rows].sort((a, b) => at(b).localeCompare(at(a)));

export const automationView = (report: AutomationReport): AutomationView => ({
  switches: [
    { id: "issues", label: "Issues", on: report.issues },
    { id: "prs", label: "Pull requests", on: report.prs },
    { id: "upstream", label: `Reports to ${report.upstream_repo}`, on: report.upstream },
  ],
  off: !report.issues && !report.prs,
  hosting: HOSTING[report.evidence_hosting],
  notes: report.notes,
  items: newestFirst(report.items.map(itemView), (i) => i.last),
  skipped: newestFirst(report.skipped, (s) => s.at).map((s, i) => ({
    key: `${s.at}|${String(i)}`,
    at: s.at,
    reason: SKIP_REASONS[s.reason],
    kind: s.kind === undefined ? null : AUTO_KIND_LABELS[s.kind],
    detail: s.detail,
  })),
});
