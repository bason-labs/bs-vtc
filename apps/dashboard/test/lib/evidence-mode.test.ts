import { afterEach, describe, expect, it } from "vitest";
import { WorkflowGraphSchema, type WorkflowGraph } from "@vtc/shared";
import { evidenceModeOf, upstreamGraph, viewShownIn, withEvidenceParam } from "@/lib/evidence-mode";
import { navigate } from "@/lib/router";
import { readFixture } from "../fixtures";

const graph = (name: string): WorkflowGraph => WorkflowGraphSchema.parse(readFixture(name));

describe("evidenceModeOf (?evidence=1|upstream)", () => {
  it.each([
    ["?evidence=1", "full"],
    ["?run=r&evidence=upstream", "upstream"],
    ["?evidence=0", "off"],
    ["?evidence=yes", "off"],
    ["", "off"],
  ])("%s → %s", (search, mode) => {
    expect(evidenceModeOf(search)).toBe(mode);
  });
});

describe("withEvidenceParam (the mode stays on while the recorder navigates)", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("carries the current mode to the next address", () => {
    expect(withEvidenceParam("/run/?run=r&zoom=tasks", "?evidence=upstream")).toBe(
      "/run/?run=r&zoom=tasks&evidence=upstream",
    );
    expect(withEvidenceParam("/usage/", "?evidence=1")).toBe("/usage/?evidence=1");
    expect(withEvidenceParam("/usage/", "")).toBe("/usage/");
    expect(withEvidenceParam("/usage/?evidence=1", "?evidence=upstream")).toBe(
      "/usage/?evidence=1",
    );
  });

  it("is applied by navigate", () => {
    window.history.replaceState(null, "", "/run/?run=golden-1&evidence=upstream");
    navigate("/lookback/?run=golden-1");
    expect(window.location.search).toBe("?run=golden-1&evidence=upstream");
  });
});

describe("viewShownIn", () => {
  it("shows every view in full evidence mode, only the projection's in upstream mode", () => {
    expect(viewShownIn("full", "artifact")).toBe(true);
    expect(viewShownIn("upstream", "run")).toBe(true);
    expect(viewShownIn("upstream", "lookback")).toBe(true);
    for (const view of [
      "runs",
      "task",
      "feature",
      "escalations",
      "usage",
      "artifact",
      "design",
      "gates",
      "research",
      "automation",
    ] as const)
      expect(viewShownIn("upstream", view), view).toBe(false);
  });
});

describe("upstreamGraph (D-by, spine §5 reading 208)", () => {
  it("names role nodes by role id and drops every label, reason and task id", () => {
    const projected = upstreamGraph(graph("graph-task-T-2"));
    const text = JSON.stringify(projected);
    for (const n of graph("graph-task-T-2").nodes) {
      if (n.role === undefined) continue;
      expect(projected.nodes.some((p) => p.label === n.role)).toBe(true);
    }
    expect(text).not.toContain("T-2");
    expect(text).not.toContain("REQ-");
    expect(text).not.toContain("§");
    expect(projected.nodes.every((n) => n.reason_added === "")).toBe(true);
    expect(projected.id).toBe("upstream");
  });

  it("shows tasks as ordinals and keeps states, rounds and tokens", () => {
    const source = graph("graph-task_dag");
    const projected = upstreamGraph(source);
    const labels = projected.nodes.map((n) => n.label);
    expect(labels.filter((l) => l.startsWith("task "))).toEqual(
      source.nodes
        .filter((n) => n.task !== undefined && n.role === undefined)
        .map((_n, i) => `task ${String(i + 1)}`),
    );
    expect(projected.nodes.map((n) => n.state)).toEqual(source.nodes.map((n) => n.state));
    expect(projected.edges).toHaveLength(source.edges.length);
    for (const e of projected.edges) {
      expect(projected.nodes.some((n) => n.id === e.from)).toBe(true);
      expect(projected.nodes.some((n) => n.id === e.to)).toBe(true);
    }
    for (const t of source.nodes.flatMap((n) => (n.task === undefined ? [] : [n.task])))
      expect(JSON.stringify(projected)).not.toContain(`"${t}"`);
  });

  it("keeps VTC's own backbone phase names", () => {
    const labels = upstreamGraph(graph("graph-project")).nodes.map((n) => n.label);
    expect(labels).toContain("intake");
    expect(labels).toContain("final_review");
    expect(labels).toContain("g1");
  });
});
