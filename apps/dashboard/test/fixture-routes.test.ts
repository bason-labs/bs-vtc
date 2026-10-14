import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureNameFor } from "../scripts/fixture-routes.ts";

const apiDir = resolve(import.meta.dirname, "../../../fixtures/golden-run/api");

describe("fixtureNameFor", () => {
  const cases: [string, string | null][] = [
    ["/api/health", "health"],
    ["/api/status", "status"],
    ["/api/runs", "runs"],
    ["/api/usage", "usage"],
    ["/api/spend", "client-spend"],
    ["/api/runs/golden-1/events?after=0&limit=500", "events"],
    ["/api/runs/golden-1/tasks", "tasks"],
    ["/api/runs/golden-1/tasks/T-1", "task-T-1"],
    ["/api/runs/golden-1/tasks/T-2", "task-T-2"],
    ["/api/runs/golden-1/tasks/T-1/diff", "task-T-1-diff"],
    ["/api/runs/golden-1/features", "features"],
    ["/api/runs/golden-1/escalations", "escalations"],
    ["/api/runs/golden-1/artifacts?path=.vtc%2Fspec%2Fspec.md", "artifact-spec"],
    ["/api/runs/golden-1/graph?scope=project", "graph-project"],
    ["/api/runs/golden-1/graph?scope=task_dag", "graph-task_dag"],
    ["/api/runs/golden-1/graph?scope=task&task=T-2", "graph-task-T-2"],
    ["/api/runs/other/tasks", null],
    ["/api/runs/golden-1/graph?scope=task&task=../x", null],
    ["/api/runs/golden-1/tasks/T-1/other", null],
    ["/api/runs/golden-1/artifacts?path=.vtc/state/x", null],
    ["/index.html", null],
  ];
  it.each(cases)("%s → %s", (url, name) => {
    expect(fixtureNameFor("GET", url)).toBe(name);
  });

  it("serves no write", () => {
    expect(fixtureNameFor("POST", "/api/runs")).toBeNull();
  });

  it("covers every fixture file", () => {
    const names = new Set(cases.map(([, n]) => n));
    const files = readdirSync(apiDir).map((f) => f.replace(/\.json$/, ""));
    expect(files.filter((f) => !names.has(f))).toEqual([]);
  });
});
