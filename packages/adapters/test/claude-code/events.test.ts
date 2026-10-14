import { describe, expect, it } from "vitest";
import {
  fromStructuredOutput,
  HostOutcomeSchema,
  UsageSnapshotSchema,
  type HostOutcome,
} from "@vtc/shared";
import { createClaudeCodeAdapter } from "../../src/index.js";
import { claudeOutcomeAfterExit } from "../../src/claude-code/events.js";
import type { RunExit, RunStop } from "../../src/common/headless-run.js";
import { fixtureLines, fixtureText } from "../support/fixtures.js";

const adapter = createClaudeCodeAdapter();
const parse = (lines: readonly string[]) => adapter.parseEvents(lines);
const exit = (
  code: number | null,
  stderrTail = "",
  signal: string | null = null,
  stop: RunStop | null = null,
): RunExit => ({
  code,
  signal,
  error: null,
  stderrTail,
  endedAt: "2026-10-13T08:00:00.000Z",
  stop,
});
const IDLE: RunStop = {
  cause: "idle",
  message: "claude printed nothing for 600000 ms (its idle timeout) and was stopped",
};
const TIMEOUT: RunStop = {
  cause: "timeout",
  message: "claude ran longer than its wall timeout of 3600000 ms and was stopped",
};
const lines = (path: string): string[] => fixtureLines(path).filter((l) => l !== "");
const valid = (outcome: HostOutcome | null): HostOutcome => {
  expect(outcome).not.toBeNull();
  return HostOutcomeSchema.parse(outcome);
};

/** The recorded `--output-format json` result as one stream-json line (same event shape). */
const resultLine = (): string =>
  JSON.stringify(JSON.parse(fixtureText("claude-code/p-json-schema-result.json")));
const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "<session-id>",
  model: "claude-haiku-5-5",
});

describe("Claude parseEvents: recorded success (spike 1)", () => {
  it("reads the pretty-printed --output-format json document as a done outcome", () => {
    const parsed = parse(fixtureLines("claude-code/p-json-schema-result.json"));
    const outcome = valid(parsed.outcome);
    expect(outcome).toMatchObject({
      kind: "done",
      session_ref: { host: "claude-code", id: "<session-id>" },
      model: "claude-haiku-5-5",
      tokens: { in: 2, out: 646, cache_r: 0, cache_w: 29800 },
      cost_usd: 0.0062832,
    });
    expect(parsed.unrecognizedLines).toBe(0);
    expect(parsed.usage).toBeNull();
    expect(parsed.retry).toBeNull();
  });

  it("returns structured_output, which re-validates as a RoleResult", () => {
    const outcome = valid(parse([INIT, resultLine()]).outcome);
    if (outcome.kind !== "done") throw new Error("expected done");
    const result = fromStructuredOutput("RoleResult", outcome.output);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ role: "qa", exit: "done", summary: "spike ok" });
  });

  it("has no outcome until the result event arrives, but already knows the session", () => {
    const parsed = parse([INIT]);
    expect(parsed.outcome).toBeNull();
    expect(parsed.sessionRef).toEqual({ host: "claude-code", id: "<session-id>" });
  });

  it("counts lines that are not host events and never throws on them", () => {
    const parsed = parse([INIT, "not json", "[1,2]", "", '{"no_type":true}', resultLine()]);
    expect(parsed.unrecognizedLines).toBe(3);
    expect(parsed.outcome?.kind).toBe("done");
  });

  it("falls back to the result text when there is no structured_output", () => {
    const outcome = parse([
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"a":1}' }),
    ]).outcome;
    expect(outcome).toMatchObject({ kind: "done", output: { a: 1 }, tokens: null, model: null });
  });
});

