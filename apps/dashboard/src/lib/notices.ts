import {
  AUTOMATION_LIMITS,
  isEventOfType,
  readEventData,
  type AutoKind,
  type AutoTargetRef,
  type CoreEventType,
  type EventData,
  type EventPage,
  type IncidentKind,
  type VtcEvent,
} from "@vtc/shared";
import { AUTO_KIND_LABELS, SKIP_REASONS } from "./automation";
import { eventData, webUrl } from "./events";
import { formatGateDuration } from "./gates";
import { headlessOutcomeMeta, PREFLIGHT_CHECKS, PREFLIGHT_PURPOSES } from "./headless";
import { AUTO_MERGE_DISABLED, PREFLIGHT_FIXES } from "./level3";
import { withoutReplayTrials } from "./replay-trials";
import type { Tone } from "./states";

/**
 * Run notices (§6.7, §15 incident reports): events the human must see although nothing is
 * waiting on an answer. A failed push or PR update (`branch.push_failed`, `feature.pr_failed`),
 * an incident (`config_changed`, `checkout_write` and the unclean-end kinds) and a merge-level
 * change (`no_remote`: Level 2+ in a repo without a push remote, spine §5 reading 18). Since
 * contracts 4.5.0 also a failed Level-3 preflight, auto-merge turned off, a red base CI or a
 * revert after a Level-3 merge (AD-23), an engine-launched run that did not finish or could not
 * start (AD-25) and a prompt canary rolled back (AD-21). Since 4.7.0 a pinned or canary prompt
 * the engine did not use (`prompt_selection`, spine §5 readings 137 and 176), folded into one
 * notice per detail since core records one per dispatch. Since 5.0.0 every automatic issue and
 * PR VTC opened, updated or closed (`upstream.*`) and every automatic action it did not take
 * (`automation.skipped`, with its reason; D-ca, AD-27 rule 7). The engine still owns all state:
 * these are read from the run's event log and only explained here.
 */

/** Event types that make a notice, or resolve one (a later push or PR update). */
export const NOTICE_EVENT_TYPES: ReadonlySet<CoreEventType> = new Set<CoreEventType>([
  "branch.push_failed",
  "branch.pushed",
  "feature.pr_failed",
  "feature.pr_updated",
  "incident.recorded",
  "run.merge_level_changed",
  "merge.preflight",
  "feature.auto_merge_disabled",
  "feature.post_merge_ci",
  "feature.reverted",
  "headless.preflight",
  "headless.ended",
  "lookback.rolled_back",
  "upstream.issue_opened",
  "upstream.issue_updated",
  "upstream.issue_closed",
  "upstream.pr_opened",
  "upstream.pr_closed",
  "automation.skipped",
]);

export type NoticeType =
  | "branch.push_failed"
  | "feature.pr_failed"
  | "incident.recorded"
  | "run.merge_level_changed"
  | "merge.preflight"
  | "feature.auto_merge_disabled"
  | "feature.post_merge_ci"
  | "feature.reverted"
  | "headless.preflight"
  | "headless.ended"
  | "lookback.rolled_back"
  | "upstream.issue_opened"
  | "upstream.issue_updated"
  | "upstream.issue_closed"
  | "upstream.pr_opened"
  | "upstream.pr_closed"
  | "automation.skipped";

export interface RunNotice {
  readonly seq: number;
  readonly at: string;
  readonly type: NoticeType;
  readonly tone: Tone;
  readonly title: string;
  /** What the engine recorded (redacted by the engine). */
  readonly detail: string;
  /** What it means for the run. */
  readonly note: string | null;
  readonly feature?: string;
  readonly evidence: readonly string[];
  /** A later push or PR update succeeded for the same feature. */
  readonly resolved: boolean;
  /** How many times the engine recorded this same notice (1 unless folded). */
  readonly repeats: number;
  /** An issue or PR VTC opened (http(s) only). */
  readonly link?: { readonly href: string; readonly label: string };
}

