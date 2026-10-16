import {
  GateLayerSchema,
  isServableArtifactPath,
  type GateLayer,
  type GateReport,
  type GateResult,
  type GateStatus,
  type ToolFinding,
} from "@vtc/shared";
import type { StatusMeta } from "./states";

/** What each deterministic layer checks (§7.2). */
export const LAYER_LABELS: Readonly<Record<GateLayer, string>> = {
  L0: "Build, typecheck",
  L1: "Lint on changed files",
  L2: "Tests",
  L3: "Diff coverage",
  L4: "Security and supply chain",
  L5: "Test integrity, write scope",
  L6: "Architecture fitness",
};

const STATUS: Readonly<Record<GateStatus, StatusMeta>> = {
  pass: { label: "Passed", tone: "ok" },
  fail: { label: "Failed", tone: "danger" },
  error: { label: "Error", tone: "warn" },
  skipped: { label: "Skipped", tone: "neutral" },
};

/** Worst first: a layer shows the worst status among its gates. */
const SEVERITY: readonly GateStatus[] = ["fail", "error", "pass", "skipped"];

export interface GateResultRow {
  readonly id: string;
  readonly status: StatusMeta;
  readonly blocking: boolean;
  /** One line each: violations, failure class, test counts, coverage, regressions, duration. */
  readonly details: readonly string[];
  /** The redacted report, when the artifacts route can serve it (AD-5 rule 10). */
  readonly report: { readonly path: string; readonly format: string } | null;
  readonly findings: readonly ToolFinding[];
  /** What the result passed with but the human should know (H-14 `after_scripts`, reading 251). */
  readonly warnings: readonly string[];
}

export interface GateLayerGroup {
  readonly layer: GateLayer;
  readonly label: string;
  readonly status: StatusMeta;
  readonly results: readonly GateResultRow[];
}

export interface GateReportModel {
  readonly title: string;
  readonly verdict: StatusMeta;
  /** `base..head`, short shas. */
  readonly range: string;
  readonly duration: string;
  readonly traceability: string | null;
  readonly layers: readonly GateLayerGroup[];
}

const words = (id: string): string => id.replace(/_/g, " ");
const sentence = (id: string): string => {
  const w = words(id);
  return `${w.charAt(0).toUpperCase()}${w.slice(1)}`;
};

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

const pct = (value: number | null): string =>
  value === null ? "not measured" : `${String(value)}%`;

/** `850 ms`, `3.9 s`, `1 min 30 s`. */
export const formatGateDuration = (ms: number): string => {
  if (ms < 1000) return `${String(ms)} ms`;
  if (ms < 60_000) return `${String(Math.round(ms / 100) / 10)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds)} s`;
};

const resultDetails = (r: GateResult): string[] => {
  if (r.status === "skipped") return [`Skipped: ${r.skipped_reason ?? "no reason given"}`];
  const lines: string[] = [];
  if (r.new_violations > 0 || r.baseline_violations > 0) {
    lines.push(
      `${plural(r.new_violations, "new violation")} · ${String(r.baseline_violations)} in the baseline`,
    );
  }
  if (r.failure_class !== undefined) lines.push(`Failure class: ${r.failure_class}`);
  if (r.tests !== undefined) {
    const t = r.tests;
    lines.push(
      `${String(t.executed)} executed · ${String(t.skipped)} skipped · ${String(t.failed)} failed`,
    );
    lines.push(
      `Line coverage ${pct(t.line_coverage_pct)} · diff coverage ${pct(t.diff_coverage_pct)}`,
    );
  }
  if (r.monotonic.length > 0) {
    const what = r.monotonic.map((m) =>
      m.test === undefined ? words(m.kind) : `${words(m.kind)} (${m.test})`,
    );
    lines.push(`Got worse: ${what.join(", ")}`);
  }
  lines.push(formatGateDuration(r.duration_ms));
  return lines;
};

/** The tool-integrity warning of a gate whose tools were hashed only after an install's scripts. */
export const AFTER_SCRIPTS_WARNING =
  "Tools hashed only after an install's scripts ran: what those scripts wrote before the hash is not checked (H-14). An install VTC can run scripts-free removes this warning.";

const resultWarnings = (r: GateResult): string[] =>
  r.tool?.baseline === "after_scripts" ? [AFTER_SCRIPTS_WARNING] : [];

const servable = (path: string | undefined): string | null =>
  path !== undefined && isServableArtifactPath(path) ? path : null;

const row = (r: GateResult): GateResultRow => ({
  id: r.gate_id,
  status: STATUS[r.status],
  blocking: r.blocking,
  details: resultDetails(r),
  report:
    r.report === undefined || servable(r.report.path) === null
      ? null
      : { path: r.report.path, format: r.report.format },
  findings: r.findings,
  warnings: resultWarnings(r),
});

const worst = (results: readonly GateResult[]): StatusMeta => {
  const status = SEVERITY.find((s) => results.some((r) => r.status === s)) ?? "skipped";
  return STATUS[status];
};

const verdictMeta = (report: GateReport): StatusMeta => {
  if (report.expect === "fail") {
    return report.verdict === "fail"
      ? { label: "Failed as expected", tone: "ok" }
      : report.verdict === "pass"
        ? { label: "Passed, expected to fail", tone: "danger" }
        : { label: "Infrastructure error", tone: "warn" };
  }
  switch (report.verdict) {
    case "pass":
      return { label: "Passed", tone: "ok" };
    case "fail":
      return { label: "Failed", tone: "danger" };
    case "infra_error":
      return { label: "Infrastructure error", tone: "warn" };
  }
};

/** One Gate Runner invocation for the drawer (§17 drill-down "gate reports"), grouped by layer. */
export const gateReportModel = (report: GateReport): GateReportModel => {
  const layers = GateLayerSchema.options.flatMap((layer): GateLayerGroup[] => {
    const results = report.results
      .filter((r) => r.layer === layer)
      .sort((a, b) => a.gate_id.localeCompare(b.gate_id));
    return results.length === 0
      ? []
      : [{ layer, label: LAYER_LABELS[layer], status: worst(results), results: results.map(row) }];
  });
  const title = [
    sentence(report.reason),
    report.scope,
    ...(report.expect === "fail" ? ["expected to fail"] : []),
  ].join(" · ");
  return {
    title,
    verdict: verdictMeta(report),
    range: `${report.base.slice(0, 7)}..${report.head.slice(0, 7)}`,
    duration: formatGateDuration(Date.parse(report.finished_at) - Date.parse(report.started_at)),
    traceability: servable(report.traceability),
    layers,
  };
};
