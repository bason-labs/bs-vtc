/**
 * `codex exec --json` stream → `ParsedStream` / `HostOutcome` (§4.1 `parse_events`, §6.9). Pure.
 * Recorded (spike 1): `thread.started {thread_id}` → `turn.started` → `item.completed {item:
 * agent_message}` → `turn.completed {usage}`; `thread_id` is the `SessionRef`. Usage comes from
 * `codex app-server`. A limit hit (recorded in the owner's session transcript, codex-cli 0.163.0,
 * 2026-10-16, spine §5 reading 260; fixture `exec-usage-limit-clock.synthetic.jsonl`): the turn
 * ends with `error {message, codex_error_info: "usage_limit_exceeded"}`, the message naming the
 * reset as a local clock time ("… or try again at 4:00 PM."), and the `token_count` events before
 * it carry `rate_limits {primary, secondary}` (`used_percent`, `window_minutes`, `resets_at`
 * epoch seconds). The reader takes both, wherever they appear: as `turn.failed`, `error` or the
 * transcript's `task_complete`, top level or wrapped in `{type: "event_msg", payload}`
 * (`limitReset`). Documented: `codexErrorInfo: usageLimitExceeded` (§6.9) and a failure message;
 * `error {message}` events report stream errors. Documented (learn.chatgpt.com/docs/non-interactive-mode,
 * the sample `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":
 * "bash -lc ls","status":"in_progress"}}`): a shell call is a `command_execution` item, seen on
 * `item.started` and again on `item.completed`; its `command` only ever becomes
 * `ParsedStream.commandShapes` (D-cs), once per item id (an item without an id counts on
 * `item.completed` only). Recorded (D-cx, 2026-10-15, `exec-model-refused.jsonl`): a model id the
 * sign-in may not use ends in `error` and `turn.failed` with the API's 400 as JSON text ("The '<id>'
 * model is not supported when using Codex with a ChatGPT account."), before any work; that is
 * `error` with cause `model_refused` and the host's one-line message, and the engine retries the
 * dispatch once without `-m`.
 */
import {
  redactSecrets,
  windowKindFromMinutes,
  type CommandShape,
  type HostOutcome,
  type ParsedStream,
  type SessionRef,
  type SpawnRoleRequest,
  type TokenUsage,
  type UsageWindowKind,
} from "@vtc/shared";
import { shellCallShapes } from "../common/command-shapes.js";
import {
  classifyFailureText,
  hostMessageLine,
  isModelRefusalText,
  resetFromClockText,
  resetFromWaitText,
} from "../common/failure-text.js";
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

/** One window of Codex's `rate_limits` (`primary` or `secondary`). */
interface RateWindow {
  readonly kind: UsageWindowKind;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
}

interface CodexScan {
  readonly threadId: string | null;
  /**
   * The last `rate_limits` the run reported with at least one window (a `token_count` event:
   * `{primary, secondary}`, each `{used_percent, window_minutes, resets_at}`), or null.
   */
  readonly rateLimits: readonly RateWindow[] | null;
  readonly lastMessage: string | null;
  readonly tokens: TokenUsage | null;
  /** The last terminal event: a completed or a failed turn. */
  readonly terminal: "completed" | Failure | null;
  readonly lastError: Failure | null;
  /** The shapes of the run's `command_execution` items, in order (D-cs). */
  readonly commandShapes: readonly CommandShape[];
  /**
   * The run did work: an item other than Codex's own `error` notice (a message, a command, a
   * search), or tokens spent. A model refusal is read only before any (D-cx).
   */
  readonly worked: boolean;
  readonly unrecognized: number;
}

/**
 * `codexErrorInfo` as a lower-cased name without underscores, whether the host sends a string
 * (`usageLimitExceeded`, or `usage_limit_exceeded` as codex-cli 0.163.0 wrote it) or
 * `{Name: {...}}`.
 */
const errorInfo = (value: unknown): string | null => {
  const name =
    typeof value === "string" ? value : isRecord(value) ? Object.keys(value)[0] : undefined;
  return name === undefined ? null : name.toLowerCase().replaceAll("_", "");
};

const rateWindow = (value: unknown): RateWindow | null => {
  if (!isRecord(value)) return null;
  const minutes =
    typeof value.window_minutes === "number" && Number.isInteger(value.window_minutes)
      ? value.window_minutes
      : null;
  const used = value.used_percent;
  return {
    kind: windowKindFromMinutes(minutes),
    usedPercent: typeof used === "number" && Number.isFinite(used) ? used : null,
    resetsAt: epochToIso(value.resets_at),
  };
};

/** The windows of a `rate_limits` object, or null when it has none. */
const rateLimitsOf = (value: unknown): readonly RateWindow[] | null => {
  if (!isRecord(value)) return null;
  const windows = [rateWindow(value.primary), rateWindow(value.secondary)].filter(
    (w): w is RateWindow => w !== null,
  );
  return windows.length === 0 ? null : windows;
};

/** Times within this of each other name the same reset (the host rounds the one it prints). */
const SAME_RESET_MS = 5 * 60_000;

