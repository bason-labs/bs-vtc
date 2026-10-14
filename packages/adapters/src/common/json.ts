/** Small, total readers for host JSON: host formats change, so nothing here throws. */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `map[key]` only when `map` has `key` as its own property: a key read from a host stream
 * (`constructor`, `toString`) never reaches an `Object.prototype` member.
 */
export const ownEntry = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/** One JSON object per line (JSONL), or `null` for a blank, non-JSON or non-object line. */
export const parseJsonObject = (line: string): Record<string, unknown> | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/** The JSON objects in a stream, plus how many non-blank lines were not one. */
export const parseJsonLines = (
  lines: readonly string[],
): { readonly events: Record<string, unknown>[]; readonly unrecognized: number } => {
  const events: Record<string, unknown>[] = [];
  let unrecognized = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const event = parseJsonObject(line);
    if (event === null) unrecognized += 1;
    else events.push(event);
  }
  return { events, unrecognized };
};

export const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** A non-negative integer count, or 0 when the host did not report one. */
export const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

export const nonNegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Epoch time from a host (seconds; values that are clearly milliseconds are accepted too) as an
 * ISO timestamp, or `null` when it is missing or not a plausible time.
 */
export const epochToIso = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1e12 ? value : value * 1000;
  const date = new Date(Math.round(ms));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
