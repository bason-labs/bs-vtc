import {
  LOOKBACK_LIMITS,
  parsePersisted,
  ScorecardIndexSchema,
  ScorecardSchema,
  wilsonInterval,
  type ArtifactContent,
  type CanaryVerdict,
  type ReplayVerdict,
  type Scorecard,
  type ScorecardIndex,
  type ScorecardMetricId,
  type VtcEvent,
} from "@vtc/shared";
import type { z } from "zod";
import { eventData } from "./events";
import type { StatusMeta } from "./states";

/**
 * Lookback (spec §13, spine AD-21): scorecards per prompt version, read through the artifacts
 * route (`.vtc/lookback/scorecards/index.json`, then each `Scorecard`), and the run's `lookback.*`
 * events. Every proportion is shown with n and its 95% Wilson interval, never as a bare
 * percentage; below `LOOKBACK_LIMITS.minScorecardN` a metric is "insufficient data".
 */
export type Read<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const readJson = <S extends z.ZodType>(schema: S, artifact: ArtifactContent): Read<z.infer<S>> => {
  if (artifact.encoding !== "utf8") return { ok: false, problem: "not a text file" };
  let raw: unknown;
  try {
    raw = JSON.parse(artifact.content);
  } catch {
    return { ok: false, problem: "not JSON" };
  }
  const parsed = parsePersisted(schema, raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  return {
    ok: false,
    problem: `${path === "" ? "" : `${path}: `}${issue?.message ?? "does not match its contract"}`,
  };
};

export const readScorecardIndex = (artifact: ArtifactContent): Read<ScorecardIndex> =>
  readJson(ScorecardIndexSchema, artifact);

export const readScorecard = (artifact: ArtifactContent): Read<Scorecard> =>
  readJson(ScorecardSchema, artifact);

// ------------------------------------------------------------------ metrics

type MetricKind = "proportion" | "average_rounds" | "per_100" | "tokens";

export const METRIC_LABELS: Readonly<
  Record<
    ScorecardMetricId,
    { readonly label: string; readonly kind: MetricKind; readonly better: "higher" | "lower" }
  >
> = {
  first_round_gate_pass: { label: "Gates pass in round 1", kind: "proportion", better: "higher" },
  review_pass: { label: "Review passes", kind: "proportion", better: "higher" },
  rounds_to_done: { label: "Rounds to done", kind: "average_rounds", better: "lower" },
  escalations_per_100: { label: "Escalations per 100 tasks", kind: "per_100", better: "lower" },
  cap_hits_per_100: { label: "Cap hits per 100 tasks", kind: "per_100", better: "lower" },
  tokens_per_success: { label: "Tokens per success", kind: "tokens", better: "lower" },
};

export interface MetricRow {
  readonly id: ScorecardMetricId;
  readonly label: string;
  readonly better: "higher" | "lower";
  readonly value: string;
  /** `95% CI 40–81%` for proportions; `null` otherwise or when the data is insufficient. */
  readonly interval: string | null;
  readonly n: string;
  readonly insufficient: boolean;
}

type MetricValue = NonNullable<Scorecard["metrics"][ScorecardMetricId]>;

const pct = (x: number): string => `${String(Math.round(x * 100))}%`;

const valueText = (kind: MetricKind, value: number): string => {
  switch (kind) {
    case "proportion":
      return pct(value);
    case "average_rounds":
      return `${String(Math.round(value * 10) / 10)} rounds`;
    case "per_100":
      return `${String(Math.round(value * 10) / 10)} per 100 tasks`;
    case "tokens":
      return `${Math.round(value).toLocaleString("en-US")} tokens`;
  }
};

const intervalText = (m: MetricValue & { value: number }): string => {
  const { low, high } =
    m.ci_low !== null && m.ci_high !== null
      ? { low: m.ci_low, high: m.ci_high }
      : wilsonInterval(Math.round(Math.min(1, Math.max(0, m.value)) * m.n), m.n);
  return `95% CI ${String(Math.round(low * 100))}–${pct(high)}`;
};

/** One row per metric the scorecard has, in contract order. */
export const metricRows = (metrics: Scorecard["metrics"]): MetricRow[] =>
  (Object.keys(METRIC_LABELS) as ScorecardMetricId[]).flatMap((id): MetricRow[] => {
    const m = metrics[id];
    if (m === undefined) return [];
    const meta = METRIC_LABELS[id];
    const min = LOOKBACK_LIMITS.minScorecardN;
    if (m.value === null || m.n < min) {
      return [
        {
          id,
          label: meta.label,
          better: meta.better,
          value: "insufficient data",
          interval: null,
          n: `n = ${String(m.n)} (needs ${String(min)})`,
          insufficient: true,
        },
      ];
    }
    const value = m.value;
    return [
      {
        id,
        label: meta.label,
        better: meta.better,
        value: valueText(meta.kind, value),
        interval: meta.kind === "proportion" ? intervalText({ ...m, value }) : null,
        n: `n = ${String(m.n)}`,
        insufficient: false,
      },
    ];
  });

// ------------------------------------------------------------------ index

export interface ScorecardVersion {
  readonly path: string;
  /** First 8 hex of the effective prompt SHA, as the scorecard path names it. */
  readonly version: string;
  readonly editable: string;
  readonly writtenAt: string;
  /** The newest scorecard of its role and host. */
  readonly latest: boolean;
}

export interface ScorecardGroup {
  readonly key: string;
  readonly title: string;
  readonly versions: readonly ScorecardVersion[];
}

/** The index grouped by role (and mode) and host, newest scorecard first in each group. */
export const groupScorecards = (index: ScorecardIndex): ScorecardGroup[] => {
  const groups = new Map<string, { title: string; entries: ScorecardIndex["scorecards"] }>();
  for (const entry of index.scorecards) {
    const p = entry.prompt;
    const role = p.mode === undefined ? p.role : `${p.role} (${p.mode})`;
    const key = `${role}|${p.host}`;
    const group = groups.get(key) ?? { title: `${role} · ${p.host}`, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, g]) => ({
      key,
      title: g.title,
      versions: [...g.entries]
        .sort((a, b) => b.written_at.localeCompare(a.written_at))
        .map((e, i) => ({
          path: e.path,
          version: e.prompt.effective_sha256.slice(0, 8),
          editable: e.prompt.editable_sha256.slice(0, 8),
          writtenAt: e.written_at,
          latest: i === 0,
        })),
    }));
};

