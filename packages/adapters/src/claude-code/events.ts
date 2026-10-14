/**
 * Claude Code headless stream → `ParsedStream` / `HostOutcome` (§4.1 `parse_events`, §6.9).
 * Pure. Reads `claude -p --output-format stream-json` (one event per line) and also the single
 * document of `--output-format json` (the shape spike 1 recorded). Event shapes:
 * - `result`: `subtype`, `is_error`, `result` text, `structured_output` (with `--json-schema`),
 *   `usage`, `total_cost_usd`, `modelUsage`, `session_id` (recorded, spike 1);
 * - `system/init`: `session_id`, `model`;
 * - `rate_limit_event`: `rate_limit_info {status: allowed|allowed_warning|rejected, resetsAt?,
 *   rateLimitType?, utilization?}` (Agent SDK docs; no recording yet);
 * - `system/api_retry`: `attempt`, `retry_delay_ms`, `error_status`, `error` (`rate_limit`,
 *   `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`,
 *   `billing_error`, …) (Agent SDK and headless docs; no recording yet).
 * Detection (§6.9, AD-25 rule 5: from the stream, never from the exit code alone): a rejected
 * `rate_limit_event`, an unrecovered `api_retry` for `rate_limit`, or an error result whose text
 * names a limit is `limit`; an unrecovered `api_retry` for a sign-in, org, hold or billing failure,
 * or a signed-out error text, is `auth` (the engine parks, never retries in a loop); a result of
 * `error_max_turns` / `error_max_budget_usd` is an `error` with cause `max_turns` / `budget`.
 */
import type {
  HostOutcome,
  ParsedStream,
  SessionRef,
  StreamRetry,
  TokenUsage,
  UsageSnapshot,
  UsageWindow,
  UsageWindowKind,
} from "@vtc/shared";
import { FIVE_HOUR_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES } from "@vtc/shared";
import { classifyFailureText, resetFromLimitText } from "../common/failure-text.js";
import type { RunExit } from "../common/headless-run.js";
import { CLAUDE_BINARY } from "./command.js";
import {
  describeExit,
  endedWithoutResult,
  spawnFailure,
  withStopCause,
} from "../common/outcome.js";
import {
  count,
  epochToIso,
  isRecord,
  nonNegative,
  ownEntry,
  parseJsonLines,
  parseJsonObject,
  text,
} from "../common/json.js";

const HOST = "claude-code";

interface RateLimitInfo {
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly type: string | null;
  readonly resetsAt: string | null;
}

interface ClaudeScan {
  readonly sessionId: string | null;
  readonly model: string | null;
  /** Latest reading per `rateLimitType` (`null` key = untyped). */
  readonly rateLimits: ReadonlyMap<string | null, RateLimitInfo>;
  readonly rejected: RateLimitInfo | null;
  readonly retry: StreamRetry | null;
  /** The last retry was for a rate limit and nothing ran after it: the host gave up waiting. */
  readonly rateLimitRetryUnrecovered: boolean;
  /** The last retry was for a sign-in, org, hold or billing failure and nothing ran after it. */
  readonly authRetryUnrecovered: boolean;
  readonly result: Record<string, unknown> | null;
  readonly unrecognized: number;
}

const rateLimitInfo = (value: unknown): RateLimitInfo | null => {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return null;
  return { status, type: text(value.rateLimitType), resetsAt: epochToIso(value.resetsAt) };
};

/** `api_retry` errors only the user can fix: their login, org access, account or billing. */
const AUTH_RETRY_ERRORS: ReadonlySet<string> = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
]);

const retryReason = (event: Record<string, unknown>): StreamRetry["reason"] => {
  const error = text(event.error) ?? "";
  if (error.includes("rate_limit") || event.error_status === 429) return "rate_limit";
  if (error.includes("overloaded") || event.error_status === 529) return "overloaded";
  return "other";
};

/** The events of a stream; a single pretty-printed `--output-format json` document counts too. */
const eventsOf = (lines: readonly string[]) => {
  const parsed = parseJsonLines(lines);
  if (parsed.events.length > 0 || parsed.unrecognized === 0) return parsed;
  const whole = parseJsonObject(lines.join("\n"));
  return whole === null ? parsed : { events: [whole], unrecognized: 0 };
};

