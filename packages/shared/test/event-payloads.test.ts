import { describe, expect, it } from "vitest";
import {
  CORE_EVENT_TYPES,
  EVENT_PAYLOAD_SCHEMAS,
  EventSchema,
  isEventOfType,
  parseSseEventId,
  readEventData,
  sseEventId,
  validateEventData,
  type CoreEventType,
  type EventDataInput,
} from "../src/index.js";
import {
  COMMIT,
  NOW,
  SHA,
  validEscalation,
  validFeature,
  validFinding,
  validGateReport,
  validTask,
} from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

/** One valid payload per core event type, plus the envelope fields that type requires. */
const examples: { [T in CoreEventType]: { data: EventDataInput<T>; envelope?: object } } = {
  "run.started": {
    data: {
      track: "feature",
      repo: "existing",
      has_ui: true,
      risk_hints: ["auth"],
      merge_level: 2,
      pipeline_config_hash: SHA,
    },
  },
  "run.phase_changed": { data: { from: "specify", to: "g1" } },
  "run.paused": { data: { reason: "vtc pause (kill switch)" } },
  "run.resumed": { data: { auto: true } },
  "run.finished": { data: { outcome: "done", summary: ".vtc/runs/r1/summary.md" } },
  "gate.approved": {
    data: { gates: ["G1"], frozen: [{ path: ".vtc/spec/spec.md", sha256: SHA }] },
  },
  "gate.rejected": { data: { gates: ["G2"], note: "Pick a cheaper datastore." } },
  "task.created": { data: { task: validTask() }, envelope: { task: "T-7" } },
  "task.status_changed": {
    data: { from: "fixing", to: "parked", round: 5, cap: 5, park_reason: "cap" },
    envelope: { task: "T-7" },
  },
  "feature.created": { data: { feature: validFeature() as never }, envelope: { feature: "F-1" } },
  "feature.status_changed": {
    data: { from: "integrating", to: "final_review", round: 0 },
    envelope: { feature: "F-1" },
  },
  "role.dispatched": {
    data: {
      action_id: "a-1",
      mode: "author",
      dispatch: "subagent",
      agent: "vtc-qa-author",
      pack: ".vtc/state/packs/T-7.md",
      resume: null,
    },
    envelope: { role: "qa", task: "T-7" },
  },
  "role.submitted": {
    data: {
      action_id: "a-1",
      exit: "done",
      verdict: "pass",
      findings: 0,
      questions: 1,
      session_ref: null,
    },
    envelope: { role: "qa", task: "T-7" },
  },
  "role.rejected": {
    data: { action_id: "a-1", reason: "write_scope", issues: ["src/other.ts is out of scope"] },
    envelope: { role: "engineer", task: "T-7" },
  },
  "role.failed": {
    data: { action_id: "a-1", kind: "error", message: "crashed", retryable: true },
    envelope: { role: "engineer", task: "T-7" },
  },
  "gate.result": { data: validGateReport() as never, envelope: { task: "T-7" } },
  "finding.recorded": { data: { finding: validFinding() as never }, envelope: { task: "T-7" } },
  "finding.status_changed": { data: { fingerprint: SHA, from: "open", to: "resolved" } },
  "escalation.opened": { data: { escalation: validEscalation() as never } },
  "escalation.answered": {
    data: { escalation: "E-4", answer: { option: "hint", who_should_have_caught: "qa" } },
  },
  "budget.updated": {
    data: { scope: "task", budget_usd: 5, spent_usd: 3.5 },
    envelope: { task: "T-7" },
  },
  "usage.updated": {
    data: {
      snapshot: {
        host: "codex",
        source: "app_server",
        windows: [
          {
            kind: "five_hour",
            label: "primary",
            window_minutes: 300,
            used_pct: 12,
            resets_at: NOW,
          },
        ],
        updated_at: NOW,
      },
    },
  },
  "limit.hit": {
    data: {
      host: "claude-code",
      window: "five_hour",
      model: null,
      resets_at: NOW,
      session_ref: { host: "claude-code", id: "s-1" },
      pending_action_ids: ["a-1"],
      auto_resume_at: "2026-10-13T13:02:00Z",
    },
  },
  "merge.completed": {
    data: { into: "vtc/F-1", commit: COMMIT, level: 2 },
    envelope: { task: "T-7" },
  },
  "incident.recorded": {
    data: { kind: "log_corruption", detail: "torn final line", invalid_lines: [12] },
  },
};

