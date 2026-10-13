/**
 * Codex app-server rate limits → `UsageSnapshot` (§6.9). Pure. Recorded shape (spike 1):
 * `account/rateLimits/read` → `result.rateLimits {limitId, limitName, primary, secondary, …}`,
 * each window `{usedPercent (integer), windowDurationMins, resetsAt (epoch s)}`; the
 * `account/rateLimits/updated` notification carries the same object (documented, not yet
 * recorded). Windows are labelled from `windowDurationMins` (300 = five hours, 10080 = weekly),
 * never from primary/secondary; extra fields are ignored; anything missing stays unknown.
 */
import {
  windowKindFromMinutes,
  type UsageSnapshot,
  type UsageWindow,
  type UsageWindowKind,
} from "@vtc/shared";
import { epochToIso, isRecord } from "../common/json.js";

const LABELS: Readonly<Record<Exclude<UsageWindowKind, "other">, string>> = {
  five_hour: "five_hour",
  weekly: "weekly",
};

const usedPct = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, 100);
};

const minutesOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

const windowOf = (value: unknown): UsageWindow | null => {
  if (!isRecord(value)) return null;
  const minutes = minutesOf(value.windowDurationMins);
  const kind = windowKindFromMinutes(minutes);
  return {
    kind,
    label: kind === "other" ? (minutes === null ? "window" : `${String(minutes)}m`) : LABELS[kind],
    window_minutes: minutes,
    used_pct: usedPct(value.usedPercent),
    resets_at: epochToIso(value.resetsAt),
  };
};

/**
 * The snapshot for a `rateLimits` object, or for a `read` result / `updated` params that wrap
 * one. A reading without any window is still a reading: the host answered, the windows are
 * unknown.
 */
export const codexUsageFromRateLimits = (raw: unknown, receivedAt: string): UsageSnapshot => {
  const limits = isRecord(raw) && isRecord(raw.rateLimits) ? raw.rateLimits : raw;
  const record = isRecord(limits) ? limits : {};
  const windows = [windowOf(record.primary), windowOf(record.secondary)].filter(
    (w): w is UsageWindow => w !== null,
  );
  return {
    host: "codex",
    source: "app_server",
    windows,
    model_limits: [],
    updated_at: receivedAt,
  };
};
