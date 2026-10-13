import { describe, expect, it } from "vitest";
import { routeUrl } from "@/lib/api/routes";

describe("routeUrl", () => {
  it("builds paths from ENGINE_HTTP with encoded params", () => {
    expect(routeUrl("task", { run: "golden-1", task: "T-2" })).toBe("/api/runs/golden-1/tasks/T-2");
    expect(routeUrl("taskDiff", { run: "golden-1", task: "T-1" })).toBe(
      "/api/runs/golden-1/tasks/T-1/diff",
    );
    expect(routeUrl("health")).toBe("/api/health");
  });

  it("adds the query string, skipping undefined values", () => {
    expect(routeUrl("graph", { run: "r1" }, { scope: "task", task: "T-2" })).toBe(
      "/api/runs/r1/graph?scope=task&task=T-2",
    );
    expect(routeUrl("graph", { run: "r1" }, { scope: "project", task: undefined })).toBe(
      "/api/runs/r1/graph?scope=project",
    );
    expect(routeUrl("artifact", { run: "r1" }, { path: ".vtc/spec/spec.md" })).toBe(
      "/api/runs/r1/artifacts?path=.vtc%2Fspec%2Fspec.md",
    );
  });

  it("refuses ids that would change the path", () => {
    expect(() => routeUrl("tasks", { run: "../health" })).toThrow(/run/);
    expect(() => routeUrl("task", { run: "r1", task: "T-1/diff" })).toThrow(/task/);
  });

  it("refuses a missing path parameter", () => {
    expect(() => routeUrl("tasks", {})).toThrow(/run/);
  });
});
