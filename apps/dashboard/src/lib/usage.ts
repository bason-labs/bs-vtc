import {
  HOST_IDS,
  remainingPct,
  unknownUsage,
  type HostId,
  type UsageReport,
  type UsageSnapshot,
  type UsageSource,
  type UsageWindow,
  type UsageWindowKind,
} from "@vtc/shared";
import {
  ageTone,
  formatAge,
  formatCountdown,
  formatLocalTime,
  type AgeTone,
  type TimeFormatOptions,
} from "./time";

/**
 * The usage panel (§17, D15; §6.9): one card per host with the 5-hour and weekly windows (used %,
 * remaining %, the local reset time), when the data was last updated, per-model "limit reached"
 * rows, the tasks interrupted by limits and the auto-resume countdown. Missing data is "unknown",
 * never 0%.
 */
export const HOST_NAMES: Readonly<Record<HostId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const SOURCE_TEXT: Readonly<Record<UsageSource, string>> = {
  statusline: "statusline",
  sdk_event: "SDK events",
  app_server: "app-server",
  none: "no source yet",
};

const WINDOW_TITLES: Readonly<Record<Exclude<UsageWindowKind, "other">, string>> = {
  five_hour: "5-hour window",
  weekly: "Weekly",
};

export type UsageTone = "ok" | "warn" | "danger" | "unknown";

export interface UsageWindowModel {
  readonly key: string;
  readonly title: string;
  /** `null` = unknown. */
  readonly usedPct: number | null;
  readonly usedText: string;
  readonly remainingText: string;
  readonly resetText: string;
  readonly tone: UsageTone;
}

export interface UsageCardModel {
  readonly host: HostId;
  readonly name: string;
  readonly sourceText: string;
  readonly updated: { readonly text: string; readonly tone: AgeTone };
  readonly windows: readonly UsageWindowModel[];
  readonly modelLimits: readonly string[];
}

export interface UsagePanelModel {
  readonly cards: readonly UsageCardModel[];
  readonly interrupted: { readonly count: number; readonly tasks: readonly string[] };
  /** `null` when no auto-resume is scheduled. */
  readonly autoResume: string | null;
}

const pct = (value: number): string => `${String(Math.round(value))}%`;

const toneFor = (used: number | null): UsageTone => {
  if (used === null) return "unknown";
  if (used >= 90) return "danger";
  if (used >= 75) return "warn";
  return "ok";
};

const windowModel = (
  key: string,
  title: string,
  window: UsageWindow | undefined,
  now: number,
  options: TimeFormatOptions,
): UsageWindowModel => {
  const resets = window?.resets_at ?? null;
  if (resets !== null && Date.parse(resets) <= now) {
    // The window has reset since this reading, so its used % is no longer known (§17, D15:
    // missing data is "unknown"); showing the old reading would call a reset host blocked.
    return {
      key,
      title,
      usedPct: null,
      usedText: "unknown",
      remainingText: "reset since last reading",
      resetText: `reset at ${formatLocalTime(resets, now, options)}`,
      tone: "unknown",
    };
  }
  const used = window?.used_pct ?? null;
  const left = window === undefined ? null : remainingPct(window);
  return {
    key,
    title,
    usedPct: used,
    usedText: used === null ? "unknown" : `${pct(used)} used`,
    remainingText: left === null ? "unknown" : `${pct(left)} left`,
    resetText:
      resets === null
        ? "reset time unknown"
        : `resets ${formatLocalTime(resets, now, options)} (${formatCountdown(resets, now)})`,
    tone: toneFor(used),
  };
};

const cardModel = (
  snapshot: UsageSnapshot,
  now: number,
  options: TimeFormatOptions,
): UsageCardModel => {
  const byKind = (kind: UsageWindowKind) => snapshot.windows.find((w) => w.kind === kind);
  const name = HOST_NAMES[snapshot.host];
  const tone = ageTone(snapshot.updated_at, now);
  return {
    host: snapshot.host,
    name,
    sourceText:
      snapshot.source === "none" ? SOURCE_TEXT.none : `${name} ${SOURCE_TEXT[snapshot.source]}`,
    updated: {
      text:
        snapshot.updated_at === null
          ? "never updated"
          : `updated ${formatAge(snapshot.updated_at, now)}`,
      tone,
    },
    windows: [
      windowModel("five_hour", WINDOW_TITLES.five_hour, byKind("five_hour"), now, options),
      windowModel("weekly", WINDOW_TITLES.weekly, byKind("weekly"), now, options),
      ...snapshot.windows
        .filter((w) => w.kind === "other")
        .map((w, i) => windowModel(`other-${String(i)}`, w.label, w, now, options)),
    ],
    modelLimits: snapshot.model_limits.map(
      (limit) =>
        `${limit.model}: limit reached, ${
          limit.resets_at === null
            ? "reset time unknown"
            : `resets ${formatLocalTime(limit.resets_at, now, options)}`
        }`,
    ),
  };
};

export const usagePanelModel = (
  report: UsageReport,
  now: number,
  options: TimeFormatOptions = {},
): UsagePanelModel => ({
  cards: HOST_IDS.map((host) =>
    cardModel(report.hosts.find((h) => h.host === host) ?? unknownUsage(host), now, options),
  ),
  interrupted: { count: report.interrupted_tasks.length, tasks: report.interrupted_tasks },
  autoResume:
    report.auto_resume_at === null
      ? null
      : `Auto-resume ${formatLocalTime(report.auto_resume_at, now, options)} (${formatCountdown(report.auto_resume_at, now)})`,
});
