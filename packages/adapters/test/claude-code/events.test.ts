import { describe, expect, it } from "vitest";
import {
  fromStructuredOutput,
  HostOutcomeSchema,
  UsageSnapshotSchema,
  type HostOutcome,
} from "@vtc/shared";
import { createClaudeCodeAdapter } from "../../src/index.js";
import { claudeOutcomeAfterExit } from "../../src/claude-code/events.js";
import { fixtureLines, fixtureText } from "../support/fixtures.js";

const adapter = createClaudeCodeAdapter();
const parse = (lines: readonly string[]) => adapter.parseEvents(lines);
const exit = (code: number | null, stderrTail = "", signal: string | null = null) => ({
  code,
  signal,
  error: null,
  stderrTail,
});
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
      tokens: { in: 5, out: 6, cache_r: 0, cache_w: 0 },
      cost_usd: 0.5,
    });
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

  it("a host that could not start is a non-retryable error", () => {
    const outcome = claudeOutcomeAfterExit([], {
      code: null,
      signal: null,
      error: new Error("spawn claude ENOENT"),
      stderrTail: "",
    });
    expect(outcome).toMatchObject({ kind: "error", retryable: false });
    expect(outcome.kind === "error" && outcome.message).toContain("ENOENT");
  });

  it("a sign-in message on stderr is auth", () => {
    expect(claudeOutcomeAfterExit([INIT], exit(1, "Not logged in · Please run /login")).kind).toBe(
      "auth",
    );
  });

  it("any other exit without a result is a retryable error, never done", () => {
    const outcome = valid(claudeOutcomeAfterExit([INIT], exit(null, "", "SIGTERM")));
    expect(outcome).toMatchObject({ kind: "error", retryable: true });
    expect(claudeOutcomeAfterExit([], exit(0)).kind).toBe("error");
  });
});
