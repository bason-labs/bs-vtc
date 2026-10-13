/**
 * The golden run fixture (fixtures/golden-run) is a contract between the engine and the
 * dashboard (AD-5, AD-7): every API snapshot validates against its route's response contract,
 * and the snapshots agree with the event log they are projected from.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMAS,
  ENGINE_HTTP,
  EscalationListSchema,
  isEventOfType,
  EventPageSchema,
  parseEventLog,
  readEventData,
  RunListSchema,
  StatusResultSchema,
  TaskListSchema,
  UsageReportSchema,
  type ContractName,
  type CoreEventType,
  type VtcEvent,
} from "../src/index.js";

const root = new URL("../../../fixtures/golden-run/", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
const api = (name: string): unknown => JSON.parse(read(`api/${name}.json`));

const log = parseEventLog(read("events.jsonl"));
const of = <T extends CoreEventType>(type: T): (VtcEvent & { type: T })[] =>
  log.events.filter((e): e is VtcEvent & { type: T } => isEventOfType(e, type));

/** Fixture file → the route it snapshots. */
const SNAPSHOTS: Record<string, keyof typeof ENGINE_HTTP.routes> = {
  health: "health",
  runs: "runs",
  status: "status",
  events: "runEvents",
  tasks: "tasks",
  "task-T-1": "task",
  "task-T-2": "task",
  escalations: "escalations",
  "graph-task_dag": "graph",
  usage: "usage",
};

describe("golden run: event log", () => {
  it("is a clean log with seq 1..n and typed payloads", () => {
    expect(log.invalidLines).toEqual([]);
    expect(log.truncatedTail).toBe(false);
    expect(log.events.map((e) => e.seq)).toEqual(log.events.map((_e, i) => i + 1));
    expect(new Set(log.events.map((e) => e.run))).toEqual(new Set(["golden-1"]));
  });
});

describe("golden run: API snapshots", () => {
  it("has a snapshot for every read route except the SSE stream", () => {
    const files = readdirSync(new URL("api/", root)).map((f) => f.replace(/\.json$/, ""));
    expect(files.sort()).toEqual(Object.keys(SNAPSHOTS).sort());
    const reads = Object.entries(ENGINE_HTTP.routes)
      .filter(([, r]) => r.method === "GET" && !("sse" in r))
      .map(([name]) => name);
    expect([...new Set(Object.values(SNAPSHOTS))].sort()).toEqual(reads.sort());
  });
  it.each(Object.entries(SNAPSHOTS))("%s validates as the %s route response", (file, route) => {
    const contract: ContractName = ENGINE_HTTP.routes[route].response;
    const parsed = CONTRACT_SCHEMAS[contract].safeParse(api(file));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
  it("events.json is the log itself", () => {
    expect(EventPageSchema.parse(api("events")).events).toEqual(log.events);
  });
  it("run phase follows the last run.phase_changed", () => {
    const last = of("run.phase_changed").at(-1);
    const phase = last && readEventData(last).to;
    expect(RunListSchema.parse(api("runs")).runs[0]?.phase).toBe(phase);
    expect(StatusResultSchema.parse(api("status")).run.phase).toBe(phase);
  });
  it("each task's status, round and spend follow its events", () => {
    const tasks = TaskListSchema.parse(api("tasks")).tasks;
    for (const task of tasks) {
      const changes = of("task.status_changed").filter((e) => e.task === task.id);
      const lastChange = changes.at(-1);
      expect(lastChange).toBeDefined();
      const last = readEventData(lastChange!);
      expect([task.status, task.round, task.park_reason]).toEqual([
        last.to,
        last.round,
        last.park_reason,
      ]);
      const budget = of("budget.updated")
        .filter((e) => e.task === task.id)
        .at(-1);
      expect(task.spent_usd).toBe(budget ? readEventData(budget).spent_usd : 0);
    }
    const status = StatusResultSchema.parse(api("status"));
    const counts: Record<string, number> = {};
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    expect(status.tasks_by_status).toEqual(counts);
    expect(status.budget.spent_usd).toBeCloseTo(tasks.reduce((sum, t) => sum + t.spent_usd, 0));
  });
  it("open escalations are opened minus answered", () => {
    const answered = new Set(of("escalation.answered").map((e) => readEventData(e).escalation));
    const open = of("escalation.opened")
      .map((e) => readEventData(e).escalation)
      .filter((esc) => !answered.has(esc.id));
    expect(EscalationListSchema.parse(api("escalations")).escalations).toEqual(open);
    expect(StatusResultSchema.parse(api("status")).open_escalations).toBe(open.length);
  });
  it("usage shows the last snapshot per host; hosts without data stay unknown", () => {
    const usage = UsageReportSchema.parse(api("usage"));
    const last = of("usage.updated").at(-1);
    const snapshot = last && readEventData(last).snapshot;
    expect(usage.hosts.find((h) => h.host === snapshot?.host)).toEqual(snapshot);
    expect(usage.hosts.find((h) => h.host === "codex")?.updated_at).toBeNull();
  });
});
