import {
  EVIDENCE_MODE_PARAM,
  EVIDENCE_MODE_VALUES,
  PHASES,
  type WorkflowGraph,
  type WorkflowNode,
} from "@vtc/shared";

/**
 * Evidence mode (spine AD-27 rule 6, §5 readings 199 and 208): the dashboard as the evidence
 * recorder captures it for an automatic PR, from a loopback snapshot server.
 *
 * - `?evidence=1` (`full`): every view, read-only (no design-review pin, no write of any kind),
 *   no request outside the page's own origin (no prototype iframe), free text tagged with
 *   `data-vtc-redact` so the recorder paints it out, and a deterministic replay speed: no ticking
 *   clock, no animation or transition, and the canvas moves without easing; live events mark
 *   views stale on the invalidation bus's fixed 250 ms flush, so the only pace is the one the
 *   snapshot server replays the events at.
 * - `?evidence=upstream`: only the upstream-safe projection (D-by) for a bs-vtc PR caused by a
 *   project run: the flow with role ids instead of node labels and task ordinals instead of ids,
 *   metrics, scorecards and replay arms. No titles, paths, diffs or repo names.
 *
 * The mode stays on while the recorder navigates ({@link withEvidenceParam}).
 */
export type EvidenceMode = "off" | "full" | "upstream";

/** The query parameter the evidence recorder opens the dashboard with (contracts 5.1.0). */
export const EVIDENCE_PARAM = EVIDENCE_MODE_PARAM;

export const evidenceModeOf = (search: string): EvidenceMode => {
  const value = new URLSearchParams(search).get(EVIDENCE_PARAM);
  if (value === EVIDENCE_MODE_VALUES.full) return "full";
  if (value === EVIDENCE_MODE_VALUES.upstream) return "upstream";
  return "off";
};

/** `href` with the evidence parameter of `currentSearch` added, when that names a mode. */
export const withEvidenceParam = (href: string, currentSearch: string): string => {
  const mode = evidenceModeOf(currentSearch);
  if (mode === "off") return href;
  const url = new URL(href, "http://flow.studio");
  if (url.searchParams.has(EVIDENCE_PARAM)) return href;
  url.searchParams.set(EVIDENCE_PARAM, EVIDENCE_MODE_VALUES[mode]);
  return `${url.pathname}${url.search}${url.hash}`;
};

/** The views (`router.ts` `View`) the upstream-safe projection shows: the flow and Lookback. */
const UPSTREAM_VIEWS: ReadonlySet<string> = new Set(["run", "lookback", "not_found"]);

export const viewShownIn = (mode: EvidenceMode, view: string): boolean =>
  mode !== "upstream" || UPSTREAM_VIEWS.has(view);

const PHASE_IDS: ReadonlySet<string> = new Set(PHASES);

/** A label from VTC's own vocabulary: the role id, a backbone phase, `task n`, or the kind. */
const upstreamLabel = (node: WorkflowNode, taskOrdinal: number | null): string => {
  if (node.role !== undefined) return node.role;
  const phase = node.id.replaceAll("-", "_");
  if (node.task === undefined && PHASE_IDS.has(phase)) return phase;
  if (taskOrdinal !== null && node.kind === "subflow") return `task ${String(taskOrdinal)}`;
  return node.kind;
};

/**
 * The upstream-safe projection of a flow graph (D-by, spine §5 reading 208): node labels become
 * role ids (or a backbone phase, `task n`, or the node kind), task ids become ordinals, node and
 * edge ids become ordinals, and every free-text field is dropped. States, rounds, caps, park
 * reasons, ports and tokens (VTC-side facts and metrics) stay.
 */
export const upstreamGraph = (graph: WorkflowGraph): WorkflowGraph => {
  const tasks = new Map<string, number>();
  for (const n of graph.nodes)
    if (n.task !== undefined && !tasks.has(n.task)) tasks.set(n.task, tasks.size + 1);
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `n${String(i + 1)}`]));
  const id = (old: string): string => ids.get(old) ?? "n0";
  return {
    id: "upstream",
    scope: graph.scope,
    nodes: graph.nodes.map((n) => ({
      id: id(n.id),
      kind: n.kind,
      label: upstreamLabel(n, n.task === undefined ? null : (tasks.get(n.task) ?? null)),
      ...(n.role === undefined ? {} : { role: n.role }),
      ports_in: n.ports_in,
      ports_out: n.ports_out,
      reason_added: "",
      state: n.state,
      ...(n.round === undefined ? {} : { round: n.round }),
      ...(n.cap === undefined ? {} : { cap: n.cap }),
      ...(n.park_reason === undefined ? {} : { park_reason: n.park_reason }),
      ...(n.risk_rule === undefined ? {} : { risk_rule: n.risk_rule }),
      ...(n.tokens === undefined ? {} : { tokens: n.tokens }),
    })),
    edges: graph.edges.map((e, i) => ({
      id: `e${String(i + 1)}`,
      from: id(e.from),
      to: id(e.to),
      ...(e.artifact === undefined ? {} : { artifact: e.artifact }),
    })),
  };
};