const INCIDENT_TITLES: Readonly<Record<IncidentKind, string>> = {
  crash: "Incident: crash",
  kill: "Incident: kill",
  limit: "Incident: usage limit",
  gate_infra: "Incident: gate infrastructure",
  log_corruption: "Incident: log corruption",
  stale_lock: "Incident: stale lock",
  config_changed: "Config changed during the run",
  checkout_write: "Unexplained write in the checkout",
  host_config_restored: "Host config in a worktree was restored",
  unsandboxed_gate: "Gates ran without an OS sandbox",
  run_adopted: "Run adopted from another clone",
  milestone_commit: "Milestone commit of .vtc/ did not go through",
  auth: "A host is not signed in",
  prompt_selection: "A pinned or canary prompt was not used",
};

const MERGE_REASONS: Readonly<Record<EventData<"run.merge_level_changed">["reason"], string>> = {
  revert: "A merged task was reverted.",
  post_merge_ci_failure: "CI failed after a merge.",
  human: "Changed by the human.",
  no_remote: "This repository has no push remote.",
};

type NoticeBody = Omit<
  RunNotice,
  "seq" | "at" | "type" | "feature" | "resolved" | "evidence" | "repeats" | "link"
> &
  Partial<Pick<RunNotice, "evidence" | "link">>;

/** Incident kinds that are a heads-up, not a failure: the run carries on as configured. */
const WARN_INCIDENTS: ReadonlySet<IncidentKind> = new Set<IncidentKind>([
  "config_changed",
  "prompt_selection",
]);

const INCIDENT_NOTES: Readonly<Partial<Record<IncidentKind, string>>> = {
  config_changed:
    "The run keeps the config it started with; the new config applies to the next run.",
  prompt_selection:
    "The compiled default prompt ran instead. A target whose agent carries its own editable section cannot take a pin until its role is switched to the task pack; vtc lookback pin and approve warn about this.",
};

const DOWNGRADE_NOTE =
  "The merge level drops one step and an escaped defect goes to Lookback; only a human restores the level (vtc merge-level restore).";

/** Notices of the wave-3 events (contracts 4.5.0); `null` for one that needs no attention. */
const wave3Body = (event: VtcEvent): NoticeBody | null => {
  const preflight = eventData(event, "merge.preflight");
  if (preflight !== null) {
    if (preflight.ok) return null;
    return {
      tone: "warn",
      title: `Level ${String(preflight.configured_level)} is not available: this run merges at Level ${String(preflight.effective_level)}`,
      detail: [
        ...preflight.failed.map((f) => PREFLIGHT_FIXES[f]),
        ...(preflight.detail === undefined ? [] : [preflight.detail]),
      ].join(" "),
      note: "VTC never changes repository settings; configure these, and the next run checks again.",
    };
  }
  const disabled = eventData(event, "feature.auto_merge_disabled");
  if (disabled !== null) {
    return {
      tone: "warn",
      title: "Auto-merge turned off",
      detail: disabled.detail,
      note: `Why: ${AUTO_MERGE_DISABLED[disabled.reason]}.`,
    };
  }
  const ci = eventData(event, "feature.post_merge_ci");
  if (ci !== null) {
    if (ci.status !== "red") return null;
    const failed = ci.runs.filter((r) => r.required && r.conclusion === "failure");
    return {
      tone: "danger",
      title: "Base CI failed after the merge",
      detail:
        failed.length === 0
          ? `Merge commit ${ci.merge_commit.slice(0, 8)}`
          : `Failed required runs: ${failed.map((r) => r.name).join(", ")}`,
      note: DOWNGRADE_NOTE,
    };
  }
  const reverted = eventData(event, "feature.reverted");
  if (reverted !== null) {
    return {
      tone: "danger",
      title: "The feature's merge was reverted",
      detail: reverted.detail,
      note: DOWNGRADE_NOTE,
    };
  }
  const headless = eventData(event, "headless.preflight");
  if (headless !== null) {
    if (headless.ok || headless.failed === undefined) return null;
    const purpose = PREFLIGHT_PURPOSES[headless.purpose];
    return {
      tone: headless.failed === "auth" ? "danger" : "warn",
      title: `${purpose.charAt(0).toUpperCase()}${purpose.slice(1)} on ${headless.host} did not start`,
      detail: `Failed check: ${PREFLIGHT_CHECKS[headless.failed]}.${headless.detail === undefined ? "" : ` ${headless.detail}`}`,
      note:
        headless.failed === "auth"
          ? "The steps park with an incident; the engine never retries a login failure. Log in with the host's own command."
          : "The steps wait; the engine checks again before the next start.",
    };
  }
  const ended = eventData(event, "headless.ended");
  if (ended !== null) {
    if (ended.outcome === "done") return null;
    const meta = headlessOutcomeMeta(ended);
    return {
      tone: meta.tone,
      title: `Headless ${event.role ?? "role"} run ${ended.action_id} ended: ${meta.label}`,
      detail: `Ran ${formatGateDuration(ended.duration_ms)}${
        ended.exit_code === null ? "" : `, exit ${String(ended.exit_code)}`
      }.`,
      note:
        ended.outcome === "limit"
          ? "The step waits for the limit to reset (§6.9)."
          : ended.outcome === "auth"
            ? "The steps park; the engine never retries a login failure."
            : null,
    };
  }
  const rolled = eventData(event, "lookback.rolled_back");
  if (rolled !== null) {
    return {
      tone: "warn",
      title: `Prompt canary rolled back for ${rolled.target_role} on ${rolled.target_host}`,
      detail: rolled.reason,
      note: "The baseline prompt runs again; only a human promotes a version (vtc lookback approve).",
    };
  }
  return null;
};

