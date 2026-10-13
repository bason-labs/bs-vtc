import { describe, expect, it } from "vitest";
import { WorkflowGraphSchema, type WorkflowGraph } from "@vtc/shared";
import { buildFlow, NODE_SIZE } from "@/lib/flows/graph";
import { readFixture } from "../../fixtures";

const graph = (name: string): WorkflowGraph => WorkflowGraphSchema.parse(readFixture(name));

describe("buildFlow", () => {
  it("lays the project phases out left to right in backbone order", () => {
    const flow = buildFlow(graph("graph-project"));
    const xs = flow.nodes.map((n) => n.position.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(flow.nodes.map((n) => n.position.y)).size).toBe(1);
    expect(flow.edges.every((e) => e.kind === "flow")).toBe(true);
  });

  it("draws the loop_guard back-edge as a loop, not as a forward edge", () => {
    const flow = buildFlow(graph("graph-task-T-2"));
    const loop = flow.edges.filter((e) => e.kind === "loop");
    expect(loop.map((e) => e.id)).toEqual(["loop-guard-engineer"]);
    expect(loop[0]).toMatchObject({
      source: "loop-guard",
      target: "engineer",
      label: "findings → next round",
    });
    const x = (id: string) => flow.nodes.find((n) => n.id === id)!.position.x;
    expect(x("qa-author")).toBeLessThan(x("engineer"));
    expect(x("engineer")).toBeLessThan(x("loop-guard"));
    expect(x("loop-guard")).toBeLessThan(x("park"));
  });

  it("lights edges by the state of the node they lead to", () => {
    const flow = buildFlow(graph("graph-project"));
    const state = (id: string) => flow.edges.find((e) => e.id === id)!.state;
    expect(state("g2-plan")).toBe("lit");
    expect(state("plan-build")).toBe("running");
    expect(state("build-integrate")).toBe("idle");
  });

  it("keeps the contract node on each flow node", () => {
    const flow = buildFlow(graph("graph-task_dag"));
    const t2 = flow.nodes.find((n) => n.id === "t-2")!;
    expect(t2.data.node.park_reason).toBe("cap");
    expect(t2.data.meta.label).toBe("Parked: round cap");
    expect(t2.width).toBe(NODE_SIZE.width);
  });

  it("marks the loop as active while the guard loops", () => {
    const g = graph("graph-task-T-2");
    const looping: WorkflowGraph = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "loop-guard"
          ? { ...n, state: "looping", park_reason: undefined, round: 2, cap: 4 }
          : n,
      ),
    };
    expect(buildFlow(looping).edges.find((e) => e.kind === "loop")?.state).toBe("running");
  });

  it("is deterministic", () => {
    expect(buildFlow(graph("graph-task-T-2"))).toEqual(buildFlow(graph("graph-task-T-2")));
  });
});
