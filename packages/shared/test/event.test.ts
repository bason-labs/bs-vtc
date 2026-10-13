import { describe, expect, it } from "vitest";
import {
  CORE_EVENT_TYPES,
  EventSchema,
  EventTypeSchema,
  eventLogPath,
  parseEventLog,
  parsePersisted,
  runRequestPath,
  toEventLine,
} from "../src/index.js";
import { validEvent } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("EventSchema", () => {
  it("accepts a role event", () => {
    expectValid(EventSchema, validEvent());
  });
  it("accepts a minimal event of an unknown (open) type and defaults data", () => {
    const event = expectValid(EventSchema, {
      v: 1,
      seq: 2,
      ts: "2026-10-13T08:00:01Z",
      run: "r1",
      type: "research.cached",
      actor: "engine",
    });
    expect(event.data).toEqual({});
  });
  it("accepts null cost (model missing from price table)", () => {
    expectValid(EventSchema, { ...validEvent(), cost_usd: null });
  });
  it.each([
    ["v", { v: 2 }],
    ["seq", { seq: 0 }],
    ["ts", { ts: "now" }],
    ["run", { run: "../x" }],
    ["type", { type: "TaskStarted" }],
    ["type", { type: "task" }],
    ["actor", { actor: "system" }],
    ["role", { role: undefined }],
    ["host", { host: "cursor" }],
    ["cost_usd", { cost_usd: -1 }],
    ["tokens.out", { tokens: { in: 1, out: -2, cache_r: 0, cache_w: 0 } }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(EventSchema, { ...validEvent(), ...patch }, path);
  });
  it("core event types all match the naming pattern", () => {
    for (const type of CORE_EVENT_TYPES) expectValid(EventTypeSchema, type);
  });
});

describe("event log helpers", () => {
  it("builds the log path and refuses unsafe run ids", () => {
    expect(eventLogPath("run-1")).toBe(".vtc/runs/run-1/events.jsonl");
    expect(() => eventLogPath("../etc")).toThrow();
    expect(runRequestPath("run-1")).toBe(".vtc/runs/run-1/request.md");
    expect(() => runRequestPath("../etc")).toThrow();
  });
  it("round-trips lines and reports bad lines without throwing", () => {
    const good = toEventLine(validEvent());
    expect(good.endsWith("\n")).toBe(true);
    const log = `${good}\n{not json}\n${JSON.stringify({ v: 1 })}\n${good}`;
    const parsed = parseEventLog(log);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.invalidLines).toEqual([3, 4]);
    expect(parsed.truncatedTail).toBe(false);
  });
  it("flags a torn final line", () => {
    const parsed = parseEventLog(`${toEventLine(validEvent())}{"v":1,"se`);
    expect(parsed.truncatedTail).toBe(true);
    expect(parsed.invalidLines).toEqual([2]);
  });
  it("toEventLine rejects invalid events", () => {
    expect(() => toEventLine({ ...validEvent(), seq: -1 })).toThrow();
  });
});

describe("an older reader of a newer MINOR log (AD-3 rule 2)", () => {
  /** What a newer vtc writes after adding optional fields: to the envelope and to payloads. */
  const newer = {
    ...validEvent(),
    trace_id: "t-1",
    data: { ...(validEvent().data as object), retries: 2, nested_ok: true },
  };
  it("the writer stays strict: unknown keys never reach the log", () => {
    expectInvalid(EventSchema, newer, "");
    expectInvalid(EventSchema, newer, "data");
    expect(() => toEventLine(newer)).toThrow();
  });
  it("replay drops the unknown keys, keeps the event and reports the line, not corruption", () => {
    const parsed = parseEventLog(`${toEventLine(validEvent())}${JSON.stringify(newer)}\n`);
    expect(parsed.invalidLines).toEqual([]);
    expect(parsed.strippedLines).toEqual([2]);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[1]).toEqual(parsed.events[0]);
  });
  it("drops unknown keys nested inside a typed payload too", () => {
    const task = {
      v: 1,
      seq: 3,
      ts: "2026-10-13T08:00:01Z",
      run: "r1",
      task: "T-1",
      type: "task.status_changed",
      actor: "engine",
      data: { from: "ready", to: "tests_authored", round: 0, cap: 3, reason_note: "x" },
    };
    const result = parsePersisted(EventSchema, task);
    expect(result.success && result.stripped).toEqual(["data.reason_note"]);
  });
  it("still reports a real error on the same line as invalid", () => {
    const broken = { ...newer, seq: 0 };
    expect(parseEventLog(`${JSON.stringify(broken)}\n`).invalidLines).toEqual([1]);
  });
});