const UPSTREAM_NOTE =
  "Only VTC-side data went to VTC's own repo: no project code, paths, names or secrets (D-by).";

const ISSUE_UPDATES: Readonly<Record<EventData<"upstream.issue_updated">["action"], string>> = {
  commented: "commented on",
  reopened: "reopened",
  edited: "updated",
};

const ISSUE_CLOSES: Readonly<Record<EventData<"upstream.issue_closed">["reason"], string>> = {
  quiet: `Not seen again for ${String(AUTOMATION_LIMITS.autoCloseQuietDays)} days.`,
  completed: "Its fix was merged.",
};

const PR_CLOSES: Readonly<Record<EventData<"upstream.pr_closed">["reason"], string>> = {
  superseded: "A newer proposal replaced it.",
  issue_closed: "Its issue was closed.",
  stale: "It went stale without a review.",
};

const issueOrPr = (
  data: { target: AutoTargetRef; kind: AutoKind; number: number; url: string },
  what: "issue" | "PR",
): Pick<NoticeBody, "link" | "note"> & { readonly where: string; readonly kind: string } => {
  const href = webUrl(data.url);
  return {
    where: `${what} #${String(data.number)} in ${data.target.repo}`,
    kind: AUTO_KIND_LABELS[data.kind],
    note: data.target.kind === "upstream" ? UPSTREAM_NOTE : null,
    ...(href === null
      ? {}
      : { link: { href, label: `${what === "issue" ? "Issue" : "PR"} #${String(data.number)}` } }),
  };
};

