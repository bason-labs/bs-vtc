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

/**
 * Recorded headless role runs (live check 2026-10-14, Claude Code 2.1.299): `claude -p
 * --output-format stream-json --verbose --json-schema … --agent vtc:vtc-qa-judge --plugin-dir …`.
 */
describe("Claude parseEvents: recorded headless role runs (2026-10-14)", () => {
  const roleResultOf = (outcome: HostOutcome) => {
    if (outcome.kind !== "done") throw new Error(`expected done, got ${outcome.kind}`);
    return fromStructuredOutput("RoleResult", outcome.output);
  };

  it("a run whose agent has the StructuredOutput tool returns structured_output, which re-validates", () => {
    for (const fixture of [
      "claude-code/stream-success.jsonl",
      "claude-code/stream-resume.jsonl",
      // D-cl: the real compiled plugin, unpatched, run as a replay arm (`--plugin-dir <arm>`)
      "claude-code/stream-arm-success.jsonl",
    ]) {
      const parsed = parse(lines(fixture));
      const outcome = valid(parsed.outcome);
      expect(outcome, fixture).toMatchObject({
        kind: "done",
        session_ref: { host: "claude-code", id: "<session-id>" },
        model: "claude-haiku-5-5",
      });
      const result = roleResultOf(outcome);
      expect(result.success, fixture).toBe(true);
      expect(result.data).toMatchObject({ role: "qa", exit: "done", summary: "live ok" });
      // every line is a host event, the hook and thinking-token system events included
      expect(parsed.unrecognizedLines, fixture).toBe(0);
      expect(claudeOutcomeAfterExit(lines(fixture), exit(0)).kind).toBe("done");
    }
    expect(valid(parse(lines("claude-code/stream-success.jsonl")).outcome)).toMatchObject({
      tokens: { in: 2, out: 625, cache_r: 0, cache_w: 13245 },
      cost_usd: 0.0029617000000000003,
    });
  });

  it("a run whose agent lacks the tool answers in a fenced text, which is never taken as the RoleResult", () => {
    // the bug the live check found: no structured_output; the text is passed on as it is, so the
    // engine's re-validation fails it visibly instead of a guessed parse
    const outcome = valid(parse(lines("claude-code/stream-no-structured-output.jsonl")).outcome);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") return;
    expect(typeof outcome.output).toBe("string");
    expect(String(outcome.output)).toMatch(/^```json\n/u);
    expect(roleResultOf(outcome).success).toBe(false);
  });

  it("--max-turns 1 was not hit in either recording: both runs end done, not max_turns", () => {
    // without StructuredOutput the reply took 1 turn; with it, the closing StructuredOutput call
    // made 2 turns and still ended `success` under --max-turns 1 (no real max-turns stream yet)
    const noTool = valid(parse(lines("claude-code/stream-max-turns-not-hit.jsonl")).outcome);
    expect(noTool.kind).toBe("done");
    const withTool = valid(
      parse(lines("claude-code/stream-max-turns-structured-output.jsonl")).outcome,
    );
    expect(roleResultOf(withTool).success).toBe(true);
    const result = lines("claude-code/stream-max-turns-structured-output.jsonl")
      .map((line) => JSON.parse(line) as { type: string; num_turns?: number })
      .find((event) => event.type === "result");
    expect(result?.num_turns).toBe(2);
  });

  it("reads both plan windows' use and reset times from rate_limit_info.unifiedWindows", () => {
    const usage = UsageSnapshotSchema.parse(parse(lines("claude-code/stream-success.jsonl")).usage);
    expect(usage).toEqual({
      host: "claude-code",
      source: "sdk_event",
      windows: [
        {
          kind: "five_hour",
          label: "five_hour",
          window_minutes: 300,
          // `utilization` 0.32: a 0–1 fraction (H-10, confirmed against `/usage`; see below)
          used_pct: 32,
          resets_at: "2026-10-14T15:40:00.000Z",
        },
        {
          kind: "weekly",
          label: "seven_day",
          window_minutes: 10080,
          used_pct: 5,
          resets_at: "2026-10-19T14:00:00.000Z",
        },
      ],
      model_limits: [],
      updated_at: null,
    });
  });

  it("a unified window without a reset time, or with a malformed one, is skipped or left unknown", () => {
    const event = (unifiedWindows: unknown) =>
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", unifiedWindows },
      });
    expect(parse([event({ seven_day: { utilization: 0.1 } })]).usage?.windows).toEqual([
      {
        kind: "weekly",
        label: "seven_day",
        window_minutes: 10080,
        used_pct: 10,
        resets_at: null,
      },
    ]);
    expect(parse([event("nonsense")]).usage).toBeNull();
    expect(parse([event({ seven_day_opus: { resetsAt: 1792418400 } })]).usage).toBeNull();
  });

  /**
   * H-10 (spine §5 reading 234): `utilization` is mapped only because a recording confirmed its
   * unit. `live:h15 claude-usage-unit` (Claude Code 2.1.299, 2026-10-15) recorded this stream
   * (`five_hour` 0.13, `seven_day` 0.73) and, 12 s later, Claude Code's own `/usage`: "Current
   * session: 14% used · resets Oct 15 at 11:39pm", "Current week (all models): 73% used · resets
   * Oct 19 at 8:59pm" (UTC+7), the same resets as the stream's. An earlier pair read 0.12 / 0.72
   * against 13% / 73%. So it is the 0–1 fraction of the percentage `/usage` prints, read up to one
   * point low (the stream's event comes before the run's own use): never treated as exact.
   */
  it("maps unifiedWindows utilization, a confirmed 0–1 fraction, to used_pct", () => {
    const usage = UsageSnapshotSchema.parse(
      parse(lines("claude-code/stream-usage-unit.jsonl")).usage,
    );
    expect(usage.windows).toEqual([
      {
        kind: "five_hour",
        label: "five_hour",
        window_minutes: 300,
        used_pct: 13,
        resets_at: "2026-10-15T16:40:00.000Z",
      },
      {
        kind: "weekly",
        label: "seven_day",
        window_minutes: 10080,
        used_pct: 73,
        resets_at: "2026-10-19T14:00:00.000Z",
      },
    ]);
  });

  it("keeps used_pct unknown for a utilization outside 0–1 or not a number, never a guess", () => {
    const event = (utilization: unknown) =>
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: { five_hour: { utilization, resetsAt: 1792082400 } },
        },
      });
    for (const odd of [1.5, -0.1, "0.4", null, Number.NaN]) {
      expect(parse([event(odd)]).usage?.windows[0]?.used_pct, String(odd)).toBeNull();
    }
    expect(parse([event(0)]).usage?.windows[0]?.used_pct).toBe(0);
    expect(parse([event(1)]).usage?.windows[0]?.used_pct).toBe(100);
    expect(parse([event(0.1234)]).usage?.windows[0]?.used_pct).toBe(12.3);
    // the latest reading wins, and a rejection is 100% whatever utilization said
    const rejected = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: 1792082400 } },
      },
    });
    expect(parse([event(0.2), event(0.4)]).usage?.windows[0]?.used_pct).toBe(40);
    expect(parse([event(0.2), rejected]).usage?.windows[0]?.used_pct).toBe(100);
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
  it("a stream key named like an Object.prototype member is no cap and no window", () => {
    for (const subtype of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const outcome = valid(
        parse([JSON.stringify({ type: "result", subtype, is_error: true })]).outcome,
      );
      expect(outcome).toMatchObject({ kind: "error", retryable: true });
      expect(outcome).not.toHaveProperty("cause");
      const limited = parse([
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: subtype },
        }),
        JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
      ]);
      expect(valid(limited.outcome)).toMatchObject({ kind: "limit", window: null });
      if (limited.usage !== null)
        expect(UsageSnapshotSchema.parse(limited.usage).windows).toEqual([]);
    }
  });

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

/**
 * Round-5 item (merge follow-up): a plugin hook's non-zero exit that is not a block is noise in a
 * headless stream, never a role failure. Recorded: before `vtc` was on `PATH`, the plugin's
 * `SessionStart` hook exited 127 in every role run (`stream-arm-success.jsonl`, 2026-10-15) and the
 * run still ended `done`; with `vtc` on `PATH` (`live:dcl claude-arm`, Claude Code 2.1.299,
 * 2026-10-15) the same hook exited 0 with no output, and `agent_type` reached its input.
 */
describe("Claude plugin hook exits are noise (round-5 item)", () => {
  const hookResponse = (exitCode: number, stderr: string) =>
    JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_id: "h-1",
      hook_name: "SessionStart:startup",
      hook_event: "SessionStart",
      output: stderr,
      stdout: "",
      stderr,
      exit_code: exitCode,
      outcome: "error",
      session_id: "s-1",
    });

  it("the recorded exit-127 hook leaves the run done", () => {
    const recorded = lines("claude-code/stream-arm-success.jsonl");
    expect(recorded.some((l) => l.includes('"exit_code":127'))).toBe(true);
    expect(valid(parse(recorded).outcome).kind).toBe("done");
    expect(claudeOutcomeAfterExit(recorded, exit(0)).kind).toBe("done");
    expect(parse(recorded).unrecognizedLines).toBe(0);
  });

  it("with vtc on PATH the plugin's SessionStart hook exits 0 silently and the bridge connects", () => {
    const recorded = lines("claude-code/stream-arm-vtc-on-path.jsonl");
    const events = recorded.map((l) => JSON.parse(l) as Record<string, unknown>);
    const hooks = events.filter((e) => e.subtype === "hook_response");
    expect(hooks.map((e) => e.exit_code)).toEqual([0, 0]);
    // the plugin's hook printed nothing (the other is the owner's own, redacted)
    expect(hooks.some((e) => e.stdout === "" && e.output === "" && e.stderr === "")).toBe(true);
    const init = events.find((e) => e.subtype === "init");
    expect(init?.mcp_servers).toEqual([{ name: "vtc", status: "connected", source: "dynamic" }]);
    expect(valid(parse(recorded).outcome).kind).toBe("done");
  });

  it("a failing hook whose text names a limit or a sign-in changes nothing", () => {
    const success = lines("claude-code/stream-success.jsonl");
    for (const text of ["Error: not logged in", "usage limit reached", "rate limit 429"]) {
      const withHook = [success[0] ?? "", hookResponse(1, text), ...success.slice(1)];
      expect(valid(parse(withHook).outcome).kind, text).toBe("done");
      expect(claudeOutcomeAfterExit(withHook, exit(0)).kind, text).toBe("done");
      // no result: the exit decides, never the hook's text
      const cut = withHook.filter((l) => !l.includes('"type":"result"'));
      expect(claudeOutcomeAfterExit(cut, exit(1)), text).toMatchObject({
        kind: "error",
        cause: "exit_code",
      });
    }
  });
});
