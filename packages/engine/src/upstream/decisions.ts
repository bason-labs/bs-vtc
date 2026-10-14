/**
 * Pure decisions of the upstream module (AD-27 rule 4; D-bx; spine §5 reading 208 (3)): the dedupe
 * table over the remote label listing, the caps, and the plans of the quiet sweep and the stale-PR
 * close. Everything is read from `listAutomatic` / `listOpenAutomatic` plus `parseAutoMarker`,
 * never GitHub search; the ledger adds only what the remote cannot tell.
 */
import {
  AUTO_LABELS,
  AUTOMATION_LIMITS,
  type AutoIssueRef,
  type AutoKind,
  type AutoPrRef,
} from "@vtc/shared";
import type { Ledger, LedgerRecord } from "./ledger.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type IssueDecision =
  | { readonly action: "create" }
  /** A closed-as-completed fingerprint came back: a new issue linked `Regression of #of`. */
  | { readonly action: "regression"; readonly of: number }
  /** Refresh the open issue's occurrence table; comment too on a material change. */
  | { readonly action: "update"; readonly number: number; readonly comment: boolean }
  /** VTC's quiet sweep closed it; the same incident is back. */
  | { readonly action: "reopen"; readonly number: number }
  | { readonly action: "skip"; readonly reason: "muted" | "duplicate"; readonly number: number };

const byNumberDesc = (a: AutoIssueRef, b: AutoIssueRef): number => b.number - a.number;

/**
 * The dedupe table (spine §5 reading 208 (3)):
 * - no issue carries the fingerprint → create;
 * - any issue with it is labelled `vtc:muted`, or the latest was closed as not planned by a human
 *   → muted, never raised again;
 * - an open issue → update it (comment only on a material change), at most once per
 *   `commentIntervalHours`, otherwise a duplicate;
 * - the latest closed as completed (or with no reason) → a new regression issue;
 * - the latest closed by VTC's own quiet sweep (the ledger says so) → reopen.
 */
export const decideIssue = (input: {
  readonly fingerprint: string;
  readonly issues: readonly AutoIssueRef[];
  readonly record?: LedgerRecord | undefined;
  readonly now: Date;
  readonly material: boolean;
}): IssueDecision => {
  const matches = input.issues.filter((i) => i.marker?.fp === input.fingerprint).sort(byNumberDesc);
  const muted = matches.find((i) => i.labels.includes(AUTO_LABELS.muted));
  if (muted !== undefined) return { action: "skip", reason: "muted", number: muted.number };
  const open = matches.find((i) => i.state === "open");
  if (open !== undefined) {
    const last = input.record?.lastWriteAt;
    const interval = AUTOMATION_LIMITS.commentIntervalHours * HOUR_MS;
    if (last !== null && last !== undefined && input.now.getTime() - Date.parse(last) < interval) {
      return { action: "skip", reason: "duplicate", number: open.number };
    }
    return { action: "update", number: open.number, comment: input.material };
  }
  const latest = matches[0];
  if (latest === undefined) return { action: "create" };
  if (latest.stateReason === "not_planned") {
    return (input.record?.quietClosed ?? []).includes(latest.number)
      ? { action: "reopen", number: latest.number }
      : { action: "skip", reason: "muted", number: latest.number };
  }
  return { action: "regression", of: latest.number };
};

/**
 * Whether a recurrence is worth a comment (spine §5 reading 208 (2)): a VTC version the issue has
 * not seen, or the occurrence count crossed 10 or 100 since VTC last commented.
 */
export const isMaterialChange = (record: LedgerRecord | undefined, version: string): boolean => {
  if (record === undefined) return true;
  if (!record.versionsAtComment.includes(version)) return true;
  return [10, 100].some((n) => record.countAtComment < n && record.count >= n);
};

