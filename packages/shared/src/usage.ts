/**
 * Usage snapshot per host (§6.9, §17 usage panel). Missing data is `null` and is shown as
 * "unknown", never as 0%.
 */
import { z } from "zod";
import { HostIdSchema, IsoDateTimeSchema } from "./primitives.js";

/** Where the reading came from (§6.9: sanctioned sources only). */
export const UsageSourceSchema = z.enum(["statusline", "sdk_event", "app_server", "none"]);
export type UsageSource = z.infer<typeof UsageSourceSchema>;

export const UsageWindowSchema = z.strictObject({
  /** e.g. `five_hour`, `seven_day`, or a label derived from Codex `windowDurationMins`. */
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