const scan = (lines: readonly string[]): ClaudeScan => {
  const { events, unrecognized: unparsed } = eventsOf(lines);
  let unrecognized = unparsed;
  let sessionId: string | null = null;
  let model: string | null = null;
  const rateLimits = new Map<string | null, RateLimitInfo>();
  let rejected: RateLimitInfo | null = null;
  let retry: StreamRetry | null = null;
  let rateLimitRetryUnrecovered = false;
  let authRetryUnrecovered = false;
  let result: Record<string, unknown> | null = null;
  for (const event of events) {
    const type = text(event.type);
    if (type === null) {
      unrecognized += 1;
      continue;
    }
    sessionId = text(event.session_id) ?? sessionId;
    if (type === "system" && event.subtype === "init") {
      model = text(event.model) ?? model;
    } else if (type === "system" && event.subtype === "api_retry") {
      const reason = retryReason(event);
      rateLimitRetryUnrecovered = reason === "rate_limit";
      authRetryUnrecovered = AUTH_RETRY_ERRORS.has(text(event.error) ?? "");
      retry = {
        attempt: count(event.attempt),
        reason,
        // the event gives a delay, not a time; a pure reader has no clock to add it to
        retryAt: null,
      };
    } else if (type === "rate_limit_event") {
      const info = rateLimitInfo(event.rate_limit_info);
      if (info === null) {
        unrecognized += 1;
        continue;
      }
      rateLimits.set(info.type, info);
      if (info.status === "rejected") rejected = info;
    } else if (type === "result") {
      result = event;
    } else if (type !== "system") {
      // an assistant or tool turn after a retry: the retried request went through
      rateLimitRetryUnrecovered = false;
      authRetryUnrecovered = false;
    }
  }
  return {
    sessionId,
    model,
    rateLimits,
    rejected,
    retry,
    rateLimitRetryUnrecovered,
    authRetryUnrecovered,
    result,
    unrecognized,
  };
};

const sessionRef = (s: ClaudeScan): SessionRef | null =>
  s.sessionId === null ? null : { host: HOST, id: s.sessionId };

const tokensOf = (result: Record<string, unknown>): TokenUsage | null => {
  const usage = result.usage;
  if (!isRecord(usage)) return null;
  return {
    in: count(usage.input_tokens),
    out: count(usage.output_tokens),
    cache_r: count(usage.cache_read_input_tokens),
    cache_w: count(usage.cache_creation_input_tokens),
  };
};

/** The run's model: the init event's, else the costliest `modelUsage` entry. */
const modelOf = (s: ClaudeScan, result: Record<string, unknown>): string | null => {
  if (s.model !== null) return s.model;
  const usage = result.modelUsage;
  if (!isRecord(usage)) return null;
  let best: { name: string; cost: number } | null = null;
  for (const [name, entry] of Object.entries(usage)) {
    const cost = isRecord(entry) ? (nonNegative(entry.costUSD) ?? 0) : 0;
    if (best === null || cost > best.cost) best = { name, cost };
  }
  return best?.name ?? null;
};

/** Plan windows (`five_hour`, `seven_day`) versus per-model limits (`seven_day_opus`, …). */
const WINDOW_KINDS: Readonly<Record<string, { kind: UsageWindowKind; minutes: number }>> = {
  five_hour: { kind: "five_hour", minutes: FIVE_HOUR_WINDOW_MINUTES },
  seven_day: { kind: "weekly", minutes: WEEKLY_WINDOW_MINUTES },
};
const MODEL_LIMIT_TYPE = /^seven_day_([a-z]+)$/;

const limitOutcome = (
  s: ClaudeScan,
  message: string,
  tokens: TokenUsage | null,
  cost: number | null,
): HostOutcome => {
  const hit = s.rejected;
  const type = hit?.type ?? null;
  const family = type === null ? null : (MODEL_LIMIT_TYPE.exec(type)?.[1] ?? null);
  return {
    kind: "limit",
    session_ref: sessionRef(s),
    resets_at: hit?.resetsAt ?? resetFromLimitText(message),
    window: type === null ? null : (ownEntry(WINDOW_KINDS, type)?.kind ?? null),
    // the limited family, or the session's model when it is of that family
    model: family === null ? null : s.model?.includes(family) === true ? s.model : family,
    message,
    tokens,
    cost_usd: cost,
  };
};

const resultMessage = (result: Record<string, unknown>): string => {
  const errors = Array.isArray(result.errors)
    ? result.errors.filter((e): e is string => typeof e === "string")
    : [];
  return (
    text(result.result) ??
    (errors.length > 0 ? errors.join("; ") : null) ??
    `claude ended with ${text(result.subtype) ?? "an error"}`
  );
};

