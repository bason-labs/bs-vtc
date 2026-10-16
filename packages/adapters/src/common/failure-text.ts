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

/**
 * A host refusing the model id a run asked for (D-cx, spine §5 reading 244). Only wordings that
 * name a refusal of a model for this sign-in, never a model merely near a failure word (a capacity
 * error "model is unavailable, try again", a config file that "does not exist"):
 * - recorded (codex-cli 0.162.1, ChatGPT plan, 2026-10-15, `test/fixtures/codex/exec-model-refused.jsonl`):
 *   "The '<id>' model is not supported when using Codex with a ChatGPT account.";
 * - the API's documented `model_not_found`: "The model `<id>` does not exist or you do not have
 *   access to it.", and "do not have access to the model";
 * - the plan wording D-cx names: "model … not available on/for your plan (or account)".
 * A bare "not found" is not one: Codex prints "Model metadata for `<id>` not found" for ids it
 * accepts too.
 */
const MODEL_REFUSAL_TEXT =
  /\bmodel\b[^\n]{0,120}?\bnot supported when using\b|\bmodel_not_found\b|\bdoes not exist or you do not have access to it\b|\bdo(?:es)? not have access to (?:the )?model\b|\bmodel\b[^\n]{0,120}?\bnot available (?:on|for|to|with|in) (?:your|this) (?:current )?(?:plan|account|subscription|tier)\b/i;

/**
 * Whether `text` says the host refused the requested model (never a limit or a sign-in text). With
 * `modelId` (the id the run asked for), the refusal must also name that id on the same line: what
 * free-form text (stderr) needs, where nothing else ties the words to this run's model.
 */
export const isModelRefusalText = (text: string, modelId?: string): boolean => {
  if (classifyFailureText(text) !== null) return false;
  if (modelId === undefined) return MODEL_REFUSAL_TEXT.test(text);
  return text.split("\n").some((line) => MODEL_REFUSAL_TEXT.test(line) && line.includes(modelId));
};

/** At most this many characters of a host's one-line message (`ModelFallback.detail`). */
const ONE_LINE_CHARS = 300;

/**
 * The host's own one-line message: the `error.message` (or `message`) inside a JSON error body
 * when the text is one (Codex passes the API's 400 through as JSON text), else the first line
 * that names a model refusal, else the first non-empty line; whitespace collapsed and cut to 300
 * characters.
 */
export const hostMessageLine = (text: string): string => {
  let inner: string | null = null;
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body === "object" && body !== null) {
      const record = body as { error?: { message?: unknown }; message?: unknown };
      const message = record.error?.message ?? record.message;
      if (typeof message === "string") inner = message;
    }
  } catch {
    // not JSON
  }
  const lines = (inner ?? text).split("\n").map((line) => line.replace(/\s+/g, " ").trim());
  const line =
    lines.find((l) => MODEL_REFUSAL_TEXT.test(l)) ?? lines.find((l) => l !== "") ?? text.trim();
  return line.length > ONE_LINE_CHARS ? `${line.slice(0, ONE_LINE_CHARS - 1)}…` : line;
};