describe("Claude parseEvents: limits (synthetic, documented shapes, §6.9)", () => {
  it("a rejected rate_limit_event ends the run as a five-hour limit with its reset time", () => {
    const parsed = parse(fixtureLines("claude-code/stream-limit-rejected.synthetic.jsonl"));
    expect(valid(parsed.outcome)).toEqual({
      kind: "limit",
      session_ref: { host: "claude-code", id: "5f1c2a9e-0d3b-4e7a-9c61-2b8d4f0e7a13" },
      resets_at: "2026-10-15T00:00:00.000Z",
      window: "five_hour",
      model: null,
      message: "Claude AI usage limit reached|1792022400",
      tokens: { in: 3, out: 12, cache_r: 800, cache_w: 1200 },
      cost_usd: 0.0123,
    });
  });

  it("reports the stream's rate-limit reading as sdk_event usage, unknown % unless rejected", () => {
    const parsed = parse(fixtureLines("claude-code/stream-limit-rejected.synthetic.jsonl"));
    const usage = UsageSnapshotSchema.parse(parsed.usage);
    expect(usage).toEqual({
      host: "claude-code",
      source: "sdk_event",
      windows: [
        {
          kind: "five_hour",
          label: "five_hour",
          window_minutes: 300,
          used_pct: 100,
          resets_at: "2026-10-15T00:00:00.000Z",
        },
      ],
      model_limits: [],
      updated_at: null,
    });
    const warning = parse(
      fixtureLines("claude-code/stream-limit-rejected.synthetic.jsonl").slice(0, 2),
    );
    expect(warning.usage?.windows[0]?.used_pct).toBeNull();
    expect(warning.outcome).toBeNull();
  });

  it("a per-model rejection names the model instead of a plan window", () => {
    const outcome = valid(
      parse(fixtureLines("claude-code/stream-model-limit.synthetic.jsonl")).outcome,
    );
    expect(outcome).toMatchObject({
      kind: "limit",
      window: null,
      model: "claude-opus-5-5",
      resets_at: "2026-10-20T00:00:00.000Z",
    });
    expect(parse(fixtureLines("claude-code/stream-model-limit.synthetic.jsonl")).usage).toBeNull();
  });

  it("a per-model rejection in a session of another family names the limited family", () => {
    const lines = fixtureLines("claude-code/stream-model-limit.synthetic.jsonl").map((line) =>
      line.replace("claude-opus-5-5", "claude-sonnet-5"),
    );
    expect(valid(parse(lines).outcome)).toMatchObject({ kind: "limit", model: "opus" });
  });

  it("a rate-limit retry the run recovered from does not make a later error a limit", () => {
    const outcome = parse([
      INIT,
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, error: "rate_limit" }),
      JSON.stringify({ type: "assistant", message: { content: [] }, session_id: "<session-id>" }),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Tool crashed"],
        session_id: "<session-id>",
      }),
    ]).outcome;
    expect(valid(outcome)).toMatchObject({
      kind: "error",
      retryable: true,
      message: "Tool crashed",
    });
  });

  it("an error result right after a rate-limit retry is still a limit", () => {
    const outcome = parse([
      INIT,
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 10, error: "rate_limit" }),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Request failed"],
        session_id: "<session-id>",
      }),
    ]).outcome;
    expect(valid(outcome)).toMatchObject({ kind: "limit", resets_at: null });
  });

  it("api_retry for rate_limit is the latest retry notice; the run has not ended", () => {
    const parsed = parse(fixtureLines("claude-code/stream-api-retry.synthetic.jsonl"));
    expect(parsed.outcome).toBeNull();
    expect(parsed.retry).toEqual({ attempt: 2, reason: "rate_limit", retryAt: null });
  });

  it("a non-zero exit after rate-limit retries is a limit (§6.9 detect)", () => {
    const outcome = claudeOutcomeAfterExit(
      fixtureLines("claude-code/stream-api-retry.synthetic.jsonl"),
      exit(1, "API Error: 429"),
    );
    expect(valid(outcome)).toMatchObject({
      kind: "limit",
      session_ref: { host: "claude-code", id: "5f1c2a9e-0d3b-4e7a-9c61-2b8d4f0e7a13" },
      resets_at: null,
      window: null,
    });
  });

  it("an error result naming a usage limit is a limit even without an SDK event", () => {
    const outcome = parse([
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Claude AI usage limit reached|1792022400",
        session_id: "s-1",
      }),
    ]).outcome;
    expect(outcome).toMatchObject({ kind: "limit", resets_at: "2026-10-15T00:00:00.000Z" });
  });

  it("classifies overloaded retries separately", () => {
    const parsed = parse([
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, error_status: 529 }),
    ]);
    expect(parsed.retry?.reason).toBe("overloaded");
  });
});