/** Start of `now`'s UTC day. */
const utcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** `AUTOMATION_LIMITS.newIssuesPerDay` reached for `repo` today (UTC). */
export const issueCapReached = (ledger: Ledger, repo: string, now: Date): boolean =>
  ledger.issuesOpenedSince(repo, utcDay(now)) >= AUTOMATION_LIMITS.newIssuesPerDay;

export type PrCapDecision =
  | { readonly action: "open"; readonly supersede: readonly AutoPrRef[] }
  | {
      readonly action: "skip";
      readonly reason: "rate_limit" | "duplicate";
      readonly detail: string;
    };

/**
 * The PR caps (D-bx): one open PR per fingerprint, `openPrsPerKind` per kind, and
 * `openLookbackPrsPerRole` Lookback PR per role, kept by superseding the older one (a newer
 * proposal for the same role replaces it).
 */
export const planPrCap = (input: {
  readonly open: readonly AutoPrRef[];
  readonly kind: AutoKind;
  readonly fingerprint: string;
  readonly role?: string;
}): PrCapDecision => {
  const automatic = input.open.filter((p) => p.state === "open" && p.marker !== null);
  if (input.kind === "lookback" && input.role !== undefined) {
    const sameRole = automatic.filter(
      (p) => p.marker?.kind === "lookback" && p.marker.role === input.role,
    );
    const others = automatic.filter((p) => p.marker?.kind === "lookback" && !sameRole.includes(p));
    if (others.length >= AUTOMATION_LIMITS.openPrsPerKind) {
      return { action: "skip", reason: "rate_limit", detail: "3 open automatic lookback PRs" };
    }
    return { action: "open", supersede: sameRole };
  }
  const same = automatic.find((p) => p.marker?.fp === input.fingerprint);
  if (same !== undefined) {
    return { action: "skip", reason: "duplicate", detail: `PR #${String(same.number)} is open` };
  }
  const ofKind = automatic.filter((p) => p.marker?.kind === input.kind).length;
  if (ofKind >= AUTOMATION_LIMITS.openPrsPerKind) {
    return {
      action: "skip",
      reason: "rate_limit",
      detail: `${String(AUTOMATION_LIMITS.openPrsPerKind)} open automatic ${input.kind} PRs`,
    };
  }
  return { action: "open", supersede: [] };
};

/**
 * Open automatic issues to close as quiet (AD-27 rule 4): the fingerprint has not recurred for
 * `autoCloseQuietDays` (the ledger's last occurrence, else the issue's last update), no open PR
 * carries it, it lacks `vtc:keep`, and nobody but VTC commented.
 */
export const planQuietSweep = (input: {
  readonly repo: string;
  readonly issues: readonly AutoIssueRef[];
  readonly openPrs: readonly AutoPrRef[];
  readonly ledger: Ledger;
  readonly now: Date;
}): AutoIssueRef[] => {
  const quietMs = AUTOMATION_LIMITS.autoCloseQuietDays * DAY_MS;
  const prFps = new Set(input.openPrs.flatMap((p) => (p.marker === null ? [] : [p.marker.fp])));
  return input.issues.filter((issue) => {
    if (issue.state !== "open" || issue.marker === null) return false;
    if (issue.labels.includes(AUTO_LABELS.keep) || issue.humanActivity) return false;
    if (prFps.has(issue.marker.fp)) return false;
    const last = input.ledger.record(input.repo, issue.marker.fp)?.lastSeen ?? issue.updatedAt;
    return input.now.getTime() - Date.parse(last) >= quietMs;
  });
};

/** Open automatic PRs whose fingerprint's latest issue is closed (closed with `issue_closed`). */
export const planStalePrs = (input: {
  readonly issues: readonly AutoIssueRef[];
  readonly openPrs: readonly AutoPrRef[];
}): AutoPrRef[] =>
  input.openPrs.filter((pr) => {
    if (pr.marker === null) return false;
    const fp = pr.marker.fp;
    const latest = input.issues.filter((i) => i.marker?.fp === fp).sort(byNumberDesc)[0];
    return latest !== undefined && latest.state === "closed";
  });
