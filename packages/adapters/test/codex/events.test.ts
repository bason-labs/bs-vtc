import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromStructuredOutput, HostOutcomeSchema, type HostOutcome } from "@vtc/shared";
import { createCodexAdapter } from "../../src/index.js";
import { codexOutcomeAfterExit } from "../../src/codex/events.js";
import type { RunExit, RunStop } from "../../src/common/headless-run.js";
import { fixtureLines } from "../support/fixtures.js";

const adapter = createCodexAdapter();
const parse = (lines: readonly string[]) => adapter.parseEvents(lines);
const valid = (outcome: HostOutcome | null): HostOutcome => {
  expect(outcome).not.toBeNull();
  return HostOutcomeSchema.parse(outcome);
};
const ENDED_AT = "2026-10-13T08:00:00.000Z";
const exit = (
  code: number | null,
  stderrTail = "",
  signal: string | null = null,
  stop: RunStop | null = null,
): RunExit => ({ code, signal, error: null, stderrTail, endedAt: ENDED_AT, stop });
const IDLE: RunStop = {
  cause: "idle",
  message: "codex printed nothing for 600000 ms (its idle timeout) and was stopped",
};
const lines = (path: string): string[] => fixtureLines(path).filter((l) => l !== "");
const THREAD = "0199a7c2-4b1e-7d30-a5f2-6c8e9d1b3a47";

describe("Codex parseEvents: recorded success (spike 1)", () => {
  const lines = fixtureLines("codex/exec-output-schema-events.jsonl");

  it("thread.started is the SessionRef; turn.completed ends the run as done", () => {
    const parsed = parse(lines);
    expect(parsed.sessionRef).toEqual({ host: "codex", id: "<thread-id>" });
    expect(valid(parsed.outcome)).toMatchObject({
      kind: "done",
      session_ref: { host: "codex", id: "<thread-id>" },
      model: null,
      cost_usd: null,
    });
    expect(parsed.usage).toBeNull();
    expect(parsed.retry).toBeNull();
    expect(parsed.unrecognizedLines).toBe(0);
  });

  it("keeps cached input apart from fresh input (§11)", () => {
    const outcome = parse(lines).outcome;
    expect(outcome?.kind === "done" && outcome.tokens).toEqual({
      in: 25905,
      out: 133,
      cache_r: 0,
      cache_w: 0,
    });
    const cached = parse([
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 50176, cached_input_tokens: 13184, output_tokens: 10 },
      }),
    ]).outcome;
    expect(cached?.kind === "done" && cached.tokens).toEqual({
      in: 36992,
      out: 10,
      cache_r: 13184,
      cache_w: 0,
    });
  });

  it("the final agent message is the structured output, which re-validates as a RoleResult", () => {
    const outcome = valid(parse(lines).outcome);
    if (outcome.kind !== "done") throw new Error("expected done");
    const result = fromStructuredOutput("RoleResult", outcome.output);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ role: "qa", exit: "done", summary: "spike ok" });
  });

  it("has no outcome before the turn ends", () => {
    expect(parse(lines.slice(0, 3)).outcome).toBeNull();
  });
});