describe("Claude parseEvents: auth and errors", () => {
  it("a signed-out result is auth (synthetic)", () => {
    const outcome = valid(parse(fixtureLines("claude-code/stream-auth.synthetic.jsonl")).outcome);
    expect(outcome).toEqual({ kind: "auth", message: "Invalid API key · Please run /login" });
  });

  it("turn and budget caps are non-retryable errors with their spend", () => {
    const outcome = parse([
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        usage: { input_tokens: 5, output_tokens: 6 },
        total_cost_usd: 0.5,
      }),
    ]).outcome;
    expect(valid(outcome)).toEqual({
      kind: "error",
      message: "claude ended with error_max_turns",
      retryable: false,
      cause: "max_turns",
      tokens: { in: 5, out: 6, cache_r: 0, cache_w: 0 },
      cost_usd: 0.5,
    });
    const budget = parse([
      JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true }),
    ]).outcome;
    expect(valid(budget)).toMatchObject({ kind: "error", retryable: false, cause: "budget" });
  });

  it("a run that reached --max-turns is a max_turns error with its spend (synthetic fixture)", () => {
    const outcome = valid(parse(lines("claude-code/stream-max-turns.synthetic.jsonl")).outcome);
    expect(outcome).toEqual({
      kind: "error",
      message: "Reached maximum number of turns (3)",
      retryable: false,
      cause: "max_turns",
      tokens: { in: 120, out: 210, cache_r: 3600, cache_w: 2400 },
      cost_usd: 0.041,
    });
    // the exit code changes nothing: the stream decides (AD-25 rule 5)
    expect(
      claudeOutcomeAfterExit(lines("claude-code/stream-max-turns.synthetic.jsonl"), exit(1)),
    ).toEqual(outcome);
  });

  it("an api_retry for a sign-in, org, hold or billing failure is auth, whatever the result text says (synthetic fixture)", () => {
    const recorded = valid(parse(lines("claude-code/stream-auth-retry.synthetic.jsonl")).outcome);
    expect(recorded).toMatchObject({ kind: "auth" });
    for (const error of [
      "authentication_failed",
      "oauth_org_not_allowed",
      "account_on_hold",
      "billing_error",
    ]) {
      const stream = [
        INIT,
        JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, error }),
        JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "failed" }),
      ];
      expect(valid(parse(stream).outcome)).toEqual({ kind: "auth", message: "failed" });
      // the host gave up without a result: still auth, never a retry loop
      expect(claudeOutcomeAfterExit(stream.slice(0, 2), exit(1)).kind).toBe("auth");
    }
  });

  it("an auth retry the run recovered from says nothing about a later error", () => {
    const outcome = parse([
      INIT,
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, error: "billing_error" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
    ]).outcome;
    expect(outcome).toMatchObject({ kind: "error", retryable: true });
  });

  it("a cap stays a cap even after a rate-limit retry on the way", () => {
    const outcome = parse([
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, error: "rate_limit" }),
      JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true }),
    ]).outcome;
    expect(outcome).toMatchObject({ kind: "error", retryable: false });
  });

  it("an execution error is retryable", () => {
    const outcome = parse([
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
    ]).outcome;
    expect(outcome).toMatchObject({ kind: "error", retryable: true });
  });
});

