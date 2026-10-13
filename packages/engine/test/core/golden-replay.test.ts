/**
 * Golden replay (AD-7 Check, §18): `fixtures/golden-run/events.jsonl` replays to exactly the
 * `api/*.json` snapshots, through the same read model the HTTP server and snapshot mode use.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMAS,
  ENGINE_HTTP,
  EVENT_PAGE_LIMIT,
  type ArtifactContent,
  type GitOps,
} from "@vtc/shared";
import { createReadModel, loadRuns, type ReadModel, type ReadResult } from "../../src/core/index.js";

const fixture = new URL("../../../../fixtures/golden-run/", import.meta.url);
const api = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`api/${name}.json`, fixture), "utf8"));

const body = <T>(result: ReadResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.body;
};

let repo: string;
let model: ReadModel;

const goldenDiff = api("task-T-1-diff") as {
  base: string;
  head: string;
  patch: string;
  files: { path: string; status: "added" }[];
};

const fakeGit: Pick<GitOps, "changedFiles" | "diff"> = {
  changedFiles: (base, head) =>
    Promise.resolve(
      base === goldenDiff.base && head === goldenDiff.head
        ? goldenDiff.files.map((f) => ({ path: f.path, status: f.status }))
        : [],
    ),
  diff: (base, head) =>
    Promise.resolve(base === goldenDiff.base && head === goldenDiff.head ? goldenDiff.patch : ""),
};

const buildRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vtc-golden-"));
  const log = join(dir, ".vtc/runs/golden-1/events.jsonl");
  mkdirSync(dirname(log), { recursive: true });
  cpSync(new URL("events.jsonl", fixture), log);
  const spec = api("artifact-spec") as ArtifactContent;
  mkdirSync(join(dir, ".vtc/spec"), { recursive: true });
  writeFileSync(join(dir, spec.path), spec.content);
  return dir;
};

const modelFor = (dir: string): ReadModel => {
  const runs = loadRuns(dir).map((r) => r.state);
  return createReadModel({
    repoRoot: dir,
    mode: "snapshot",
    versions: { engine: "0.0.0", contracts: "4.0.0" },
    prototypeUrl: () => null,
    runs: () => runs,
    usage: () => runs.at(-1)?.usage ?? new Map(),
    git: fakeGit,
  });
};

beforeAll(() => {
  repo = buildRepo();
  model = modelFor(repo);
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("golden replay: events.jsonl rebuilds every read route's snapshot (AD-7)", () => {
  it("loads one clean run", () => {
    const runs = loadRuns(repo);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.invalidLines).toEqual([]);
  });
  it("health", () => {
    expect(model.health()).toEqual(api("health"));
  });
  it("runs", () => {
    expect(model.runs()).toEqual(api("runs"));
  });
  it("status", () => {
    expect(body(model.status())).toEqual(api("status"));
  });
  it("events", () => {
    expect(body(model.events("golden-1", 0, EVENT_PAGE_LIMIT.default))).toEqual(api("events"));
  });
  it("tasks", () => {
    expect(body(model.tasks("golden-1"))).toEqual(api("tasks"));
  });
  it.each(["T-1", "T-2"])("task detail %s", (task) => {
    expect(body(model.task("golden-1", task))).toEqual(api(`task-${task}`));
  });
  it("task diff", async () => {
    expect(body(await model.taskDiff("golden-1", "T-1"))).toEqual(api("task-T-1-diff"));
  });
  it("features", () => {
    expect(body(model.features("golden-1"))).toEqual(api("features"));
  });
  it("artifact", () => {
    expect(body(model.artifact("golden-1", ".vtc/spec/spec.md"))).toEqual(api("artifact-spec"));
  });
  it("escalations", () => {
    expect(body(model.escalations("golden-1"))).toEqual(api("escalations"));
  });
  it("usage", () => {
    expect(model.usage()).toEqual(api("usage"));
  });
  it.each([
    ["project", undefined, "graph-project"],
    ["task_dag", undefined, "graph-task_dag"],
    ["task", "T-2", "graph-task-T-2"],
  ] as const)("graph scope %s", (scope, task, file) => {
    expect(body(model.graph("golden-1", scope, task))).toEqual(api(file));
  });
  it("every response validates as its route's contract", async () => {
    const checks: [keyof typeof ENGINE_HTTP.routes, unknown][] = [
      ["health", model.health()],
      ["status", body(model.status())],
      ["runs", model.runs()],
      ["runEvents", body(model.events("golden-1", 0, 10))],
      ["tasks", body(model.tasks("golden-1"))],
      ["task", body(model.task("golden-1", "T-1"))],
      ["taskDiff", body(await model.taskDiff("golden-1", "T-1"))],
      ["features", body(model.features("golden-1"))],
      ["graph", body(model.graph("golden-1", "task", "T-1"))],
      ["escalations", body(model.escalations("golden-1"))],
      ["usage", model.usage()],
    ];
    for (const [route, value] of checks) {
      const parsed = CONTRACT_SCHEMAS[ENGINE_HTTP.routes[route].response].safeParse(value);
      expect(parsed.success, `${route}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
  it("pages events with next_after", () => {
    const page = body(model.events("golden-1", 0, 10));
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(page.next_after).toBe(10);
    const last = body(model.events("golden-1", 40, 10));
    expect(last.events.map((e) => e.seq)).toEqual([41, 42, 43, 44]);
    expect(last.next_after).toBeNull();
  });
  it("answers unknown runs, tasks and scopes with not_found or bad_request", () => {
    expect(model.tasks("nope")).toMatchObject({ ok: false, code: "not_found" });
    expect(model.task("golden-1", "T-9")).toMatchObject({ ok: false, code: "not_found" });
    expect(model.graph("golden-1", "bogus", undefined)).toMatchObject({ ok: false, code: "bad_request" });
    expect(model.graph("golden-1", "task", undefined)).toMatchObject({ ok: false, code: "bad_request" });
    expect(model.events("golden-1", -1, 10)).toMatchObject({ ok: false, code: "bad_request" });
  });
  it("a replay with tampered plan-file frontmatter produces the same state (AD-7 rule 8)", () => {
    const tampered = buildRepo();
    try {
      mkdirSync(join(tampered, ".vtc/tasks"), { recursive: true });
      writeFileSync(
        join(tampered, ".vtc/tasks/T-2.md"),
        "---\nid: T-2\nstatus: done\ncap: 5\nround: 0\nbudget_usd: 99\n---\n\nhand edit\n",
      );
      const other = modelFor(tampered);
      expect(body(other.tasks("golden-1"))).toEqual(api("tasks"));
      expect(body(other.status())).toEqual(api("status"));
    } finally {
      rmSync(tampered, { recursive: true, force: true });
    }
  });
});
