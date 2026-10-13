"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type { EdgeState } from "@/lib/flows/graph";

export interface FlowEdgeData extends Record<string, unknown> {
  state: EdgeState;
  label: string | null;
}
export type StepFlowEdge = Edge<FlowEdgeData, "flow">;
export type LoopFlowEdge = Edge<FlowEdgeData, "loop">;

/** Pipeline edge (copied from bs-job-agents): accent once reached, flowing dashes while running. */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<StepFlowEdge>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const state = data?.state ?? "idle";
  return (
    <BaseEdge
      id={id}
      path={path}
      className={state === "running" ? "vtc-edge-running" : undefined}
      style={{
        stroke: state === "idle" ? "var(--border)" : "var(--accent)",
        strokeWidth: 2,
        strokeDasharray: state === "idle" ? "3 5" : undefined,
      }}
    />
  );
}

/**
 * The fix loop under the pipeline (§6.3 step 9): from the loop guard back to the node that runs
 * the next round, dashed, with what goes back (e.g. "findings → next round").
 */
export function LoopEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<LoopFlowEdge>) {
  const drop = 80;
  const path = `M${String(sourceX)},${String(sourceY)} C${String(sourceX)},${String(sourceY + drop)} ${String(targetX)},${String(targetY + drop)} ${String(targetX)},${String(targetY)}`;
  const state = data?.state ?? "idle";
  const stroke = state === "idle" ? "var(--border)" : "var(--warn)";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={state === "running" ? "vtc-edge-running" : undefined}
        style={{ stroke, strokeWidth: 2, strokeDasharray: "4 5" }}
      />
      {data?.label == null ? null : (
        <EdgeLabelRenderer>
          <span
            className="pointer-events-none absolute rounded-full border border-warn/50 bg-surface/90 px-2 py-0.5 text-[11px] whitespace-nowrap text-warn-fg"
            style={{
              transform: `translate(-50%, -50%) translate(${String((sourceX + targetX) / 2)}px, ${String(Math.max(sourceY, targetY) + drop * 0.75)}px)`,
            }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
