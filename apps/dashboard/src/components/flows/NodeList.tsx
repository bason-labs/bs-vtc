"use client";

import type { WorkflowGraph } from "@vtc/shared";
import { cn } from "@/lib/cn";
import { nodeStateMeta } from "@/lib/states";
import { StatusPill } from "@/components/ui";

/**
 * The same nodes as the canvas, as a list: the keyboard- and screen-reader-friendly view, and
 * the easy one on a phone.
 */
export function NodeList({
  graph,
  selected,
  onSelect,
}: {
  graph: WorkflowGraph;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ol aria-label="Nodes" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {graph.nodes.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            onClick={() => {
              onSelect(node.id);
            }}
            aria-pressed={selected === node.id}
            className={cn(
              "flex w-full items-start justify-between gap-2 rounded-2xl border border-border bg-surface/70 px-3 py-2 text-left text-sm transition hover:border-accent",
              selected === node.id && "ring-2 ring-accent",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{node.label}</span>
              <span className="block truncate text-[11px] text-muted-fg">{node.reason_added}</span>
            </span>
            <StatusPill meta={nodeStateMeta(node)} className="mt-0.5 shrink-0" />
          </button>
        </li>
      ))}
    </ol>
  );
}
