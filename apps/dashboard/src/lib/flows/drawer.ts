import type {
  Escalation,
  Finding,
  GateReport,
  RoleRunSummary,
  TaskDetail,
  TokenUsage,
  WorkflowNode,
} from "@vtc/shared";
import { parkText } from "../states";

/**
 * What the node drawer shows (§17 drill-down) for a node of one task's pipeline: role, round
 * n/cap, findings, evidence, role runs (prompt version, verdicts), gate reports, escalations and
 * where the transcript is, and a timeline of what happened at the node. Transcripts live in gitignored `.vtc/state/`, which the API never
 * serves (AD-5 rule 10), so the drawer names the host session instead of linking to the text.
 */
export interface NodeDrawerModel {
  readonly role: string | null;
  /** `n/cap`, or `null` when the node has no round. */
  readonly round: string | null;
  readonly parked: string | null;
  readonly tokens: string | null;
  readonly findings: readonly Finding[];
  readonly evidence: readonly string[];
  readonly roleRuns: readonly RoleRunSummary[];
  readonly gateReports: readonly GateReport[];
  readonly escalations: readonly Escalation[];
  readonly transcript: { readonly session: string | null; readonly location: ".vtc/state/" };
  /** What happened at this node, oldest first (§17 drill-down "timeline"). */
  readonly timeline: readonly TimelineEntry[];
}

export interface TimelineEntry {
  /** ISO time. */
  readonly at: string;
  readonly label: string;
  readonly detail: string | null;
}

/**
 * The node's timeline from the task detail it already has: its role runs (dispatched, with exit),
 * its gate runs (started, finished with verdict) and its escalations (raised, answered).
 */
const timelineFor = (
  roleRuns: readonly RoleRunSummary[],
  gateReports: readonly GateReport[],
  escalations: readonly Escalation[],
): TimelineEntry[] =>
  [
    ...roleRuns.map((r) => ({
      at: r.dispatched_at,
      label: `${r.role.replace(/_/g, " ")} dispatched`,
      detail: `${r.action_id} · ${r.host} · ${r.exit === null ? "in flight" : `exit ${r.exit}`}`,
    })),
    ...gateReports.flatMap((g) => [
      {
        at: g.started_at,
        label: `gates started (${g.reason.replace(/_/g, " ")})`,
        detail: `${g.scope} scope`,
      },
      { at: g.finished_at, label: `gates finished: ${g.verdict.replace(/_/g, " ")}`, detail: null },
    ]),
    ...escalations.flatMap((e) => [
      { at: e.created_at, label: `${e.id} raised`, detail: e.question },
      ...(e.answered_at === undefined
        ? []
        : [{ at: e.answered_at, label: `${e.id} answered`, detail: null }]),
    ]),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

const ratio = (round: number, cap: number): string => `${String(round)}/${String(cap)}`;

const tokensText = (t: TokenUsage | undefined): string | null =>
  t === undefined
    ? null
    : `${t.in.toLocaleString("en-US")} in · ${t.out.toLocaleString("en-US")} out · ${t.cache_r.toLocaleString("en-US")} cache read · ${t.cache_w.toLocaleString("en-US")} cache write`;

const findingsFor = (node: WorkflowNode, detail: TaskDetail | null): Finding[] => {
  const all = detail?.findings ?? [];
  switch (node.kind) {
    case "role":
      return all.filter((f) => f.source === "role" && f.source_name === node.role);
    case "gate":
      return all.filter((f) => f.source === "tool");
    case "loop_guard":
    case "park":
    case "router":
      return all.filter((f) => f.status === "open");
    default:
      return [];
  }
};

export const nodeDrawerModel = (node: WorkflowNode, detail: TaskDetail | null): NodeDrawerModel => {
  const findings = findingsFor(node, detail);
  const task = detail?.task;
  const round =
    node.round !== undefined && node.cap !== undefined
      ? ratio(node.round, node.cap)
      : task !== undefined && (node.kind === "role" || node.kind === "gate")
        ? ratio(task.round, task.cap)
        : null;
  const escalations =
    node.kind === "park" || node.kind === "loop_guard" || node.state === "parked"
      ? (detail?.escalations ?? [])
      : [];
  const evidence = new Set([
    ...findings.map((f) => `${f.evidence.type}: ${f.evidence.ref}`),
    ...escalations.flatMap((e) => e.evidence.map((ev) => `${ev.type}: ${ev.ref}`)),
  ]);
  const session = task?.session_ref;
  const roleRuns =
    node.role === undefined ? [] : (detail?.role_runs ?? []).filter((r) => r.role === node.role);
  const gateReports = node.kind === "gate" ? (detail?.gate_reports ?? []) : [];
  return {
    role: node.role ?? null,
    round,
    parked: node.park_reason === undefined ? null : parkText(node.park_reason, node.risk_rule),
    tokens: tokensText(node.tokens),
    findings,
    evidence: [...evidence],
    roleRuns,
    gateReports,
    escalations,
    transcript: {
      session: session === undefined ? null : `${session.host} session ${session.id}`,
      location: ".vtc/state/",
    },
    timeline: timelineFor(roleRuns, gateReports, escalations),
  };
};
