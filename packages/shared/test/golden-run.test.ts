/**
 * The golden run fixture (fixtures/golden-run) is a contract between the engine and the
 * dashboard (AD-5, AD-7): every API snapshot validates against its route's response contract,
 * and the snapshots agree with the event log they are projected from.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ArtifactContentSchema,
  CONTRACT_SCHEMAS,
  ENGINE_HTTP,
  EscalationListSchema,
  FeatureListSchema,
  findUnguardedCycle,
  integrationBranchFor,
  isEventOfType,
  EventPageSchema,
  parseEventLog,
  readEventData,
  RunListSchema,
  sha256Hex,
  StatusResultSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskListSchema,
  TaskPackSchema,
  taskPackPath,
  UsageReportSchema,
  WorkflowGraphSchema,
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
  "task-T-1-diff": "taskDiff",
  features: "features",
  "artifact-spec": "artifact",
  escalations: "escalations",
  "graph-project": "graph",
  "graph-task_dag": "graph",
  "graph-task-T-2": "graph",
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
  it("engine-owned task fields replay from their own events (AD-7)", () => {
    for (const task of TaskListSchema.parse(api("tasks")).tasks) {
      const created = of("task.created").find((e) => e.task === task.id);
      expect(task.risk_tags).toEqual(created && readEventData(created).task.risk_tags);
      const workspace = of("task.workspace_assigned")
        .filter((e) => e.task === task.id)
        .at(-1);
      const ws = workspace && readEventData(workspace);
      expect([task.worktree, task.branch, task.baseline_revision]).toEqual([
        ws?.worktree,
        ws?.branch,
        ws?.baseline_revision,
      ]);
      const session = of("task.session_updated")
        .filter((e) => e.task === task.id)
        .at(-1);
      expect(task.session_ref).toEqual(session && readEventData(session).session_ref);
    }
  });
  it("features follow feature.created and their budget events; status lists them", () => {
    const features = FeatureListSchema.parse(api("features")).features;
    expect(features.map((f) => f.id)).toEqual(of("feature.created").map((e) => e.feature));
    for (const feature of features) {
      const budget = of("budget.updated")
        .filter((e) => e.feature === feature.id && readEventData(e).scope === "feature")
        .at(-1);
      expect(feature.spent_usd).toBe(budget ? readEventData(budget).spent_usd : 0);
    }
    expect(StatusResultSchema.parse(api("status")).features).toEqual(features);
  });
  it("the run's one feature is named from the recorded request (FeatureSchema)", () => {
    const started = of("run.started")[0];
    const request = started && readEventData(started).request;
    const firstLine = request?.split("\n").find((line) => line.trim() !== "");
    const features = FeatureListSchema.parse(api("features")).features;
    expect(features).toHaveLength(1);
    expect(features[0]?.title).toBe(firstLine?.trim().slice(0, 200));
    expect(features[0]?.integration_branch).toBe(integrationBranchFor(features[0]?.id ?? ""));
    const tasks = TaskListSchema.parse(api("tasks")).tasks;
    expect(new Set(tasks.map((t) => t.feature))).toEqual(new Set([features[0]?.id]));
  });
  it("the intent contract replays from task.created: the pack carries exactly it", () => {
    const pack = TaskPackSchema.parse(JSON.parse(read("packs/a-1.json")));
    const created = of("task.created").find((e) => e.task === pack.task);
    expect(created && readEventData(created).intent).toEqual(pack.intent);
  });
  it("a built submit names the commit the gates then verified", () => {
    const built = of("role.submitted").filter((e) => readEventData(e).exit === "built");
    expect(built.length).toBeGreaterThan(0);
    for (const submitted of built) {
      const gate = of("gate.result").find(
        (e) => e.task === submitted.task && e.seq > submitted.seq,
      );
      expect(readEventData(submitted).head).toBe(gate && readEventData(gate).head);
    }
  });
  it("task detail lists its role runs with prompt versions, and its diff", () => {
    for (const id of ["T-1", "T-2"]) {
      const detail = TaskDetailSchema.parse(api(`task-${id}`));
      const dispatched = of("role.dispatched").filter((e) => e.task === id);
      expect(detail.role_runs.map((r) => [r.action_id, r.prompt_sha, r.model])).toEqual(
        dispatched.map((e) => [readEventData(e).action_id, e.prompt_sha, e.model]),
      );
      const gate = of("gate.result")
        .filter((e) => e.task === id)
        .at(-1);
      const report = gate && readEventData(gate);
      expect(detail.diff).toEqual(report ? { base: report.base, head: report.head } : null);
    }
    const diff = TaskDiffSchema.parse(api("task-T-1-diff"));
    expect({ base: diff.base, head: diff.head }).toEqual(
      TaskDetailSchema.parse(api("task-T-1")).diff,
    );
  });
  it("the artifact snapshot is the spec G1 froze, byte for byte", () => {
    const artifact = ArtifactContentSchema.parse(api("artifact-spec"));
    expect(sha256Hex(artifact.content)).toBe(artifact.sha256);
    expect(new TextEncoder().encode(artifact.content).length).toBe(artifact.size);
    const approved = of("gate.approved").flatMap((e) => readEventData(e).frozen);
    expect(approved).toContainEqual({ path: artifact.path, sha256: artifact.sha256 });
  });
  it("has a graph for every zoom level; the task pipeline loops only through a loop_guard", () => {
    const graphs = ["graph-project", "graph-task_dag", "graph-task-T-2"].map((f) =>
      WorkflowGraphSchema.parse(api(f)),
    );
    expect(graphs.map((g) => g.scope)).toEqual(["project", "task_dag", "task"]);
    const pipeline = graphs[2]!;
    const guard = pipeline.nodes.find((n) => n.kind === "loop_guard");
    expect(pipeline.edges.some((e) => e.from === guard?.id && e.to === "engineer")).toBe(true);
    expect(findUnguardedCycle(pipeline)).toBeNull();
    const withoutGuard = {
      nodes: pipeline.nodes.map((n) =>
        n.kind === "loop_guard" ? { ...n, kind: "router" as const } : n,
      ),
      edges: pipeline.edges,
    };
    expect(findUnguardedCycle(withoutGuard)).not.toBeNull();
  });
  it("the recorded dispatch's task pack validates and sits at its pack path", () => {
    const pack = TaskPackSchema.parse(JSON.parse(read("packs/a-1.json")));
    const dispatched = of("role.dispatched").find(
      (e) => readEventData(e).action_id === pack.action_id,
    );
    expect(dispatched && readEventData(dispatched).pack).toBe(taskPackPath(pack.action_id));
    expect([dispatched?.task, dispatched?.role]).toEqual([pack.task, pack.role]);
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
