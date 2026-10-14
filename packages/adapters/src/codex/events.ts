/**
 * `codex exec --json` stream → `ParsedStream` / `HostOutcome` (§4.1 `parse_events`, §6.9). Pure.
 * Recorded (spike 1): `thread.started {thread_id}` → `turn.started` → `item.completed {item:
 * agent_message}` → `turn.completed {usage}`; `thread_id` is the `SessionRef`. The stream carries
 * no rate-limit data (usage comes from `codex app-server`). Documented, not yet recorded: a limit
 * hit is `turn.failed` with `codexErrorInfo: usageLimitExceeded` (§6.9) and a failure message;
 * `error {message}` events report stream errors.
 */
import type { HostOutcome, ParsedStream, SessionRef, TokenUsage } from "@vtc/shared";
import { classifyFailureText, resetFromWaitText } from "../common/failure-text.js";
import type { RunExit } from "../common/headless-run.js";
import { CODEX_BINARY } from "./command.js";
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
  parseJsonLines,
  parseJsonObject,
  text,
} from "../common/json.js";

const HOST = "codex";

interface Failure {
  readonly message: string;
  /** `codexErrorInfo`, lower-cased (`usagelimitexceeded`, `unauthorized`, …), or null. */
  readonly info: string | null;
  readonly resetsAt: string | null;
}

interface CodexScan {
  readonly threadId: string | null;
  readonly lastMessage: string | null;
  readonly tokens: TokenUsage | null;
  /** The last terminal event: a completed or a failed turn. */
  readonly terminal: "completed" | Failure | null;
  readonly lastError: Failure | null;
  readonly unrecognized: number;
}

/** `codexErrorInfo` as a lower-cased name, whether the host sends a string or `{Name: {...}}`. */
const errorInfo = (value: unknown): string | null => {
  if (typeof value === "string") return value.toLowerCase();
  if (isRecord(value)) return Object.keys(value)[0]?.toLowerCase() ?? null;
  return null;
};

const failureOf = (value: unknown): Failure => {
  const record = isRecord(value) ? value : {};
  return {
    message: text(record.message) ?? "codex reported a failure without a message",
    info: errorInfo(record.codexErrorInfo ?? record.codex_error_info),
    resetsAt: epochToIso(record.resetsAt ?? record.resets_at),
  };
};

const addUsage = (total: TokenUsage | null, usage: unknown): TokenUsage | null => {
  if (!isRecord(usage)) return total;
  const input = count(usage.input_tokens);
  const cached = Math.min(count(usage.cached_input_tokens), input);
  // Codex counts cached input inside input_tokens; TokenUsage keeps the kinds apart (§11)
  const turn: TokenUsage = {
    in: input - cached,
    out: count(usage.output_tokens),
    cache_r: cached,
    cache_w: count(usage.cache_write_input_tokens),
  };
  return total === null
    ? turn
    : {
        in: total.in + turn.in,
        out: total.out + turn.out,
        cache_r: total.cache_r + turn.cache_r,
        cache_w: total.cache_w + turn.cache_w,
      };
};

const scan = (lines: readonly string[]): CodexScan => {
  const { events, unrecognized: unparsed } = parseJsonLines(lines);
  let unrecognized = unparsed;
  let threadId: string | null = null;
  let lastMessage: string | null = null;
  let tokens: TokenUsage | null = null;
  let terminal: CodexScan["terminal"] = null;
  let lastError: Failure | null = null;
  for (const event of events) {
    switch (event.type) {
      case "thread.started":
        threadId = text(event.thread_id) ?? threadId;
        break;
      case "item.completed": {
        const item = isRecord(event.item) ? event.item : {};
        if (item.type === "agent_message") lastMessage = text(item.text) ?? lastMessage;
        break;
      }
      case "turn.completed":
        tokens = addUsage(tokens, event.usage);
        terminal = "completed";
        break;
      case "turn.failed":
        tokens = addUsage(tokens, event.usage);
        terminal = failureOf(event.error);
        break;
      case "error":
        lastError = failureOf(event);
        break;
      default:
        if (typeof event.type !== "string") unrecognized += 1;
    }
  }
  return { threadId, lastMessage, tokens, terminal, lastError, unrecognized };
};

