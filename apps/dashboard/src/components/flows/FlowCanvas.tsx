"use client";

import "@xyflow/react/dist/base.css";
import "./flows.css";
import {
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
} from "@xyflow/react";
import type { WorkflowGraph } from "@vtc/shared";
import { Maximize, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { focusBox, followView } from "@/lib/flows/follow";
import { buildFlow, type FlowNodeData } from "@/lib/flows/graph";
import { IconButton } from "@/components/ui";
import { FlowEdge, LoopEdge, type FlowEdgeData } from "./Edges";
import { StepNode, type StepFlowNode } from "./StepNode";

const nodeTypes = { step: StepNode };
const edgeTypes = { flow: FlowEdge, loop: LoopEdge };

/** Our own zoom buttons, bound to React Flow's viewport (copied from bs-job-agents). */
function ZoomControls({ onManual, onFit }: { onManual: () => void; onFit: () => void }) {
  const { zoomIn, zoomOut } = useReactFlow();
  return (
    <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-2xl border border-border bg-surface/90 p-1 backdrop-blur-md">
      <IconButton
        size="sm"
        label="Zoom in"
        icon={<Plus aria-hidden />}
        onClick={() => {
          onManual();
          void zoomIn();
        }}
      />
      <IconButton
        size="sm"
        label="Zoom out"
        icon={<Minus aria-hidden />}
        onClick={() => {
          onManual();
          void zoomOut();
        }}
      />
      <IconButton size="sm" label="Fit to screen" icon={<Maximize aria-hidden />} onClick={onFit} />
    </div>
  );
}

/** Keeps a live run in view until the viewer pans or zooms; "Fit to screen" follows again. */
function FollowRun({
  following,
  focusId,
  fitTick,
}: {
  following: RefObject<boolean>;
  focusId: string | null;
  fitTick: number;
}) {
  const rf = useReactFlow<StepFlowNode>();
  const width = useStore((st) => st.width);
  const height = useStore((st) => st.height);
  const nodeCount = useStore((st) => st.nodes.length);
  const first = useRef(true);
  useEffect(() => {
    if (!following.current) return;
    const boxes = rf.getNodes().map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      width: n.measured?.width ?? 216,
      height: n.measured?.height ?? 112,
      state: n.data.node.state,
    }));
    const view = followView(boxes, { width, height });
    if (!view) return;
    void rf.setCenter(view.center.x, view.center.y, {
      zoom: view.zoom,
      duration: first.current ? 0 : 400,
    });
    first.current = false;
  }, [rf, following, nodeCount, focusId, fitTick, width, height]);
  return null;
}

export interface FlowCanvasProps {
  readonly graph: WorkflowGraph;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  /** Accessible name of the canvas region, e.g. "Pipeline of T-2". */
  readonly label: string;
}

/**
 * Live n8n-style flow graph (§17): the engine's `WorkflowGraph` laid out left to right, the fix
 * loop underneath, the running ring and status minimap. Read-only: nodes cannot be dragged or
 * connected; a click (or Enter on the focused node) opens the drawer.
 */
export function FlowCanvas({ graph, selected, onSelect, label }: FlowCanvasProps) {
  const flow = useMemo(() => buildFlow(graph), [graph]);
  const following = useRef(true);
  const [fitTick, setFitTick] = useState(0);
  const refit = useCallback(() => {
    following.current = true;
    setFitTick((t) => t + 1);
  }, []);
  const focusId = useMemo(
    () =>
      focusBox(
        flow.nodes.map((n) => ({
          id: n.id,
          ...n.position,
          width: n.width,
          height: n.height,
          state: n.data.node.state,
        })),
      )?.id ?? null,
    [flow],
  );
  const nodes: Node<FlowNodeData & { onSelect: () => void }, "step">[] = useMemo(
    () =>
      flow.nodes.map((n) => ({
        id: n.id,
        type: "step" as const,
        position: n.position,
        data: {
          ...n.data,
          onSelect: () => {
            onSelect(n.id);
          },
        },
        selected: n.id === selected,
        initialWidth: n.width,
        initialHeight: n.height,
      })),
    [flow, selected, onSelect],
  );
  const edges: Edge<FlowEdgeData>[] = useMemo(
    () =>
      flow.edges.map((e) =>
        e.kind === "loop"
          ? {
              id: e.id,
              source: e.source,
              target: e.target,
              sourceHandle: "loop-out",
              targetHandle: "loop-in",
              type: "loop",
              data: { state: e.state, label: e.label },
            }
          : {
              id: e.id,
              source: e.source,
              target: e.target,
              type: "flow",
              data: { state: e.state, label: null },
            },
      ),
    [flow],
  );

  return (
    <div
      role="region"
      aria-label={label}
      className="vtc-flow bg-grid relative h-[56vh] min-h-[320px] overflow-hidden rounded-3xl border border-border bg-surface/40 sm:h-[62vh]"
      data-testid="flow-canvas"
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onMoveStart={(event) => {
            // A pan or zoom by the viewer (programmatic moves have no event) stops following.
            if (event) following.current = false;
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          minZoom={0.25}
          maxZoom={1.5}
          proOptions={{ hideAttribution: false }}
          attributionPosition="top-right"
        >
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            className="!hidden sm:!block"
            ariaLabel="Minimap"
            nodeClassName={(n) => `vtc-mm vtc-mm-${(n.data as FlowNodeData).node.state}`}
          />
          <ZoomControls
            onManual={() => {
              following.current = false;
            }}
            onFit={refit}
          />
          <FollowRun following={following} focusId={focusId} fitTick={fitTick} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