/** Notices of the automation events (contracts 5.0.0, D-ca); `null` for other events. */
const automationBody = (event: VtcEvent): NoticeBody | null => {
  const opened = eventData(event, "upstream.issue_opened");
  if (opened !== null) {
    const { where, kind, ...rest } = issueOrPr(opened, "issue");
    return {
      tone: "accent",
      title: `VTC opened ${where}`,
      detail:
        opened.regression_of === undefined
          ? kind
          : `${kind} · regression of #${String(opened.regression_of)}`,
      ...rest,
    };
  }
  const updated = eventData(event, "upstream.issue_updated");
  if (updated !== null) {
    const { where, kind, ...rest } = issueOrPr(updated, "issue");
    return {
      tone: "neutral",
      title: `VTC ${ISSUE_UPDATES[updated.action]} ${where}`,
      detail: kind,
      ...rest,
    };
  }
  const closed = eventData(event, "upstream.issue_closed");
  if (closed !== null) {
    const { where, kind, ...rest } = issueOrPr(closed, "issue");
    return {
      tone: "neutral",
      title: `VTC closed ${where}`,
      detail: `${kind} · ${ISSUE_CLOSES[closed.reason]}`,
      ...rest,
    };
  }
  const pr = eventData(event, "upstream.pr_opened");
  if (pr !== null) {
    const { where, kind, note, ...rest } = issueOrPr(pr, "PR");
    return {
      tone: "accent",
      title: `VTC opened draft ${where} for review`,
      detail: [
        kind,
        ...(pr.issue === undefined ? [] : [`fixes issue #${String(pr.issue)}`]),
        `evidence ${pr.evidence}`,
      ].join(" · "),
      note: [
        "VTC never merges it: a human reviews and merges it.",
        ...(note === null ? [] : [note]),
      ].join(" "),
      ...rest,
    };
  }
  const prClosed = eventData(event, "upstream.pr_closed");
  if (prClosed !== null) {
    const { where, kind, ...rest } = issueOrPr(prClosed, "PR");
    return {
      tone: "neutral",
      title: `VTC closed ${where}`,
      detail: `${kind} · ${PR_CLOSES[prClosed.reason]}`,
      ...rest,
    };
  }
  const skipped = eventData(event, "automation.skipped");
  if (skipped !== null) {
    return {
      tone: skipped.reason === "duplicate" || skipped.reason === "paused" ? "neutral" : "warn",
      title: `Automatic issue or PR not raised${
        skipped.kind === undefined
          ? ""
          : `: ${AUTO_KIND_LABELS[skipped.kind].charAt(0).toLowerCase()}${AUTO_KIND_LABELS[skipped.kind].slice(1)}`
      }`,
      detail: skipped.detail,
      note: `Why: ${SKIP_REASONS[skipped.reason]}.`,
    };
  }
  return null;
};

const body = (event: VtcEvent): NoticeBody | null => {
  if (isEventOfType(event, "branch.push_failed")) {
    const data = readEventData(event);
    return {
      tone: "danger",
      title: `Push of ${data.branch} failed`,
      detail: data.detail,
      note: "Merged tasks stay merged; the next push retries.",
    };
  }
  if (isEventOfType(event, "feature.pr_failed")) {
    return {
      tone: "danger",
      title: "Pull request update failed",
      detail: readEventData(event).detail,
      note: null,
    };
  }
  if (isEventOfType(event, "incident.recorded")) {
    const data = readEventData(event);
    return {
      tone: WARN_INCIDENTS.has(data.kind) ? "warn" : "danger",
      title: INCIDENT_TITLES[data.kind],
      detail: data.detail,
      note: INCIDENT_NOTES[data.kind] ?? null,
      evidence: data.evidence.map((e) => `${e.type}: ${e.ref}`),
    };
  }
  if (isEventOfType(event, "run.merge_level_changed")) {
    const data = readEventData(event);
    const lowered = data.to < data.from;
    return {
      tone: lowered ? "warn" : "neutral",
      title: `Merge level ${lowered ? "lowered" : "raised"} from ${String(data.from)} to ${String(data.to)}`,
      detail: MERGE_REASONS[data.reason],
      note: data.reason === "no_remote" ? "Tasks reach done once merged locally (Level 1)." : null,
    };
  }
  return wave3Body(event) ?? automationBody(event);
};

/** The notice an event makes, or `null` (other types, or a payload this version cannot read). */
export const noticeForEvent = (event: VtcEvent): RunNotice | null => {
  let made: NoticeBody | null;
  try {
    made = body(event);
  } catch {
    return null;
  }
  if (made === null) return null;
  return {
    seq: event.seq,
    at: event.ts,
    type: event.type as NoticeType,
    ...(event.feature === undefined ? {} : { feature: event.feature }),
    evidence: [],
    resolved: false,
    repeats: 1,
    ...made,
  };
};

/** The success that resolves each failure type (of the same feature). */
const RESOLVED_BY: Readonly<Partial<Record<NoticeType, CoreEventType>>> = {
  "branch.push_failed": "branch.pushed",
  "feature.pr_failed": "feature.pr_updated",
};

