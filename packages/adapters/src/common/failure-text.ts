/**
 * Classifies a host's failure text when the stream carries no structured signal (§6.9 detect
 * step). Structured signals (Claude `rate_limit_event` rejected, Codex `usageLimitExceeded`) win;
 * these patterns are the fallback for error results, `turn.failed` messages and stderr.
 */

const LIMIT_TEXT =
  /usage limit|rate[ _-]?limit|limit reached|hit your (usage )?limit|reached your .*limit|quota exceeded|too many requests|\b429\b/i;

const AUTH_TEXT =
  /not logged in|log ?in again|please run \/login|invalid api key|unauthori[sz]ed|\b401\b|authentication[_ ](error|failed)|oauth token (has )?expired|session has expired|sign in again/i;

export type FailureKind = "limit" | "auth";

/** `limit`, `auth`, or `null` when the text names neither. Limit wins over auth. */
export const classifyFailureText = (text: string): FailureKind | null => {
  if (LIMIT_TEXT.test(text)) return "limit";
  if (AUTH_TEXT.test(text)) return "auth";
  return null;
};

/**
 * A reset time a host put into a limit message as epoch seconds after a `|`
 * (`Claude AI usage limit reached|1792022400`), as ISO, or `null`.
 */
export const resetFromLimitText = (text: string): string | null => {
  const match = /\|\s*(\d{10})\b/.exec(text);
  if (match?.[1] === undefined) return null;
  return new Date(Number(match[1]) * 1000).toISOString();
};

const UNIT_MS: Readonly<Record<string, number>> = {
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1000,
};

/**
 * The reset time a limit message gives as a wait (`try again in 2 hours 13 minutes`, Codex),
 * counted from `endedAt` (when the run ended), as ISO; `null` when the text gives no wait.
 */
export const resetFromWaitText = (text: string, endedAt: string): string | null => {
  const wait =
    /try again in ((?:\s*(?:,|and)?\s*\d+\s*(?:days?|hours?|minutes?|seconds?)\b)+)/i.exec(
      text,
    )?.[1];
  const start = Date.parse(endedAt);
  if (wait === undefined || Number.isNaN(start)) return null;
  let ms = 0;
  for (const part of wait.matchAll(/(\d+)\s*(day|hour|minute|second)s?/gi)) {
    ms += Number(part[1]) * (UNIT_MS[(part[2] ?? "").toLowerCase()] ?? 0);
  }
  return ms === 0 ? null : new Date(start + ms).toISOString();
};
