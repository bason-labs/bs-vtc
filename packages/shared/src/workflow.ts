/**
 * Flow graph for the flow composer and Flow Studio (§16 Workflow node, §17).
 * Rule: every cycle must pass through a `loop_guard` node (§16).
 */
import { z } from "zod";
import {
  ArtifactTypeSchema,
  RiskRuleReasonRuleSchema,
  RoleIdSchema,
  SlugSchema,
  TaskIdSchema,
  TokenUsageSchema,
} from "./primitives.js";
import { checkParkRiskRule, ParkReasonSchema } from "./task.js";

export const WorkflowNodeKindSchema = z.enum([
  "role",
  "gate",
  "human",
  "router",
  "fan_out",
  "join",
  "loop_guard",
  "park",
  "subflow",
]);
export type WorkflowNodeKind = z.infer<typeof WorkflowNodeKindSchema>;

/**
 * Node display states (§17). `looping` carries round/cap; `interrupted` = stopped by a usage
 * limit, waiting for the auto-resume (§6.8, §6.9). `skipped` = the node did not run and was not
 * needed (a reviewer on a trivial diff, §6.3 step 7; a gate whose `GateStatus` is `skipped`);
 * `dropped` = a task the human dropped (§6.5). Neither is ever shown as `passed` or `done`.
 *
 * Task nodes map from `TaskStatus`: draft/ready/waiting_dependency → waiting;
 * tests_authored/building/verifying → running; fixing → looping; built/queued/merged → passed;
 * done → done; parked → parked; interrupted → interrupted; dropped → dropped. Gate nodes map from
 * `GateStatus`: pass → passed, fail/error → looping (or parked when the task parked),
 * skipped → skipped.
 */
export const WorkflowNodeStateSchema = z.enum([
  "waiting",
  "running",
  "passed",
  "looping",
  "parked",
  "interrupted",
  "done",
  "skipped",
  "dropped",
]);
export type WorkflowNodeState = z.infer<typeof WorkflowNodeStateSchema>;

/** Flow Studio zoom levels (§17): project phases, task DAG, one task's pipeline. */
export const WorkflowScopeSchema = z.enum(["project", "task_dag", "task"]);
export type WorkflowScope = z.infer<typeof WorkflowScopeSchema>;

export const WorkflowNodeSchema = z
  .strictObject({
    id: SlugSchema,
    kind: WorkflowNodeKindSchema,
    label: z.string().min(1).max(120),
    role: RoleIdSchema.optional(),
    task: TaskIdSchema.optional(),
    ports_in: z.array(ArtifactTypeSchema).default([]),
    ports_out: z.array(ArtifactTypeSchema).default([]),
    /** Why the composer added this node (the router rule), shown in the UI (§17). */
    reason_added: z.string().min(1).max(300),
    state: WorkflowNodeStateSchema,
    round: z.int().nonnegative().optional(),
    cap: z.int().positive().optional(),
    park_reason: ParkReasonSchema.optional(),
    /** The §7.6 rule 1–9 that parked the node; only with `park_reason: risk_rule`. */
    risk_rule: RiskRuleReasonRuleSchema.optional(),
    tokens: TokenUsageSchema.optional(),
    /** For `subflow` nodes: the id of the nested graph. */
    subflow: SlugSchema.optional(),
  })
  .superRefine((node, ctx) => {
    if (node.kind === "role" && node.role === undefined) {
      ctx.addIssue({ code: "custom", path: ["role"], message: "role nodes must name the role" });
    }
    if (node.kind === "subflow" && node.subflow === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["subflow"],
        message: "subflow nodes need a subflow id",
      });
    }
    if (node.state === "looping" && (node.round === undefined || node.cap === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["round"],
        message: "looping nodes need round and cap",
      });
    }
    if (node.state === "parked" && node.park_reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["park_reason"],
        message: "parked nodes need a reason",
      });
    }
    checkParkRiskRule(node, ctx);
  });
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z.strictObject({
  id: SlugSchema,
  from: SlugSchema,
  to: SlugSchema,
  /** Artifact type carried along this edge, if any. */
  artifact: ArtifactTypeSchema.optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export interface GraphShape {
  readonly nodes: readonly Pick<WorkflowNode, "id" | "kind">[];
  readonly edges: readonly Pick<WorkflowEdge, "id" | "from" | "to">[];
}

/**
 * Returns the node ids of one cycle that does not pass through a `loop_guard`, or `null` if
 * every cycle is guarded. Equivalent check: with all loop_guard nodes removed, the graph is a DAG.
 */
export const findUnguardedCycle = (graph: GraphShape): string[] | null => {
  const guarded = new Set(graph.nodes.filter((n) => n.kind === "loop_guard").map((n) => n.id));
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) if (!guarded.has(node.id)) adjacency.set(node.id, []);
  for (const edge of graph.edges) {
    if (guarded.has(edge.from) || guarded.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
  }
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, GREY);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) return stack.slice(stack.indexOf(next));
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };
  for (const id of adjacency.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
};

export const WorkflowGraphSchema = z
  .strictObject({
    id: SlugSchema,
    scope: WorkflowScopeSchema,
    nodes: z.array(WorkflowNodeSchema).min(1),
    edges: z.array(WorkflowEdgeSchema).default([]),
  })
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    graph.nodes.forEach((node, i) => {
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", i, "id"],
          message: `duplicate node ${node.id}`,
        });
      }
      ids.add(node.id);
    });
    const edgeIds = new Set<string>();
    graph.edges.forEach((edge, i) => {
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", i, "id"],
          message: `duplicate edge ${edge.id}`,
        });
      }
      edgeIds.add(edge.id);
      for (const end of ["from", "to"] as const) {
        if (!ids.has(edge[end])) {
          ctx.addIssue({
            code: "custom",
            path: ["edges", i, end],
            message: `edge ${edge.id} references unknown node ${edge[end]}`,
          });
        }
      }
    });
    const cycle = findUnguardedCycle(graph);
    if (cycle) {
      ctx.addIssue({
        code: "custom",
        path: ["edges"],
        message: `back-edge without a loop_guard: ${cycle.join(" → ")}`,
      });
    }
  });
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;