const event = (type: CoreEventType) => ({
  v: 1,
  seq: 1,
  ts: NOW,
  run: "r1",
  type,
  actor: "engine",
  ...(examples[type].envelope ?? {}),
  data: examples[type].data,
});

describe("EVENT_PAYLOAD_SCHEMAS", () => {
  it("covers exactly the core vocabulary", () => {
    expect(Object.keys(examples).sort()).toEqual([...CORE_EVENT_TYPES].sort());
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual([...CORE_EVENT_TYPES].sort());
  });
  it.each(CORE_EVENT_TYPES)("accepts a valid %s event", (type) => {
    expectValid(EventSchema, event(type));
  });
  it.each([
    ["task.status_changed", { from: "fixing", to: "parked", round: 5, cap: 5 }, "data.park_reason"],
    ["task.status_changed", { from: "fixing", to: "built", round: 1, cap: 9 }, "data.cap"],
    ["task.status_changed", { from: "fixing", to: "shipped", round: 1, cap: 3 }, "data.to"],
    ["role.rejected", { action_id: "a-1", reason: "vibes" }, "data.reason"],
    ["limit.hit", { host: "claude-code" }, "data.window"],
    ["gate.approved", { gates: ["G1"], frozen: [] }, "data.frozen"],
    ["merge.completed", { into: "main", commit: "abc1234", level: 2 }, "data.commit"],
    ["run.phase_changed", { from: null, to: "deploy" }, "data.to"],
    ["usage.updated", { snapshot: { host: "codex" } }, "data.snapshot.source"],
    ["incident.recorded", { kind: "crash", detail: "x", extra: 1 }, "data"],
  ] as const)("rejects an invalid %s payload (%j)", (type, data, path) => {
    expectInvalid(EventSchema, { ...event(type), data }, path);
  });
  it("requires the envelope fields of task, feature and role events", () => {
    const { task: _t, ...noTask } = event("task.status_changed") as Record<string, unknown>;
    expectInvalid(EventSchema, noTask, "task");
    const { role: _r, ...noRole } = event("role.dispatched") as Record<string, unknown>;
    expectInvalid(EventSchema, noRole, "role");
    const { feature: _f, ...noFeature } = event("feature.created") as Record<string, unknown>;
    expectInvalid(EventSchema, noFeature, "feature");
  });
  it("leaves unknown event types open", () => {
    expect(validateEventData("research.cached", { anything: [1, 2] })).toEqual({
      ok: true,
      data: { anything: [1, 2] },
    });
    expectValid(EventSchema, { ...event("run.paused"), type: "lookback.scored", data: { x: 1 } });
  });
  it("reads a typed payload with defaults applied", () => {
    const parsed = expectValid(EventSchema, event("gate.approved"));
    expect(isEventOfType(parsed, "gate.approved")).toBe(true);
    if (isEventOfType(parsed, "gate.approved")) {
      expect(readEventData(parsed).waived_facts).toEqual([]);
    }
    expect(isEventOfType(parsed, "run.paused")).toBe(false);
  });
});

describe("SSE ids", () => {
  it("formats and parses <run>:<seq>", () => {
    expect(sseEventId("run-1", 42)).toBe("run-1:42");
    expect(parseSseEventId("run-1:42")).toEqual({ run: "run-1", seq: 42 });
    expect(parseSseEventId("2026.10.13:7")).toEqual({ run: "2026.10.13", seq: 7 });
  });
  it.each(["", "run-1", ":4", "run-1:0", "run-1:-1", "run-1:x", "../a:1", "run-1:01"])(
    "rejects %j",
    (id) => {
      expect(parseSseEventId(id)).toBeNull();
    },
  );
  it("refuses to format an invalid id", () => {
    expect(() => sseEventId("a/b", 1)).toThrow();
    expect(() => sseEventId("r1", 0)).toThrow();
  });
});
