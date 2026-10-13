"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { WorkflowNodeKind } from "@vtc/shared";
import {
  Bot,
  CircleStop,
  GitFork,
  GitMerge,
  Layers,
  Repeat,
  Route,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { FlowNodeData } from "@/lib/flows/graph";
import type { Tone } from "@/lib/states";

const KIND: Readonly<Record<WorkflowNodeKind, { icon: LucideIcon; label: string }>> = {
  role: { icon: Bot, label: "Role" },
  gate: { icon: ShieldCheck, label: "Gate" },
  human: { icon: UserRound, label: "Human gate" },
  router: { icon: Route, label: "Router" },
  fan_out: { icon: GitFork, label: "Fan-out" },
  join: { icon: GitMerge, label: "Join" },
  loop_guard: { icon: Repeat, label: "Loop guard" },
  park: { icon: CircleStop, label: "Park" },
  subflow: { icon: Layers, label: "Subflow" },
};

const TONE_TEXT: Readonly<Record<Tone, string>> = {
  neutral: "text-muted-fg",
  brand: "text-brand dark:text-accent-fg",
  accent: "text-accent-fg",
  ok: "text-ok",
  warn: "text-warn-fg",
  danger: "text-danger",
};

/** The eyebrow of a node: its role, or its kind. */
export const nodeEyebrow = (data: FlowNodeData): string =>
  data.node.role === undefined
    ? KIND[data.node.kind].label
    : `${KIND[data.node.kind].label} · ${data.node.role}`;

const tokensTotal = (data: FlowNodeData): string | null => {
  const t = data.node.tokens;
  if (t === undefined) return null;
  const total = t.in + t.out + t.cache_r + t.cache_w;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${String(total)} tok`;
};

/**
 * A node on the canvas (§17 node display): kind and role, state (running ring, looping n/cap,
 * parked with its reason, waiting for a usage limit), label, why the composer added it, tokens.
 * A real button, so keyboard users can open the drawer.
 */
export function StepNodeCard({
  data,
  selected = false,
  onSelect,
}: {
  data: FlowNodeData;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { node, meta } = data;
  const Icon = KIND[node.kind].icon;
  const idle = node.state === "waiting" || node.state === "skipped" || node.state === "dropped";
  const tokens = tokensTotal(data);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`node-${node.id}`}
      data-state={node.state}
      aria-label={`${node.label}, ${meta.label}. Added because: ${node.reason_added}`}
      aria-pressed={selected}
      className={cn(
        "nodrag nopan flex h-[112px] w-[216px] flex-col rounded-2xl border bg-surface/95 p-3 text-left text-sm backdrop-blur transition hover:border-accent",
        node.state === "running" ? "vtc-node-running" : "border-border",
        node.state === "looping" && "vtc-node-looping",
        node.state === "interrupted" && "vtc-node-waiting-limit",
        node.state === "parked" && "vtc-node-parked",
        idle && "border-dashed opacity-75",
        node.state === "dropped" && "line-through",
        selected && "ring-2 ring-accent",
      )}
    >
      <span className="flex items-center justify-between gap-2 text-[11px] tracking-wide text-muted-fg uppercase">
        <span className="flex min-w-0 items-center gap-1">
          <Icon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{nodeEyebrow(data)}</span>
        </span>
        <span className={cn("shrink-0 font-medium normal-case", TONE_TEXT[meta.tone])}>
          {meta.label}
        </span>
      </span>
      <span className="mt-1 line-clamp-1 font-medium">{node.label}</span>
      <span className="mt-0.5 line-clamp-2 text-[11px] text-muted-fg">{node.reason_added}</span>
      {node.round !== undefined || tokens !== null ? (
        <span className="mt-auto flex gap-2 text-[11px] text-muted-fg tabular">
          {node.round !== undefined && node.cap !== undefined ? (
            <span>
              round {node.round}/{node.cap}
            </span>
          ) : null}
          {tokens === null ? null : <span>{tokens}</span>}
        </span>
      ) : null}
    </button>
  );
}

export type StepFlowNode = Node<FlowNodeData & { onSelect: () => void }, "step">;

/** React Flow wrapper: in/out handles, and the bottom handles loop edges use. */
export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const lit = data.node.state === "passed" || data.node.state === "done";
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2 !min-h-0 !min-w-0 !opacity-0"
      />
      <StepNodeCard data={data} selected={selected} onSelect={data.onSelect} />
      <Handle
        type="source"
        position={Position.Right}
        className={cn(
          "!size-3 !min-h-0 !min-w-0 !ring-2 !ring-[var(--surface)]",
          lit ? "!bg-accent" : "!bg-surface-3",
        )}
      />
      <Handle
        id="loop-out"
        type="source"
        position={Position.Bottom}
        style={{ left: "30%" }}
        className="!size-1 !min-h-0 !min-w-0 !opacity-0"
      />
      <Handle
        id="loop-in"
        type="target"
        position={Position.Bottom}
        style={{ left: "70%" }}
        className="!size-1 !min-h-0 !min-w-0 !opacity-0"
      />
    </>
  );
}
