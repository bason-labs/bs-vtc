import { describe, expect, it } from "vitest";
import { fromStructuredOutput, HostOutcomeSchema, type HostOutcome } from "@vtc/shared";
import { createCodexAdapter } from "../../src/index.js";
import { codexOutcomeAfterExit } from "../../src/codex/events.js";
import { fixtureLines } from "../support/fixtures.js";

const adapter = createCodexAdapter();
const parse = (lines: readonly string[]) => adapter.parseEvents(lines);
const valid = (outcome: HostOutcome | null): HostOutcome => {
  expect(outcome).not.toBeNull();
  return HostOutcomeSchema.parse(outcome);
};
const exit = (code: number | null, stderrTail = "") => ({
  code,
  signal: null,
  error: null,
  stderrTail,
});
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

  it("any other failed turn is a retryable error", () => {
    const outcome = parse([
      JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
    ]).outcome;
    expect(outcome).toMatchObject({ kind: "error", retryable: true });
  });
});

describe("Codex outcome after the process exits", () => {
  it("an error event decides when no turn ended", () => {
    const lines = fixtureLines("codex/exec-usage-limit.synthetic.jsonl").slice(0, 3);
    expect(codexOutcomeAfterExit(lines, exit(1)).kind).toBe("limit");
  });

  it("stderr decides when the stream says nothing", () => {
    expect(codexOutcomeAfterExit([], exit(1, "Error: Not logged in. Run codex login")).kind).toBe(
      "auth",
    );
    expect(codexOutcomeAfterExit([], exit(1, "boom"))).toMatchObject({
      kind: "error",
      retryable: true,
    });
  });

  it("a codex that could not start is a non-retryable error", () => {
    const outcome = codexOutcomeAfterExit([], {
      code: null,
      signal: null,
      error: new Error("spawn codex ENOENT"),
      stderrTail: "",
    });
    expect(outcome).toMatchObject({ kind: "error", retryable: false });
  });
});
