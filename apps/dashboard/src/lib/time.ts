/** Time display for the viewer's own zone (§17: "the local reset time"). Pure; tests pin the zone. */
export interface TimeFormatOptions {
  /** IANA zone; defaults to the viewer's. */
  readonly timeZone?: string;
  /** BCP 47 locale; defaults to the viewer's. */
  readonly locale?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `3h 19m`, `45m`, `2d 4h`, `<1m`. */
export const formatDuration = (ms: number): string => {
  if (ms < MINUTE) return "<1m";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${String(days)}d ${String(hours)}h` : `${String(days)}d`;
  if (hours > 0) return minutes > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(hours)}h`;
  return `${String(minutes)}m`;
};

const dayNumber = (ms: number, timeZone: string | undefined): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(ms);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day")) / DAY;
};

/** `13:00` today, `Sun 00:00` within a week, `2 Nov, 08:30` beyond, in the viewer's zone. */
export const formatLocalTime = (
  iso: string,
  now: number,
  options: TimeFormatOptions = {},
): string => {
  const at = Date.parse(iso);
  const { timeZone, locale } = options;
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  const days = Math.abs(dayNumber(at, timeZone) - dayNumber(now, timeZone));
  if (days === 0) return time;
  if (days < 7) {
    return `${new Intl.DateTimeFormat(locale, { timeZone, weekday: "short" }).format(at)} ${time}`;
  }
  return `${new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" }).format(at)}, ${time}`;
};

/** `in 3h 19m`; `due now` within a minute after the time; `passed` once it is clearly past. */
export const formatCountdown = (iso: string, now: number): string => {
  const left = Date.parse(iso) - now;
  if (left > 0) return `in ${formatDuration(left)}`;
  return left > -MINUTE ? "due now" : "passed";
};

/** How old a reading is: `just now`, `3m ago`, `never`. */
export const formatAge = (iso: string | null, now: number): string => {
  if (iso === null) return "never";
  const age = now - Date.parse(iso);
  return age < MINUTE ? "just now" : `${formatDuration(age)} ago`;
};

export type AgeTone = "fresh" | "stale" | "old" | "never";

/** Freshness of a reading: under 15 minutes is fresh, under 6 hours stale, else old. */
export const ageTone = (iso: string | null, now: number): AgeTone => {
  if (iso === null) return "never";
  const age = now - Date.parse(iso);
  if (age < 15 * MINUTE) return "fresh";
  if (age < 6 * HOUR) return "stale";
  return "old";
};