/** Caps the run hit on purpose (`--max-turns`, `--max-budget-usd`): retrying cannot help. */
const CAP_CAUSES: Readonly<Record<string, "max_turns" | "budget">> = {
  error_max_turns: "max_turns",
  error_max_budget_usd: "budget",
};

const outcomeFromResult = (s: ClaudeScan, result: Record<string, unknown>): HostOutcome => {
  const tokens = tokensOf(result);
  const cost = nonNegative(result.total_cost_usd);
  const subtype = text(result.subtype);
  if (result.is_error !== true && subtype === "success") {
    let output: unknown = result.structured_output;
    if (output === undefined) {
      const reply = text(result.result);
      output = reply === null ? null : (parseJsonObject(reply) ?? reply);
    }
    return {
      kind: "done",
      session_ref: sessionRef(s),
      output,
      model: modelOf(s, result),
      tokens,
      cost_usd: cost,
    };
  }
  const message = resultMessage(result);
  const cap = subtype === null ? undefined : ownEntry(CAP_CAUSES, subtype);
  if (cap !== undefined && s.rejected === null) {
    // the run hit its own cap, even if it waited out a rate-limit retry on the way
    return { kind: "error", message, retryable: false, cause: cap, tokens, cost_usd: cost };
  }
  const failure = classifyFailureText(message);
  // a rate-limit retry the run recovered from says nothing about a later, unrelated error
  if (s.rejected !== null || s.rateLimitRetryUnrecovered || failure === "limit") {
    return limitOutcome(s, message, tokens, cost);
  }
  if (s.authRetryUnrecovered || failure === "auth") return { kind: "auth", message };
  return { kind: "error", message, retryable: true, tokens, cost_usd: cost };
};

/** Usage the stream reported (`source: "sdk_event"`), or `null` when it carried none. */
const usageOf = (s: ClaudeScan): UsageSnapshot | null => {
  const windows: UsageWindow[] = [];
  for (const [type, info] of s.rateLimits) {
    const window = type === null ? undefined : ownEntry(WINDOW_KINDS, type);
    if (type === null || window === undefined) continue;
    windows.push({
      kind: window.kind,
      label: type,
      window_minutes: window.minutes,
      // `utilization` has no documented unit, so only a rejection gives a known value
      used_pct: info.status === "rejected" ? 100 : null,
      resets_at: info.resetsAt,
    });
  }
  if (windows.length === 0) return null;
  // a pure reader has no clock: the engine stamps the reading when it merges it
  return { host: HOST, source: "sdk_event", windows, model_limits: [], updated_at: null };
};

export const parseClaudeEvents = (lines: readonly string[]): ParsedStream => {
  const s = scan(lines);
  return {
    outcome: s.result === null ? null : outcomeFromResult(s, s.result),
    sessionRef: sessionRef(s),
    usage: usageOf(s),
    retry: s.retry,
    unrecognizedLines: s.unrecognized,
  };
};

/**
 * The outcome of a finished `claude -p` process (AD-25 rules 4–5). A result event decides it (an
 * error result without a cause of its own takes the launcher's stop cause); without one, an
 * unrecovered rate-limit or sign-in signal in the stream, or a limit or sign-in message on stderr,
 * decides it; otherwise it is an `error` saying why the process ended: the launcher's stop
 * (`timeout`, `idle`, `killed`), a kill from outside (exit 143 after SIGTERM: `killed`), or a bare
 * exit (`exit_code`, §6.9 "non-zero `-p` exit" with no other evidence).
 */
export const claudeOutcomeAfterExit = (lines: readonly string[], exit: RunExit): HostOutcome => {
  const s = scan(lines);
  if (s.result !== null) return withStopCause(outcomeFromResult(s, s.result), exit);
  if (exit.error !== null) return spawnFailure(CLAUDE_BINARY, exit.error);
  const message = describeExit(CLAUDE_BINARY, exit, "without a result");
  const failure = classifyFailureText(exit.stderrTail);
  if (s.rejected !== null || s.rateLimitRetryUnrecovered || failure === "limit") {
    return limitOutcome(s, message, null, null);
  }
  if (s.authRetryUnrecovered || failure === "auth") return { kind: "auth", message };
  return endedWithoutResult(message, exit);
};
