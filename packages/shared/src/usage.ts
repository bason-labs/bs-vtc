/**
 * Usage snapshot per host (§6.9, §17 usage panel). Missing data is `null` and is shown as
 * "unknown", never as 0%.
 *
 * Ownership (AD-6, AD-12): the engine owns the usage store. Claude usage arrives as a push on
 * the statusline ingest route (body {@link StatuslineIngestSchema}) and from SDK events of runs
 * the engine starts; Codex usage comes from the adapter's managed `codex app-server`
 * (`HostAdapter.watchUsage`).
 */
import { z } from "zod";
import { HostIdSchema, IsoDateTimeSchema, TaskIdSchema } from "./primitives.js";

/** Where the reading came from (§6.9: sanctioned sources only). */
export const UsageSourceSchema = z.enum(["statusline", "sdk_event", "app_server", "none"]);
export type UsageSource = z.infer<typeof UsageSourceSchema>;

/**
 * Which plan window a reading belongs to. The scheduler reserve uses `five_hour`; Lookback is
 * gated on `weekly` (§6.9); the dashboard shows both per host (D15). Never guess from the label.
 */
export const UsageWindowKindSchema = z.enum(["five_hour", "weekly", "other"]);
export type UsageWindowKind = z.infer<typeof UsageWindowKindSchema>;

export const FIVE_HOUR_WINDOW_MINUTES = 300;
export const WEEKLY_WINDOW_MINUTES = 10080;

/** Classifies a window by its duration (Codex `windowDurationMins`, §6.9). */
export const windowKindFromMinutes = (minutes: number | null): UsageWindowKind => {
  if (minutes === FIVE_HOUR_WINDOW_MINUTES) return "five_hour";
  if (minutes === WEEKLY_WINDOW_MINUTES) return "weekly";
  return "other";
};

export const UsageWindowSchema = z.strictObject({
  kind: UsageWindowKindSchema,
  /** Display label, e.g. `five_hour`, `seven_day`, or a Codex `limitName`. */
  label: z.string().min(1).max(64),
  window_minutes: z.int().positive().nullable(),
  used_pct: z.number().min(0).max(100).nullable(),
  resets_at: IsoDateTimeSchema.nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** Per-model limit seen only from rejection events: shown as "limit reached, resets X" (§6.9). */
export const ModelLimitSchema = z.strictObject({
  model: z.string().min(1).max(200),
  resets_at: IsoDateTimeSchema.nullable(),
  observed_at: IsoDateTimeSchema,
});
export type ModelLimit = z.infer<typeof ModelLimitSchema>;

export const UsageSnapshotSchema = z.strictObject({
  host: HostIdSchema,
  source: UsageSourceSchema,
  windows: z.array(UsageWindowSchema).default([]),
  model_limits: z.array(ModelLimitSchema).default([]),
  /** When the data was last updated; `null` = never. */
  updated_at: IsoDateTimeSchema.nullable(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

/**
 * The usage panel (§17): one snapshot per host, plus the tasks `interrupted` by limits and the
 * next auto-resume time. Response of `GET /api/usage`.
 */
export const UsageReportSchema = z.strictObject({
  hosts: z.array(UsageSnapshotSchema),
  interrupted_tasks: z.array(TaskIdSchema).default([]),
  /** When the engine will next try to resume interrupted work; `null` = nothing scheduled. */
  auto_resume_at: IsoDateTimeSchema.nullable(),
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

/** Remaining % of a window, or `null` (unknown) when used % is unknown. */
export const remainingPct = (window: Pick<UsageWindow, "used_pct">): number | null =>
  window.used_pct === null ? null : Math.max(0, 100 - window.used_pct);

/** Snapshot for a host with no data yet: unknown, never 0%. */
export const unknownUsage = (host: z.infer<typeof HostIdSchema>): UsageSnapshot => ({
  host,
  source: "none",
  windows: [],
  model_limits: [],
  updated_at: null,
});

// --------------------------------------------------- Claude statusline ingest

/** One Claude statusline rate-limit window, field names as Claude Code reports them (§6.9). */
export const StatuslineWindowSchema = z.strictObject({
  /** 0–100. */
  used_percentage: z.number().min(0).max(100),
  /** Epoch seconds. */
  resets_at: z.int().nonnegative(),
});
export type StatuslineWindow = z.infer<typeof StatuslineWindowSchema>;

/** Largest accepted ingest body in bytes (AD-5: size-limited). */
export const STATUSLINE_INGEST_MAX_BYTES = 4096;

/**
 * Body of `POST /api/ingest/claude-statusline`. The tee shim (`vtc statusline-tee`) extracts
 * these fields from the statusline JSON on stdin and forwards nothing else (no paths, no
 * transcript). A window Claude did not report is `null` (unknown), never 0.
 */
export const StatuslineIngestSchema = z.strictObject({
  v: z.literal(1),
  session_id: z.string().min(1).max(256).nullable(),
  model: z.string().min(1).max(200).nullable(),
  rate_limits: z.strictObject({
    five_hour: StatuslineWindowSchema.nullable(),
    seven_day: StatuslineWindowSchema.nullable(),
  }),
});
export type StatuslineIngest = z.infer<typeof StatuslineIngestSchema>;

const epochToIso = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** Pure: turns a validated ingest body into the Claude usage snapshot the engine stores. */
export const usageFromStatuslineIngest = (
  body: StatuslineIngest,
  receivedAt: string,
): UsageSnapshot => {
  const window = (
    kind: UsageWindowKind,
    label: string,
    minutes: number,
    value: StatuslineWindow | null,
  ): UsageWindow => ({
    kind,
    label,
    window_minutes: minutes,
    used_pct: value === null ? null : value.used_percentage,
    resets_at: value === null ? null : epochToIso(value.resets_at),
  });
  return {
    host: "claude-code",
    source: "statusline",
    windows: [
      window("five_hour", "five_hour", FIVE_HOUR_WINDOW_MINUTES, body.rate_limits.five_hour),
      window("weekly", "seven_day", WEEKLY_WINDOW_MINUTES, body.rate_limits.seven_day),
    ],
    model_limits: [],
    updated_at: receivedAt,
  };
};