// ------------------------------------------------------------------ events

const REPLAY: Readonly<Record<ReplayVerdict, StatusMeta>> = {
  improve: { label: "improves; a human approves before any canary", tone: "ok" },
  regress: { label: "regresses", tone: "danger" },
  no_change: { label: "no change", tone: "neutral" },
  inconclusive: { label: "inconclusive, not an improvement", tone: "warn" },
};

const CANARY: Readonly<Record<CanaryVerdict, StatusMeta>> = {
  no_data: { label: "Not enough dispatches yet", tone: "neutral" },
  continue: { label: "Running, no trigger", tone: "accent" },
  rollback: { label: "Rollback", tone: "danger" },
  promotable: { label: "Promotable; a human approves", tone: "ok" },
};

export interface CanaryView {
  readonly target: string;
  readonly verdict: StatusMeta;
  readonly reason: string;
  readonly arms: readonly string[];
  readonly at: string;
}

export interface LookbackItem {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly tone: StatusMeta["tone"];
  readonly title: string;
  readonly detail: string | null;
  /** An artifact to open (proposal, replay result). */
  readonly path: string | null;
}

const target = (role: string, mode: string | undefined, host: string): string =>
  `${mode === undefined ? role : `${role} (${mode})`} · ${host}`;

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const armText = (
  name: string,
  sha: string,
  a: { dispatches: number; escalations: number; cap_hits: number; tokens: number },
): string =>
  `${name} ${sha.slice(0, 8)}: ${plural(a.dispatches, "dispatch", "dispatches")}, ${plural(a.escalations, "escalation")}, ${plural(a.cap_hits, "cap hit")}, ${
    a.dispatches === 0 ? "no" : Math.round(a.tokens / a.dispatches).toLocaleString("en-US")
  } tokens per dispatch`;

const item = (event: VtcEvent): Omit<LookbackItem, "seq" | "at" | "type"> | null => {
  const dispatched = eventData(event, "lookback.dispatched");
  if (dispatched !== null) {
    return {
      tone: "neutral",
      title: `Lookback queued for ${target(dispatched.target_role, dispatched.target_mode, dispatched.target_host)}`,
      detail: plural(dispatched.train_failures, "attributed train failure"),
      path: null,
    };
  }
  const proposal = eventData(event, "lookback.proposal_recorded");
  if (proposal !== null) {
    return {
      tone: "accent",
      title: `Proposal ${proposal.proposal} recorded`,
      detail: `${plural(proposal.changes, "change")} to the editable section`,
      path: proposal.path,
    };
  }
  const replay = eventData(event, "lookback.replay_finished");
  if (replay !== null) {
    const v = REPLAY[replay.verdict];
    return {
      tone: v.tone,
      title: `Replay of ${replay.proposal}: ${v.label}`,
      detail: null,
      path: replay.path,
    };
  }
  const rolled = eventData(event, "lookback.rolled_back");
  if (rolled !== null) {
    return {
      tone: "danger",
      title: `Canary rolled back for ${target(rolled.target_role, rolled.target_mode, rolled.target_host)}`,
      detail: `${rolled.reason} (${rolled.from.slice(0, 8)} → ${rolled.to.slice(0, 8)})`,
      path: null,
    };
  }
  const escaped = eventData(event, "lookback.escaped_defect");
  if (escaped !== null) {
    const what = escaped.kind === "revert" ? "revert" : "post-merge CI failure";
    return {
      tone: "danger",
      title: "Escaped defect recorded for attribution",
      detail: `${what} of ${escaped.merge_commit.slice(0, 8)}${
        escaped.tasks.length === 0 ? "" : `; tasks ${escaped.tasks.join(", ")}`
      }`,
      path: null,
    };
  }
  return null;
};

/** The run's canaries (latest state per target) and its other lookback events, newest first. */
export const lookbackActivity = (
  events: readonly VtcEvent[],
): { readonly canaries: readonly CanaryView[]; readonly items: readonly LookbackItem[] } => {
  const canaries = new Map<string, CanaryView>();
  const items: LookbackItem[] = [];
  for (const event of events) {
    const canary = eventData(event, "lookback.canary_evaluated");
    if (canary !== null) {
      const t = target(canary.role, canary.mode, canary.host);
      canaries.set(t, {
        target: t,
        verdict: CANARY[canary.verdict],
        reason: canary.reason,
        arms: [
          armText("candidate", canary.candidate, canary.arms.candidate),
          armText("baseline", canary.baseline, canary.arms.baseline),
        ],
        at: event.ts,
      });
      continue;
    }
    const made = item(event);
    if (made !== null) items.push({ seq: event.seq, at: event.ts, type: event.type, ...made });
  }
  return { canaries: [...canaries.values()], items: items.sort((a, b) => b.seq - a.seq) };
};
