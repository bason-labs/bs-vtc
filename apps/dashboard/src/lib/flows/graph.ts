import { Graph, layout } from "@dagrejs/dagre";
import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowNodeState } from "@vtc/shared";
import { nodeStateMeta, type StatusMeta } from "../states";

/**
 * The flow canvas model (§17): a `WorkflowGraph` from the engine, laid out left to right with
 * dagre, ready for React Flow. Pure, so it is unit-tested; FlowCanvas only renders it.
 *
 * Every cycle passes through a `loop_guard` (§16). Edges that close a cycle (found by DFS in the
 * engine's node order) are drawn as loops under the nodes and kept out of the layout, so the
 * pipeline reads left to right with its fix loop underneath.
 */
export const NODE_SIZE = { width: 216, height: 112 } as const;

export type EdgeState = "lit" | "running" | "idle";

export interface FlowNodeData extends Record<string, unknown> {
  readonly node: WorkflowNode;
  readonly meta: StatusMeta;
}

export interface FlowNodeModel {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly data: FlowNodeData;
}

export interface FlowEdgeModel {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "flow" | "loop";
  readonly state: EdgeState;
  /** Shown on loop edges (what goes back, e.g. findings). */
  readonly label: string | null;
}

export interface FlowModel {
  readonly nodes: readonly FlowNodeModel[];
  readonly edges: readonly FlowEdgeModel[];
}

/** Ids of the edges that close a cycle, by DFS over the engine's node and edge order. */
export const backEdgeIds = (graph: Pick<WorkflowGraph, "nodes" | "edges">): Set<string> => {
  const out = new Map<string, WorkflowEdge[]>();
  for (const node of graph.nodes) out.set(node.id, []);
  for (const edge of graph.edges) out.get(edge.from)?.push(edge);
  const color = new Map<string, "grey" | "black">();
  const back = new Set<string>();
  const visit = (id: string): void => {
    color.set(id, "grey");
    for (const edge of out.get(id) ?? []) {
      const c = color.get(edge.to);
      if (c === "grey") back.add(edge.id);
      else if (c === undefined) visit(edge.to);
    }
    color.set(id, "black");
  };
  const incoming = new Set(graph.edges.map((e) => e.to));
  // Roots first (nodes nothing points at), then anything left (a cycle with no entry).
  for (const node of graph.nodes) if (!incoming.has(node.id) && !color.has(node.id)) visit(node.id);
  for (const node of graph.nodes) if (!color.has(node.id)) visit(node.id);
  return back;
};

const IDLE: readonly WorkflowNodeState[] = ["waiting", "skipped", "dropped"];

const flowEdgeState = (target: WorkflowNode | undefined): EdgeState => {
  if (target === undefined || IDLE.includes(target.state)) return "idle";
  return target.state === "running" ? "running" : "lit";
};

const loopEdgeState = (guard: WorkflowNode | undefined): EdgeState => {
  if (guard === undefined) return "idle";
  if (guard.state === "looping") return "running";
  return (guard.round ?? 0) > 1 ? "lit" : "idle";
};

export const buildFlow = (graph: Pick<WorkflowGraph, "nodes" | "edges">): FlowModel => {
  const back = backEdgeIds(graph);
  const g = new Graph();
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 64, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) g.setNode(node.id, { ...NODE_SIZE });
  for (const edge of graph.edges) if (!back.has(edge.id)) g.setEdge(edge.from, edge.to);
  layout(g);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = graph.nodes.map((node): FlowNodeModel => {
    const { x, y } = g.node(node.id) as { x: number; y: number };
    return {
      id: node.id,
      position: { x: Math.round(x - NODE_SIZE.width / 2), y: Math.round(y - NODE_SIZE.height / 2) },
      width: NODE_SIZE.width,
      height: NODE_SIZE.height,
      data: { node, meta: nodeStateMeta(node) },
    };
  });
  const edges = graph.edges.map((edge): FlowEdgeModel => {
    const loop = back.has(edge.id);
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      kind: loop ? "loop" : "flow",
      state: loop ? loopEdgeState(byId.get(edge.from)) : flowEdgeState(byId.get(edge.to)),
      label: loop ? `${edge.artifact ?? "back"} → next round` : null,
    };
  });
  return { nodes, edges };
};