describe("Claude outcome after the process exits", () => {
  it("the result event decides, whatever the exit code", () => {
    expect(claudeOutcomeAfterExit([INIT, resultLine()], exit(1)).kind).toBe("done");
  });

  it("a host that could not start is a non-retryable spawn error", () => {
    const outcome = claudeOutcomeAfterExit([], {
      ...exit(null),
      error: new Error("spawn claude ENOENT"),
    });
    expect(valid(outcome)).toMatchObject({ kind: "error", retryable: false, cause: "spawn" });
    expect(outcome.kind === "error" && outcome.message).toContain("ENOENT");
  });

  it("a sign-in message on stderr is auth", () => {
    expect(claudeOutcomeAfterExit([INIT], exit(1, "Not logged in · Please run /login")).kind).toBe(
      "auth",
    );
  });

  it("any other exit without a result is a retryable exit_code error, never done", () => {
    expect(valid(claudeOutcomeAfterExit([INIT], exit(1, "boom")))).toEqual({
      kind: "error",
      message: "claude exited 1 without a result: boom",
      retryable: true,
      cause: "exit_code",
      tokens: null,
      cost_usd: null,
    });
    expect(claudeOutcomeAfterExit([], exit(0))).toMatchObject({
      kind: "error",
      cause: "exit_code",
    });
  });

  it("a run killed from outside (SIGTERM, exit 143) is a killed error (synthetic fixture)", () => {
    const killed = lines("claude-code/stream-killed.synthetic.jsonl");
    for (const how of [
      exit(143),
      exit(null, "", "SIGTERM"),
      exit(130),
      exit(null, "", "SIGKILL"),
    ]) {
      expect(valid(claudeOutcomeAfterExit(killed, how))).toMatchObject({
        kind: "error",
        retryable: true,
        cause: "killed",
      });
    }
  });

  it("a run the launcher stopped says why: wall timeout, idle timeout or kill (AD-25 rule 4)", () => {
    const killed = lines("claude-code/stream-killed.synthetic.jsonl");
    expect(valid(claudeOutcomeAfterExit(killed, exit(null, "", "SIGINT", IDLE)))).toEqual({
      kind: "error",
      message: `${IDLE.message} without a result`,
      retryable: true,
      cause: "idle",
      tokens: null,
      cost_usd: null,
    });
    expect(claudeOutcomeAfterExit(killed, exit(130, "", null, TIMEOUT))).toMatchObject({
      cause: "timeout",
    });
  });

  it("what the stream says outranks why the launcher stopped the run (AD-25 rule 5)", () => {
    // the result was in; the host then sat waiting on background work
    expect(claudeOutcomeAfterExit([INIT, resultLine()], exit(null, "", "SIGINT", IDLE)).kind).toBe(
      "done",
    );
    // a rejected rate limit, then silence: a limit with its reset, not an idle error
    expect(
      claudeOutcomeAfterExit(
        lines("claude-code/stream-limit-rejected.synthetic.jsonl").slice(0, 4),
        exit(null, "", "SIGINT", IDLE),
      ),
    ).toMatchObject({ kind: "limit", resets_at: "2026-10-15T00:00:00.000Z" });
    // a cap the run hit keeps its own cause
    expect(
      claudeOutcomeAfterExit(
        lines("claude-code/stream-max-turns.synthetic.jsonl"),
        exit(null, "", "SIGINT", TIMEOUT),
      ),
    ).toMatchObject({ cause: "max_turns" });
    // an error result with no cause of its own (the turn ended on SIGINT) gets the stop's
    const interrupted = claudeOutcomeAfterExit(
      [INIT, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true })],
      exit(130, "", null, TIMEOUT),
    );
    expect(valid(interrupted)).toMatchObject({ kind: "error", retryable: true, cause: "timeout" });
    expect(interrupted.kind === "error" && interrupted.message).toContain(TIMEOUT.message);
  });
});