describe("Codex parseEvents: recorded headless role runs (live check 2026-10-14, codex-cli 0.162.1)", () => {
  it("a fresh run is done with the RoleResult, which re-validates; cache_write_input_tokens is read", () => {
    const parsed = parse(lines("codex/exec-success.jsonl"));
    const outcome = valid(parsed.outcome);
    expect(outcome).toMatchObject({
      kind: "done",
      session_ref: { host: "codex", id: "<thread-id>" },
      tokens: { in: 23669, out: 83, cache_r: 0, cache_w: 0 },
      cost_usd: null,
    });
    expect(parsed.unrecognizedLines).toBe(0);
    if (outcome.kind !== "done") throw new Error("expected done");
    const result = fromStructuredOutput("RoleResult", outcome.output);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ role: "qa", exit: "done", summary: "live ok" });
  });

  it("a resumed run reloads the prior context: cached input is kept apart (§11; about 2x a fresh call)", () => {
    const outcome = valid(parse(lines("codex/exec-resume.jsonl")).outcome);
    expect(outcome).toMatchObject({
      kind: "done",
      session_ref: { host: "codex", id: "<thread-id>" },
      tokens: { in: 47455 - 23552, out: 166, cache_r: 23552, cache_w: 0 },
    });
    if (outcome.kind !== "done") throw new Error("expected done");
    expect(fromStructuredOutput("RoleResult", outcome.output).success).toBe(true);
  });

  it("counts cache_write_input_tokens (new in the 2026-10-14 stream) as cache writes", () => {
    // Open question (§7 note): every recording has cache_write_input_tokens at 0, so whether it
    // is a subset of input_tokens (like cached_input_tokens) or on top of it is unconfirmed. This
    // pins the current reading, additive, which can only overcount cost against the budget.
    const outcome = parse([
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 400,
          cache_write_input_tokens: 250,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      }),
    ]).outcome;
    expect(outcome?.kind === "done" && outcome.tokens).toEqual({
      in: 600,
      out: 10,
      cache_r: 400,
      cache_w: 250,
    });
  });
});

describe("Codex parseEvents: limits and auth (synthetic, documented shapes, §6.9)", () => {
  it("turn.failed with usageLimitExceeded is a limit; the reset is re-read from app-server", () => {
    const outcome = valid(parse(fixtureLines("codex/exec-usage-limit.synthetic.jsonl")).outcome);
    expect(outcome).toEqual({
      kind: "limit",
      session_ref: { host: "codex", id: THREAD },
      resets_at: null,
      window: null,
      model: null,
      message:
        "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/pricing) or try again in 2 hours 13 minutes.",
      tokens: null,
      cost_usd: null,
    });
  });

  it("accepts codexErrorInfo as an object and a reset time when one is given", () => {
    const outcome = parse([
      JSON.stringify({
        type: "turn.failed",
        error: {
          message: "stopped",
          codexErrorInfo: { UsageLimitExceeded: {} },
          resetsAt: 1791910233,
        },
      }),
    ]).outcome;
    expect(outcome).toMatchObject({ kind: "limit", resets_at: "2026-10-13T16:50:33.000Z" });
  });

  it("turn.failed with unauthorized is auth", () => {
    expect(valid(parse(fixtureLines("codex/exec-auth.synthetic.jsonl")).outcome)).toEqual({
      kind: "auth",
      message: "unexpected status 401 Unauthorized: Your session has expired. Please log in again.",
    });
  });

  it("the recorded logged-out run is auth, from its text alone (H-15, temporary CODEX_HOME)", () => {
    // codex-cli 0.162.1, 2026-10-15: ten `Reconnecting... n/5` errors (WebSocket, then HTTPS),
    // then a 401 with no `codexErrorInfo`; `codex login status` said "Not logged in" (exit 1)
    const recorded = lines("codex/exec-signed-out.jsonl");
    const message =
      "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: <cf-ray>, request id: <request-id>";
    expect(valid(parse(recorded).outcome)).toEqual({ kind: "auth", message });
    expect(codexOutcomeAfterExit(recorded, exit(1))).toEqual({ kind: "auth", message });
    // the reconnect notices alone, before the turn fails, already read as a sign-in problem
    expect(codexOutcomeAfterExit(recorded.slice(0, 4), exit(1)).kind).toBe("auth");
  });

  it("any other failed turn is a retryable error", () => {
    const outcome = parse([
      JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
    ]).outcome;
    expect(outcome).toMatchObject({ kind: "error", retryable: true });
  });
});

