import { describe, expect, it } from "vitest";
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

  it("a run killed from outside is a killed error (synthetic fixture)", () => {
    const killed = lines("codex/exec-killed.synthetic.jsonl");
    expect(parse(killed).outcome).toBeNull();
    expect(parse(killed).sessionRef).toEqual({ host: "codex", id: THREAD });
    for (const how of [exit(null, "", "SIGTERM"), exit(143), exit(null, "", "SIGKILL")]) {
      expect(valid(codexOutcomeAfterExit(killed, how))).toMatchObject({
        kind: "error",
        retryable: true,
        cause: "killed",
      });
    }
  });

  it("a run the launcher stopped says why, unless the stream says more (AD-25 rules 4–5)", () => {
    const killed = lines("codex/exec-killed.synthetic.jsonl");
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
