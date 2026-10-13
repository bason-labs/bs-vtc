import { describe, expect, it } from "vitest";
import {
  findUnguardedCycle,
  remainingPct,
  StatuslineIngestSchema,
  unknownUsage,
  usageFromStatuslineIngest,
  UsageReportSchema,
  UsageSnapshotSchema,
  windowKindFromMinutes,
  WorkflowGraphSchema,
  WorkflowNodeSchema,
} from "../src/index.js";
import { NOW } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

const snapshot = () => ({
  host: "claude-code",
  source: "statusline",
  windows: [
    { kind: "five_hour", label: "five_hour", window_minutes: 300, used_pct: 42.5, resets_at: NOW },
    { kind: "weekly", label: "seven_day", window_minutes: 10080, used_pct: null, resets_at: null },
  ],
  model_limits: [{ model: "claude-opus-5-5", resets_at: null, observed_at: NOW }],
  updated_at: NOW,
});

describe("UsageSnapshotSchema", () => {
  it("accepts known and unknown windows", () => {
    expectValid(UsageSnapshotSchema, snapshot());
  });
  it("unknown usage is null, never 0", () => {
    const empty = expectValid(UsageSnapshotSchema, unknownUsage("codex"));
    expect(empty.updated_at).toBeNull();
    expect(remainingPct({ used_pct: null })).toBeNull();
    expect(remainingPct({ used_pct: 42.5 })).toBe(57.5);
    expect(remainingPct({ used_pct: 100 })).toBe(0);
  });
  it.each([
    ["host", { host: "gemini" }],
    ["source", { source: "scraped" }],
    ["updated_at", { updated_at: undefined }],
    [
      "windows.0.used_pct",
      {
        windows: [{ kind: "other", label: "x", window_minutes: 1, used_pct: 120, resets_at: null }],
      },
    ],
    [
      "windows.0.resets_at",
      { windows: [{ kind: "other", label: "x", window_minutes: 1, used_pct: 1 }] },
    ],
    [
      "windows.0.kind",
      { windows: [{ label: "x", window_minutes: 1, used_pct: 1, resets_at: null }] },
    ],
    [
      "windows.0.kind",
      { windows: [{ kind: "daily", label: "x", window_minutes: 1, used_pct: 1, resets_at: null }] },
    ],
    [
      "windows.0.window_minutes",
      { windows: [{ kind: "other", label: "x", window_minutes: 0, used_pct: 1, resets_at: null }] },
    ],
    ["model_limits.0.observed_at", { model_limits: [{ model: "m", resets_at: null }] }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(UsageSnapshotSchema, { ...snapshot(), ...patch }, path);
  });
});

describe("usage window kinds", () => {
  it("classifies Codex windowDurationMins 300 / 10080 (never by label)", () => {
    expect(windowKindFromMinutes(300)).toBe("five_hour");
    expect(windowKindFromMinutes(10080)).toBe("weekly");
    expect(windowKindFromMinutes(1440)).toBe("other");
    expect(windowKindFromMinutes(null)).toBe("other");
  });
});

describe("Claude statusline ingest", () => {
  const body = () => ({
    v: 1,
    session_id: "sess-1",
    model: "claude-opus-5-5",
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 1792022400 },
      seven_day: null,
    },
  });
  it("turns an ingest body into a snapshot; a missing window stays unknown", () => {
    const snapshot = usageFromStatuslineIngest(expectValid(StatuslineIngestSchema, body()), NOW);
    expectValid(UsageSnapshotSchema, snapshot);
    expect(snapshot.windows).toEqual([
      {
        kind: "five_hour",
        label: "five_hour",
        window_minutes: 300,
        used_pct: 42,
        resets_at: "2026-10-15T00:00:00.000Z",
      },
      {
        kind: "weekly",
        label: "seven_day",
        window_minutes: 10080,
        used_pct: null,
        resets_at: null,
      },
    ]);
    expect(snapshot.updated_at).toBe(NOW);
  });
  it.each([
    ["v", { v: 2 }],
    [
      "rate_limits.five_hour.used_percentage",
      { rate_limits: { five_hour: { used_percentage: 101, resets_at: 1 }, seven_day: null } },
    ],
    ["rate_limits.seven_day", { rate_limits: { five_hour: null } }],
    ["", { transcript_path: "/Users/me/.claude/x.jsonl" }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(StatuslineIngestSchema, { ...body(), ...patch }, path);
  });
  it("the usage report carries interrupted tasks and the next auto-resume", () => {
    expectValid(UsageReportSchema, {
      hosts: [unknownUsage("claude-code"), unknownUsage("codex")],
      interrupted_tasks: ["T-3"],
      auto_resume_at: NOW,
    });
    expectInvalid(UsageReportSchema, { hosts: [], auto_resume_at: "soon" }, "auto_resume_at");
  });
});