describe("Codex limit reset (the owner's first run, codex-cli 0.163.0, spine §5 reading 260)", () => {
  const before = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "Asia/Ho_Chi_Minh";
  });
  afterEach(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });

  it("reads the message's local clock time when the stream has no rate limits", () => {
    const lines = fixtureLines("codex/exec-usage-limit-clock.synthetic.jsonl");
    // ended 15:00 local (+07): "try again at 7:30 PM" is 19:30 local the same day
    expect(valid(codexOutcomeAfterExit(lines, exit(1)))).toMatchObject({
      kind: "limit",
      session_ref: { host: "codex", id: THREAD },
      resets_at: "2026-10-13T12:30:00.000Z",
      window: null,
    });
    // `usage_limit_exceeded` is the structured signal, whatever the wording
    const quiet = [
      JSON.stringify({
        type: "turn.failed",
        error: { message: "stopped", codex_error_info: "usage_limit_exceeded" },
      }),
    ];
    expect(codexOutcomeAfterExit(quiet, exit(1))).toMatchObject({ kind: "limit", resets_at: null });
  });

  it("prefers a used-up window of the structured rate limits, and names it", () => {
    const lines = fixtureLines("codex/session-usage-limit.synthetic.jsonl");
    // the last `rate_limits` without windows (another limit id) does not erase the earlier one
    expect(valid(codexOutcomeAfterExit(lines, exit(1)))).toMatchObject({
      kind: "limit",
      resets_at: "2026-10-13T12:30:02.000Z",
      window: "five_hour",
    });
  });

  it("names the window whose reset the message's time matches when none is used up", () => {
    const limits = JSON.stringify({
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 95.0, window_minutes: 300, resets_at: 1791894602 },
        secondary: { used_percent: 17.0, window_minutes: 10080, resets_at: 1792400400 },
      },
    });
    const lines = [limits, ...fixtureLines("codex/exec-usage-limit-clock.synthetic.jsonl")];
    expect(codexOutcomeAfterExit(lines, exit(1))).toMatchObject({
      kind: "limit",
      resets_at: "2026-10-13T12:30:00.000Z",
      window: "five_hour",
    });
  });
});

describe("Codex outcome after the process exits", () => {
  it("turns the limit message's wait into a reset time counted from when the run ended (§12.1)", () => {
    const lines = fixtureLines("codex/exec-usage-limit.synthetic.jsonl");
    // the pure reader has no clock: the reset stays unknown there
    expect(parse(lines).outcome).toMatchObject({ kind: "limit", resets_at: null });
    expect(codexOutcomeAfterExit(lines, exit(1))).toMatchObject({
      kind: "limit",
      resets_at: "2026-10-13T10:13:00.000Z",
    });
    const noWait = [
      JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }),
    ];
    expect(codexOutcomeAfterExit(noWait, exit(1))).toMatchObject({
      kind: "limit",
      resets_at: null,
    });
  });

  it("an error event decides when no turn ended", () => {
    const lines = fixtureLines("codex/exec-usage-limit.synthetic.jsonl").slice(0, 3);
    expect(codexOutcomeAfterExit(lines, exit(1)).kind).toBe("limit");
  });

  it("stderr decides when the stream says nothing", () => {
    expect(codexOutcomeAfterExit([], exit(1, "Error: Not logged in. Run codex login")).kind).toBe(
      "auth",
    );
    expect(codexOutcomeAfterExit([], exit(1, "boom"))).toEqual({
      kind: "error",
      message: "codex exited 1 before the turn finished: boom",
      retryable: true,
      cause: "exit_code",
      tokens: null,
      cost_usd: null,
    });
  });

  it("a codex that could not start is a non-retryable spawn error", () => {
    const outcome = codexOutcomeAfterExit([], {
      ...exit(null),
      error: new Error("spawn codex ENOENT"),
    });
    expect(valid(outcome)).toMatchObject({ kind: "error", retryable: false, cause: "spawn" });
  });

  it("a run killed from outside is a killed error (recorded 2026-10-14: thread.started, turn.started, then nothing)", () => {
    const killed = lines("codex/exec-killed.jsonl");
    expect(killed.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
      "thread.started",
      "turn.started",
    ]);
    expect(parse(killed).outcome).toBeNull();
    expect(parse(killed).sessionRef).toEqual({ host: "codex", id: "<thread-id>" });
    for (const how of [exit(null, "", "SIGTERM"), exit(143), exit(null, "", "SIGKILL")]) {
      expect(valid(codexOutcomeAfterExit(killed, how))).toMatchObject({
        kind: "error",
        retryable: true,
        cause: "killed",
      });
    }
  });

  it("a run the launcher stopped says why, unless the stream says more (AD-25 rules 4–5)", () => {
    const killed = lines("codex/exec-killed.jsonl");
    expect(valid(codexOutcomeAfterExit(killed, exit(null, "", "SIGINT", IDLE)))).toEqual({
      kind: "error",
      message: `${IDLE.message} before the turn finished`,
      retryable: true,
      cause: "idle",
      tokens: null,
      cost_usd: null,
    });
    // a limit the stream reported stays a limit, with its reset
    expect(
      codexOutcomeAfterExit(
        lines("codex/exec-usage-limit.synthetic.jsonl"),
        exit(null, "", "SIGINT", IDLE),
      ),
    ).toMatchObject({ kind: "limit", resets_at: "2026-10-13T10:13:00.000Z" });
    // a finished turn stays done
    expect(
      codexOutcomeAfterExit(
        lines("codex/exec-output-schema-events.jsonl"),
        exit(null, "", "SIGINT", IDLE),
      ).kind,
    ).toBe("done");
    // a failed turn with no limit or auth signal gets the stop's cause
    const failed = [JSON.stringify({ type: "turn.failed", error: { message: "interrupted" } })];
    expect(codexOutcomeAfterExit(failed, exit(130, "", null, IDLE))).toMatchObject({
      kind: "error",
      cause: "idle",
    });
  });

  it("Codex has no turn cap of its own (§12.1): max_turns never comes from a Codex stream", () => {
    expect(adapter.capabilities.turnCap).toBe(false);
  });
});