/**
 * Which window a limit hit and when it resets (spine §5 reading 260): the structured
 * `rate_limits` first, when a window is used up (the latest reset among full ones); else the
 * failure's own `resets_at`, else the time the message names (a clock time in the machine's local
 * zone, else a wait), each with the window whose reset it matches. Unknown stays `null` (the
 * engine backs off and re-reads usage).
 */
const limitReset = (
  s: CodexScan,
  failure: Failure,
  endedAt: string | null,
): { readonly window: UsageWindowKind | null; readonly resets_at: string | null } => {
  const windows = s.rateLimits ?? [];
  const full = windows
    .filter((w) => w.usedPercent !== null && w.usedPercent >= 100 && w.resetsAt !== null)
    .sort((a, b) => Date.parse(b.resetsAt ?? "") - Date.parse(a.resetsAt ?? ""))[0];
  if (full !== undefined) return { window: full.kind, resets_at: full.resetsAt };
  const named =
    endedAt === null
      ? null
      : (resetFromClockText(failure.message, endedAt) ??
        resetFromWaitText(failure.message, endedAt));
  const at = failure.resetsAt ?? named;
  if (at === null) return { window: null, resets_at: null };
  const match = windows.find(
    (w) =>
      w.resetsAt !== null && Math.abs(Date.parse(w.resetsAt) - Date.parse(at)) <= SAME_RESET_MS,
  );
  return { window: match?.kind ?? null, resets_at: at };
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
  // Codex counts cached input inside input_tokens (exec-resume.jsonl); TokenUsage keeps the kinds
  // apart (§11). Whether cache_write_input_tokens is also inside input_tokens or on top of it is
  // open (every recording has it at 0): it is counted on top, which can only overcount (§7 note).
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

/** The item events that carry an item (`item.started`, `item.updated`, `item.completed`). */
const ITEM_EVENTS: ReadonlySet<string> = new Set([
  "item.started",
  "item.updated",
  "item.completed",
]);

/**
 * A new `command_execution` item's `command`, once per item id; `undefined` when the event is not
 * one or its item was already counted.
 */
const shellCommand = (
  type: string,
  item: Record<string, unknown>,
  seen: Set<string>,
): { readonly command: unknown } | undefined => {
  if (item.type !== "command_execution") return undefined;
  const id = text(item.id);
  if (id === null) return type === "item.completed" ? { command: item.command } : undefined;
  if (seen.has(id)) return undefined;
  seen.add(id);
  return { command: item.command };
};

const scan = (lines: readonly string[]): CodexScan => {
  const { events, unrecognized: unparsed } = parseJsonLines(lines);
  let unrecognized = unparsed;
  let threadId: string | null = null;
  let rateLimits: readonly RateWindow[] | null = null;
  let lastMessage: string | null = null;
  let tokens: TokenUsage | null = null;
  let terminal: CodexScan["terminal"] = null;
  let lastError: Failure | null = null;
  const commandShapes: CommandShape[] = [];
  const shellCallsSeen = new Set<string>();
  let worked = false;
  for (const line of events) {
    // a session transcript wraps Codex's own events (`{type: "event_msg", payload: {...}}`)
    const event = line.type === "event_msg" && isRecord(line.payload) ? line.payload : line;
    rateLimits = rateLimitsOf(event.rate_limits) ?? rateLimits;
    const item = isRecord(event.item) ? event.item : {};
    if (typeof event.type === "string" && ITEM_EVENTS.has(event.type)) {
      // Codex reports its own warnings as `error` items (the recorded refusal starts with one)
      if (item.type !== "error") worked = true;
      const call = shellCommand(event.type, item, shellCallsSeen);
      if (call !== undefined) commandShapes.push(...shellCallShapes(call.command));
    }
    switch (event.type) {
      case "thread.started":
        threadId = text(event.thread_id) ?? threadId;
        break;
      case "item.completed":
        if (item.type === "agent_message") lastMessage = text(item.text) ?? lastMessage;
        break;
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
      case "task_complete":
        // the session transcript's end of turn: a failed one carries `error` (codex-cli 0.163.0)
        if (isRecord(event.error)) terminal = failureOf(event.error);
        break;
      case "token_count":
        break;
      default:
        if (typeof event.type !== "string") unrecognized += 1;
    }
  }
  if (tokens !== null && tokens.in + tokens.out + tokens.cache_r + tokens.cache_w > 0)
    worked = true;
  return {
    threadId,
    rateLimits,
    lastMessage,
    tokens,
    terminal,
    lastError,
    commandShapes,
    worked,
    unrecognized,
  };
};

const sessionRef = (s: CodexScan): SessionRef | null =>
  s.threadId === null ? null : { host: HOST, id: s.threadId };

/**
 * `endedAt`: when the run ended, known only to the launcher. The message gives the wait as text
 * relative to then; without it (the pure `parseEvents`) the reset stays unknown and the engine
 * re-reads app-server usage. `readsRefusal`: whether the failure may be a model refusal; false
 * for one built from stderr, which `codexOutcomeAfterExit` checks against the requested id itself.
 */
const failureOutcome = (
  s: CodexScan,
  failure: Failure,
  retryable: boolean,
  endedAt: string | null = null,
  readsRefusal = true,
): HostOutcome => {
  const byText = classifyFailureText(failure.message);
  if (failure.info === "usagelimitexceeded" || byText === "limit") {
    const reset = limitReset(s, failure, endedAt);
    return {
      kind: "limit",
      session_ref: sessionRef(s),
      resets_at: reset.resets_at,
      window: reset.window,
      model: null,
      message: failure.message,
      tokens: s.tokens,
      cost_usd: null,
    };
  }
  if (failure.info === "unauthorized" || byText === "auth") {
    return { kind: "auth", message: failure.message };
  }
  if (readsRefusal && !s.worked && isModelRefusalText(failure.message)) {
    return modelRefused(s, failure.message);
  }
  return { kind: "error", message: failure.message, retryable, tokens: s.tokens, cost_usd: null };
};

/**
 * Codex refused the model id the run asked for, before any work (D-cx, spine §5 reading 244):
 * retryable, because the engine dispatches once more without `-m`; the adapter never retries
 * itself. The message is the host's own line (`ModelFallback.detail`).
 */
const modelRefused = (s: CodexScan, text: string): HostOutcome => ({
  kind: "error",
  // the line goes into the event log (AD-18)
  message: hostMessageLine(redactSecrets(text)),
  retryable: true,
  cause: "model_refused",
  tokens: s.tokens,
  cost_usd: null,
});

/** An outcome that decides the run on its own: anything but an error without a cause of its own. */
const decides = (outcome: HostOutcome): boolean =>
  outcome.kind !== "error" || outcome.cause === "model_refused";

const doneOutcome = (s: CodexScan): HostOutcome => ({
  kind: "done",
  session_ref: sessionRef(s),
  // with --output-schema the final agent message is the JSON document (spike 1)
  output: s.lastMessage === null ? null : (parseJsonObject(s.lastMessage) ?? s.lastMessage),
  model: null,
  tokens: s.tokens,
  // a subscription run has no per-call price; the engine prices tokens from `defaultPrices` (H-12)
  cost_usd: null,
});

/** `readsRefusal`: whether a failed turn may read as a model refusal (see `failureOutcome`). */
const outcomeOf = (
  s: CodexScan,
  endedAt: string | null = null,
  readsRefusal = true,
): HostOutcome | null => {
  if (s.terminal === null) return null;
  return s.terminal === "completed"
    ? doneOutcome(s)
    : failureOutcome(s, s.terminal, true, endedAt, readsRefusal);
};

/**
 * The pure reader, which has no request: it reads refusal wording on the stream as a model
 * refusal whatever the run asked for. A finished run's outcome comes from
 * `codexOutcomeAfterExit`, which counts a refusal only when the run asked for a model id.
 */
export const parseCodexEvents = (lines: readonly string[]): ParsedStream => {
  const s = scan(lines);
  return {
    outcome: outcomeOf(s),
    sessionRef: sessionRef(s),
    usage: null,
    retry: null,
    unrecognizedLines: s.unrecognized,
    commandShapes: s.commandShapes,
  };
};

/**
 * The outcome of a finished `codex exec` (AD-25 rules 4–5; Codex exit codes are undocumented, so
 * they never decide): its last turn (a failed turn without a limit or sign-in signal takes the
 * launcher's stop cause); else a limit or sign-in signal in its last `error` event or on stderr;
 * else an `error` saying why the process ended: the launcher's stop (`timeout`, `idle`,
 * `killed`), a kill from outside (`killed`) or a bare exit (`exit_code`). `request`: the run's
 * own request. A refusal is "the host refused the model id the run asked for" (D-cx, spine §5
 * reading 244), so a run that asked for no id (the engine's retry on the host default, or a tier
 * without an id) never reads one: refusal wording on its stream is an ordinary error. A refusal
 * read from stderr, which is free-form, counts only when it also names that id.
 */
export const codexOutcomeAfterExit = (
  lines: readonly string[],
  exit: RunExit,
  request?: Pick<SpawnRoleRequest, "model">,
): HostOutcome => {
  const s = scan(lines);
  const requested = request?.model.model;
  const askedForId = requested !== undefined;
  const outcome = outcomeOf(s, exit.endedAt, askedForId);
  if (outcome !== null) return withStopCause(outcome, exit);
  if (exit.error !== null) return spawnFailure(CODEX_BINARY, exit.error);
  const lastError =
    s.lastError === null ? null : failureOutcome(s, s.lastError, true, exit.endedAt, askedForId);
  if (lastError !== null && decides(lastError)) return lastError;
  if (!s.worked && askedForId && isModelRefusalText(exit.stderrTail, requested)) {
    return modelRefused(s, exit.stderrTail);
  }
  const message = describeExit(CODEX_BINARY, exit, "before the turn finished");
  const byStderr = failureOutcome(
    s,
    { message, info: null, resetsAt: null },
    true,
    exit.endedAt,
    false,
  );
  if (decides(byStderr)) return byStderr;
  return endedWithoutResult(
    s.lastError === null ? message : `${message}; last error: ${s.lastError.message}`,
    exit,
    { tokens: s.tokens, cost_usd: null },
  );
};