/** Whether `later` resolves the failure `failed` made. */
const resolves = (failed: VtcEvent, notice: RunNotice, later: VtcEvent): boolean => {
  if (later.seq <= failed.seq) return false;
  const success = RESOLVED_BY[notice.type];
  if (success !== undefined) return later.type === success && later.feature === notice.feature;
  const ci = eventData(failed, "feature.post_merge_ci");
  if (ci !== null) {
    const next = eventData(later, "feature.post_merge_ci");
    return next?.status === "green" && next.merge_commit === ci.merge_commit;
  }
  const preflight = eventData(failed, "headless.preflight");
  if (preflight !== null) {
    const next = eventData(later, "headless.preflight");
    return next?.ok === true && next.host === preflight.host && next.purpose === preflight.purpose;
  }
  // A later run of the same role that ended `done` resolves a failed one: on the same task, or,
  // for a run with no task (a phase run, a lookback replay), with no task on the same host.
  if (eventData(failed, "headless.ended") !== null) {
    return (
      eventData(later, "headless.ended")?.outcome === "done" &&
      later.role === failed.role &&
      later.task === failed.task &&
      (failed.task !== undefined || later.host === failed.host)
    );
  }
  return false;
};

/**
 * The key of a notice that folds with every other notice of the same key, or `null`: a
 * `prompt_selection` incident is recorded at each dispatch the pin could not reach, and the same
 * automatic action can be skipped again and again for one reason, so the same detail is one
 * notice (the newest) with how often it was recorded.
 */
const foldKey = (event: VtcEvent): string | null => {
  const incident = eventData(event, "incident.recorded");
  if (incident?.kind === "prompt_selection") return `prompt_selection:${incident.detail}`;
  const skipped = eventData(event, "automation.skipped");
  return skipped === null
    ? null
    : `automation.skipped:${skipped.reason}:${skipped.kind ?? ""}:${skipped.detail}`;
};

/**
 * The run's notices, newest first; with `feature`, only that feature's. A failed push or PR
 * update is `resolved` once a later push or PR update of the same feature succeeded.
 */
export const runNotices = (events: readonly VtcEvent[], feature?: string): RunNotice[] => {
  const notices: RunNotice[] = [];
  const folded = new Map<string, number>();
  for (const event of events) {
    if (feature !== undefined && event.feature !== feature) continue;
    const notice = noticeForEvent(event);
    if (notice === null) continue;
    const resolved = events.some((later) => resolves(event, notice, later));
    const key = foldKey(event);
    const at = key === null ? undefined : folded.get(key);
    if (key !== null && at !== undefined) {
      const earlier = notices[at];
      if (earlier !== undefined) {
        notices[at] = { ...notice, resolved, repeats: earlier.repeats + 1 };
        continue;
      }
    }
    if (key !== null) folded.set(key, notices.length);
    notices.push({ ...notice, resolved });
  }
  return notices.sort((a, b) => b.seq - a.seq);
};

/** Upper bound on pages read for one view (`EVENT_PAGE_LIMIT.max` events a page). */
export const MAX_EVENT_PAGES = 50;

export interface RunEventLog {
  /** Oldest first, without Lookback replay trials (reading 177, `withoutReplayTrials`). */
  readonly events: readonly VtcEvent[];
  /**
   * The log is longer than {@link MAX_EVENT_PAGES} pages: the newest events were not read, so
   * the views built from it say so instead of showing a live state as current.
   */
  readonly truncated: boolean;
}

/**
 * Reads the run's whole event log, page by page (`GET /api/runs/:run/events?after=`), leaving
 * out Lookback replay trials, which are not the run's work (spine §5 reading 177).
 */
export const loadRunEvents = async (
  client: { events(run: string, after: number, signal?: AbortSignal): Promise<EventPage> },
  run: string,
  signal?: AbortSignal,
): Promise<RunEventLog> => {
  const events: VtcEvent[] = [];
  let after = 0;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const read = await client.events(run, after, signal);
    events.push(...read.events);
    if (read.next_after === null || read.next_after <= after)
      return { events: withoutReplayTrials(events), truncated: false };
    after = read.next_after;
  }
  return { events: withoutReplayTrials(events), truncated: true };
};