/**
 * D-cx (spine §5 reading 244): Codex refuses a model id before any work. Recorded 2026-10-15
 * (codex-cli 0.162.1, a ChatGPT plan, `live:h15 codex-model-refusal`): a warning item about the
 * model's metadata, then `error` and `turn.failed` carrying the API's 400 as JSON text, "The '<id>'
 * model is not supported when using Codex with a ChatGPT account." The engine retries without
 * `-m`, so the adapter only names the cause and never retries itself.
 */
describe("Codex model refusal (D-cx)", () => {
  const refused = lines("codex/exec-model-refused.jsonl");
  const ONE_LINE =
    "The 'vtc-probe-no-such-model' model is not supported when using Codex with a ChatGPT account.";

  it("reads the recorded refusal as error, cause model_refused, retryable, with the host's one-line message", () => {
    expect(valid(parse(refused).outcome)).toEqual({
      kind: "error",
      cause: "model_refused",
      retryable: true,
      message: ONE_LINE,
      tokens: null,
      cost_usd: null,
    });
  });

  const asked = (model?: string) => ({
    model: {
      tier: "mid" as const,
      effort: "medium" as const,
      ...(model === undefined ? {} : { model }),
    },
  });
  const REFUSED_ID = asked("vtc-probe-no-such-model");

  it("reads it the same after the process exits, whatever the exit status or launcher stop", () => {
    expect(codexOutcomeAfterExit(refused, exit(1), REFUSED_ID)).toMatchObject({
      kind: "error",
      cause: "model_refused",
      retryable: true,
      message: ONE_LINE,
    });
    expect(codexOutcomeAfterExit(refused, exit(1, "", null, IDLE), REFUSED_ID)).toMatchObject({
      cause: "model_refused",
    });
    // only the error event, then a bare exit
    const errorOnly = refused.filter((l) => !l.includes('"turn.failed"'));
    expect(codexOutcomeAfterExit(errorOnly, exit(1), REFUSED_ID)).toMatchObject({
      kind: "error",
      cause: "model_refused",
      message: ONE_LINE,
    });
  });

  it("a run that asked for no model id never reads a refusal on its stream: the default refused too is an ordinary error (reading 244)", () => {
    const errorOnly = refused.filter((l) => !l.includes('"turn.failed"'));
    for (const request of [asked(), undefined]) {
      const failed = valid(codexOutcomeAfterExit(refused, exit(1), request));
      expect(failed).toMatchObject({ kind: "error", retryable: true });
      expect(failed.kind === "error" && failed.cause).toBeUndefined();
      // a launcher stop names the cause, as for any failed turn without one of its own
      expect(codexOutcomeAfterExit(refused, exit(1, "", null, IDLE), request)).toMatchObject({
        kind: "error",
        cause: "idle",
      });
      expect(codexOutcomeAfterExit(errorOnly, exit(1), request)).toMatchObject({
        kind: "error",
        retryable: true,
        cause: "exit_code",
      });
    }
  });

  it("reads a refusal printed on stderr when the stream has none and it names the id asked for", () => {
    const stderr = "Error: model 'plan-model-x' is not available on your current plan\n";
    expect(codexOutcomeAfterExit([], exit(1, stderr), asked("plan-model-x"))).toMatchObject({
      kind: "error",
      cause: "model_refused",
      retryable: true,
      message: "Error: model 'plan-model-x' is not available on your current plan",
    });
    // stderr is free-form: a refusal naming another id, or a run that asked for no id, is no
    // refusal of this run's model
    for (const request of [asked("other-model"), asked(), undefined]) {
      const outcome = codexOutcomeAfterExit([], exit(1, stderr), request);
      expect(outcome).toMatchObject({ kind: "error", cause: "exit_code" });
    }
  });

  it("never reads a transient or unrelated failure that mentions a model as a refusal", () => {
    for (const text of [
      "stream error: model is unavailable, try again later",
      "The model is currently overloaded; model is not available right now",
      "error: the model output schema file /tmp/x.json does not exist",
      "MCP server `vtc` failed: Model Context Protocol config file does not exist",
      "model profile 'deep': file /home/u/.codex/profiles/deep.toml does not exist",
      "The 'plan-model-x' model is not supported in this request: unknown parameter",
    ]) {
      const stream = parse([
        JSON.stringify({ type: "thread.started", thread_id: THREAD }),
        JSON.stringify({ type: "turn.failed", error: { message: text } }),
      ]).outcome;
      expect(stream, text).toMatchObject({ kind: "error", retryable: true });
      expect(stream?.kind === "error" && stream.cause, text).toBeUndefined();
      const onStderr = codexOutcomeAfterExit([], exit(1, `${text}\n`), asked("plan-model-x"));
      expect(onStderr, text).toMatchObject({ kind: "error", cause: "exit_code" });
    }
  });

  it("recognises the other wordings a host may use for a refused model", () => {
    for (const text of [
      "The 'plan-model-x' model is not supported when using Codex with a ChatGPT account.",
      "model_not_found: The model `plan-model-x` does not exist or you do not have access to it.",
      "You do not have access to the model plan-model-x.",
      "Model plan-model-x is not available for your plan",
    ]) {
      const outcome = parse([
        JSON.stringify({ type: "thread.started", thread_id: THREAD }),
        JSON.stringify({ type: "turn.failed", error: { message: text } }),
      ]).outcome;
      expect(outcome, text).toMatchObject({ kind: "error", cause: "model_refused" });
    }
  });

  it("is never the cause once the run has done work, or when the text names no refusal", () => {
    const afterWork = parse([
      JSON.stringify({ type: "thread.started", thread_id: THREAD }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "working" },
      }),
      JSON.stringify({
        type: "turn.failed",
        error: {
          message:
            "The 'plan-model-x' model is not supported when using Codex with a ChatGPT account.",
        },
      }),
    ]).outcome;
    expect(afterWork).toMatchObject({ kind: "error" });
    expect(afterWork?.kind === "error" && afterWork.cause).toBeUndefined();
    // the metadata warning alone is not a refusal: an accepted id the CLI does not know prints it
    const warningOnly = codexOutcomeAfterExit(
      [refused[0] ?? "", refused[1] ?? ""],
      exit(1, "Model metadata for `x` not found. Defaulting to fallback metadata"),
    );
    expect(warningOnly).toMatchObject({ kind: "error", cause: "exit_code" });
  });

  it("a limit or a sign-in failure still wins over a refusal wording", () => {
    const limit = parse([
      JSON.stringify({
        type: "turn.failed",
        error: {
          message: "model not available: usage limit reached",
          codexErrorInfo: "usageLimitExceeded",
        },
      }),
    ]).outcome;
    expect(limit?.kind).toBe("limit");
  });
});
