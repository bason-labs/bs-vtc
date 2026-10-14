import {
  isEventOfType,
  readEventData,
  type CoreEventType,
  type EventData,
  type EventPage,
  type IncidentKind,
  type VtcEvent,
} from "@vtc/shared";
import type { Tone } from "./states";

/**
 * Run notices (§6.7, §15 incident reports): events the human must see although nothing is
 * waiting on an answer. A failed push or PR update (`branch.push_failed`, `feature.pr_failed`),
 * an incident (`config_changed`, `checkout_write` and the unclean-end kinds) and a merge-level
 * change (`no_remote`: Level 2+ in a repo without a push remote, spine §5 reading 18). The engine
 * still owns all state: these are read from the run's event log and only explained here.
 */

/** Event types that make a notice, or resolve one (a later push or PR update). */
export const NOTICE_EVENT_TYPES: ReadonlySet<CoreEventType> = new Set<CoreEventType>([
  "branch.push_failed",
  "branch.pushed",
  "feature.pr_failed",
  "feature.pr_updated",
  "incident.recorded",
  "run.merge_level_changed",
]);

export type NoticeType =
  "branch.push_failed" | "feature.pr_failed" | "incident.recorded" | "run.merge_level_changed";

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
};

const MERGE_REASONS: Readonly<Record<EventData<"run.merge_level_changed">["reason"], string>> = {
  revert: "A merged task was reverted.",
  post_merge_ci_failure: "CI failed after a merge.",
  human: "Changed by the human.",
  no_remote: "This repository has no push remote.",
};

type NoticeBody = Omit<RunNotice, "seq" | "at" | "type" | "feature" | "resolved" | "evidence"> &
  Partial<Pick<RunNotice, "evidence">>;

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
      tone: data.kind === "config_changed" ? "warn" : "danger",
      title: INCIDENT_TITLES[data.kind],
      detail: data.detail,
      note:
        data.kind === "config_changed"
          ? "The run keeps the config it started with; the new config applies to the next run."
          : null,
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
  return null;
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
    ...made,
  };
};

/** The success that resolves each failure type. */
const RESOLVED_BY: Readonly<Partial<Record<NoticeType, CoreEventType>>> = {
  "branch.push_failed": "branch.pushed",
  "feature.pr_failed": "feature.pr_updated",
};

/**
 * The run's notices, newest first; with `feature`, only that feature's. A failed push or PR
 * update is `resolved` once a later push or PR update of the same feature succeeded.
 */
export const runNotices = (events: readonly VtcEvent[], feature?: string): RunNotice[] => {
  const notices: RunNotice[] = [];
  for (const event of events) {
    if (feature !== undefined && event.feature !== feature) continue;
    const notice = noticeForEvent(event);
    if (notice === null) continue;
    const success = RESOLVED_BY[notice.type];
    const resolved =
      success !== undefined &&
      events.some((e) => e.type === success && e.feature === notice.feature && e.seq > notice.seq);
    notices.push({ ...notice, resolved });
  }
  return notices.sort((a, b) => b.seq - a.seq);
};

/** Upper bound on pages read for one view (2000 events a page at most). */
const MAX_PAGES = 50;

/** Reads the run's whole event log, page by page (`GET /api/runs/:run/events?after=`). */
export const loadRunEvents = async (
  client: { events(run: string, after: number, signal?: AbortSignal): Promise<EventPage> },
  run: string,
  signal?: AbortSignal,
): Promise<VtcEvent[]> => {
  const events: VtcEvent[] = [];
  let after = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await client.events(run, after, signal);
    events.push(...read.events);
    if (read.next_after === null || read.next_after <= after) break;
    after = read.next_after;
  }
  return events;
};