const node = (id: string, kind = "role", extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  label: id,
  ...(kind === "role" ? { role: "engineer" } : {}),
  reason_added: "backbone",
  state: "waiting",
  ...extra,
});
const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from, to });

describe("WorkflowNodeSchema", () => {
  it("accepts every kind with its required fields", () => {
    for (const kind of [
      "role",
      "gate",
      "human",
      "router",
      "fan_out",
      "join",
      "loop_guard",
      "park",
    ]) {
      expectValid(WorkflowNodeSchema, node(kind, kind));
    }
    expectValid(WorkflowNodeSchema, node("eng", "role", { state: "interrupted" }));
    expectValid(WorkflowNodeSchema, node("sf", "subflow", { subflow: "task-t-7" }));
  });
  it.each([
    ["role", { id: "a", kind: "role", label: "a", reason_added: "r", state: "waiting" }],
    ["subflow", node("s", "subflow")],
    ["round", node("a", "role", { state: "looping" })],
    ["park_reason", node("a", "role", { state: "parked" })],
    ["reason_added", node("a", "role", { reason_added: "" })],
    ["kind", node("a", "agent")],
    ["state", node("a", "role", { state: "failed" })],
  ])("rejects invalid %s", (path, value) => {
    expectInvalid(WorkflowNodeSchema, value, path);
  });
  it("accepts looping with round/cap", () => {
    expectValid(WorkflowNodeSchema, node("eng", "role", { state: "looping", round: 2, cap: 4 }));
  });
});

describe("WorkflowGraphSchema", () => {
  const pipeline = () => ({
    id: "task-t-7",
    scope: "task",
    nodes: [
      node("engineer"),
      node("gates", "gate"),
      node("guard", "loop_guard"),
      node("park", "park"),
    ],
    edges: [
      edge("engineer", "gates"),
      edge("gates", "guard"),
      edge("guard", "engineer"),
      edge("guard", "park"),
    ],
  });

  it("accepts a fix loop that passes through a loop_guard", () => {
    expectValid(WorkflowGraphSchema, pipeline());
  });
  it("rejects a back-edge that bypasses the loop_guard", () => {
    const graph = pipeline();
    graph.edges.push(edge("gates", "engineer"));
    expectInvalid(WorkflowGraphSchema, graph, "edges");
    expect(findUnguardedCycle(graph as never)).toEqual(["engineer", "gates"]);
  });
  it("rejects a self-loop", () => {
    const graph = pipeline();
    graph.edges.push(edge("engineer", "engineer"));
    expect(findUnguardedCycle(graph as never)).toEqual(["engineer"]);
  });
  it("rejects dangling edges and duplicate ids", () => {
    const graph = pipeline();
    graph.edges.push(edge("engineer", "ghost"));
    expectInvalid(WorkflowGraphSchema, graph, "edges.4.to");
    const dup = pipeline();
    dup.nodes.push(node("engineer"));
    expectInvalid(WorkflowGraphSchema, dup, "nodes.4.id");
    const dupEdge = pipeline();
    dupEdge.edges.push(edge("engineer", "gates"));
    expectInvalid(WorkflowGraphSchema, dupEdge, "edges.4.id");
  });
  it("finds no cycle in a DAG", () => {
    expect(
      findUnguardedCycle({
        nodes: [node("a"), node("b"), node("c")] as never,
        edges: [edge("a", "b"), edge("a", "c"), edge("b", "c")],
      }),
    ).toBeNull();
  });
});