const sessionRef = (s: CodexScan): SessionRef | null =>
  s.threadId === null ? null : { host: HOST, id: s.threadId };

/**
 * `endedAt`: when the run ended, known only to the launcher. The message gives the wait as text
 * relative to then; without it (the pure `parseEvents`) the reset stays unknown and the engine
 * re-reads app-server usage.
 */
const failureOutcome = (
  s: CodexScan,
  failure: Failure,
  retryable: boolean,
  endedAt: string | null = null,
): HostOutcome => {
  const byText = classifyFailureText(failure.message);
  if (failure.info === "usagelimitexceeded" || byText === "limit") {
    return {
      kind: "limit",
      session_ref: sessionRef(s),
      resets_at:
        failure.resetsAt ?? (endedAt === null ? null : resetFromWaitText(failure.message, endedAt)),
      window: null,
      model: null,
      message: failure.message,
      tokens: s.tokens,
      cost_usd: null,
    };
  }
  if (failure.info === "unauthorized" || byText === "auth") {
    return { kind: "auth", message: failure.message };
  }
  return { kind: "error", message: failure.message, retryable, tokens: s.tokens, cost_usd: null };
};

const doneOutcome = (s: CodexScan): HostOutcome => ({
  kind: "done",
  session_ref: sessionRef(s),
  // with --output-schema the final agent message is the JSON document (spike 1)
  output: s.lastMessage === null ? null : (parseJsonObject(s.lastMessage) ?? s.lastMessage),
  model: null,
  tokens: s.tokens,
  // a subscription run has no per-call price; the engine prices tokens at list rates (§11)
  cost_usd: null,
});

const outcomeOf = (s: CodexScan, endedAt: string | null = null): HostOutcome | null => {
  if (s.terminal === null) return null;
  return s.terminal === "completed" ? doneOutcome(s) : failureOutcome(s, s.terminal, true, endedAt);
};

export const parseCodexEvents = (lines: readonly string[]): ParsedStream => {
  const s = scan(lines);
  return {
    outcome: outcomeOf(s),
    sessionRef: sessionRef(s),
    usage: null,
    retry: null,
    unrecognizedLines: s.unrecognized,
  };
};

/**
 * The outcome of a finished `codex exec` (AD-25 rules 4–5; Codex exit codes are undocumented, so
 * they never decide): its last turn (a failed turn without a limit or sign-in signal takes the
 * launcher's stop cause); else a limit or sign-in signal in its last `error` event or on stderr;
 * else an `error` saying why the process ended: the launcher's stop (`timeout`, `idle`,
 * `killed`), a kill from outside (`killed`) or a bare exit (`exit_code`).
 */
export const codexOutcomeAfterExit = (lines: readonly string[], exit: RunExit): HostOutcome => {
  const s = scan(lines);
  const outcome = outcomeOf(s, exit.endedAt);
  if (outcome !== null) return withStopCause(outcome, exit);
  if (exit.error !== null) return spawnFailure(CODEX_BINARY, exit.error);
  const lastError =
    s.lastError === null ? null : failureOutcome(s, s.lastError, true, exit.endedAt);
  if (lastError !== null && lastError.kind !== "error") return lastError;
  const message = describeExit(CODEX_BINARY, exit, "before the turn finished");
  const byStderr = failureOutcome(s, { message, info: null, resetsAt: null }, true, exit.endedAt);
  if (byStderr.kind !== "error") return byStderr;
  return endedWithoutResult(
    s.lastError === null ? message : `${message}; last error: ${s.lastError.message}`,
    exit,
    { tokens: s.tokens, cost_usd: null },
  );
};
