/**
 * Claude statusline → VTC ingest body (§6.9; owner: adapters+usage team). Pure. The
 * `vtc statusline-tee` shim (cli) passes the statusline JSON it read on stdin through this and
 * POSTs only the result to the engine: no paths, no transcript, nothing else leaves the shim.
 * Field names follow https://code.claude.com/docs/en/statusline (`rate_limits.five_hour` /
 * `seven_day` with `used_percentage` 0–100 and `resets_at` in epoch seconds).
 */
import { StatuslineIngestSchema, type StatuslineIngest, type StatuslineWindow } from "@vtc/shared";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const window = (value: unknown): StatuslineWindow | null => {
  if (!isRecord(value)) return null;
  const used = value.used_percentage;
  const resets = value.resets_at;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (typeof resets !== "number" || !Number.isInteger(resets) || resets < 0) return null;
  return { used_percentage: used, resets_at: resets };
};

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null;

/**
 * Extracts the ingest body from Claude's statusline JSON. Unknown or malformed values become
 * `null` (unknown, never 0). Returns `null` when the input is not a JSON object.
 */
export const statuslineIngestFromClaude = (raw: unknown): StatuslineIngest | null => {
  if (!isRecord(raw)) return null;
  const limits = isRecord(raw.rate_limits) ? raw.rate_limits : {};
  const model = isRecord(raw.model) ? raw.model.id : undefined;
  return StatuslineIngestSchema.parse({
    v: 1,
    session_id: text(raw.session_id, 256),
    model: text(model, 200),
    rate_limits: { five_hour: window(limits.five_hour), seven_day: window(limits.seven_day) },
  });
};
