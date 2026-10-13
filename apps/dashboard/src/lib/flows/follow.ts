// The flow canvas follows a live run (copied from bs-job-agents components/flows/follow.ts, with
// VTC node states). When nodes change it re-fits the view, but never below a zoom where a node's
// 14 px title stays readable; at that floor it centres on the node that needs attention. Pure maths.
import type { WorkflowNodeState } from "@vtc/shared";

/** 14 px titles × 0.8 = 11.2 px on screen. */
export const READABLE_ZOOM = 0.8;
/** A fit never zooms in past 1:1. */
export const MAX_FIT_ZOOM = 1;
/** Space around the graph in a fit, as a share of its size. */
export const FIT_PADDING = 0.15;
/** At the floor, the view stops this far (graph units) past the graph's first and last node. */
export const EDGE_PAD = 40;

export interface NodeBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly state: WorkflowNodeState;
}

export interface FollowView {
  readonly zoom: number;
  readonly center: { readonly x: number; readonly y: number };
}

const ACTIVE: readonly WorkflowNodeState[] = ["running", "looping"];
const ATTENTION: readonly WorkflowNodeState[] = ["parked", "interrupted"];
const NOT_STARTED: readonly WorkflowNodeState[] = ["waiting", "skipped", "dropped"];

/** The node to keep in view: running/looping, else parked/interrupted, else the furthest started. */
export function focusBox(nodes: readonly NodeBox[]): NodeBox | null {
  const first = nodes[0];
  if (first === undefined) return null;
  const active = nodes.find((n) => ACTIVE.includes(n.state));
  if (active) return active;
  const attention = nodes.find((n) => ATTENTION.includes(n.state));
  if (attention) return attention;
  const started = nodes.filter((n) => !NOT_STARTED.includes(n.state));
  if (started.length === 0) return first;
  return started.reduce((best, n) => (n.x > best.x ? n : best));
}

/** Centre on `target`, but keep the view inside [lo, hi] (the graph plus EDGE_PAD). */
function clampCenter(target: number, lo: number, hi: number, half: number): number {
  const min = lo - EDGE_PAD + half;
  const max = hi + EDGE_PAD - half;
  if (min > max) return (lo + hi) / 2;
  return Math.min(max, Math.max(min, target));
}

/** Where the canvas should look: a readable fit of the whole graph, or the focus node at the floor. */
export function followView(
  nodes: readonly NodeBox[],
  viewport: { width: number; height: number },
): FollowView | null {
  const focus = focusBox(nodes);
  if (focus === null || viewport.width <= 0 || viewport.height <= 0) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + n.height));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const fit = Math.min(
    viewport.width / (w * (1 + 2 * FIT_PADDING)),
    viewport.height / (h * (1 + 2 * FIT_PADDING)),
    MAX_FIT_ZOOM,
  );
  const middle = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  if (fit >= READABLE_ZOOM) return { zoom: fit, center: middle };
  const zoom = READABLE_ZOOM;
  return {
    zoom,
    center: {
      x: clampCenter(focus.x + focus.width / 2, minX, maxX, viewport.width / 2 / zoom),
      y: clampCenter(focus.y + focus.height / 2, minY, maxY, viewport.height / 2 / zoom),
    },
  };
}
