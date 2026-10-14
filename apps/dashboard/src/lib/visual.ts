import {
  isServableArtifactPath,
  parsePersisted,
  VisualReportSchema,
  type ArtifactContent,
  type ToolFinding,
  type VisualReport,
  type VisualStatus,
  type VisualSummary,
} from "@vtc/shared";
import type { StatusMeta } from "./states";

/**
 * Deterministic visual QA (spec §7.5, spine AD-24): the step's outcome on a gate report
 * (`GateReport.visual`) and its full evidence (`VisualReport` under `.vtc/evidence/`). "Unreached
 * is not clean": only `pass` counts as passed; `skipped` (no browser) and `unchecked` (a render or
 * axe item nobody could decide) are shown as not passed (spine §5 reading 105).
 */
export interface VisualStatusMeta extends StatusMeta {
  readonly passed: boolean;
}

const STATUS: Readonly<Record<VisualStatus, VisualStatusMeta>> = {
  pass: { label: "Passed", tone: "ok", passed: true },
  fail: { label: "Failed", tone: "danger", passed: false },
  unchecked: { label: "Not passed: unchecked", tone: "danger", passed: false },
  skipped: { label: "Not passed: skipped", tone: "warn", passed: false },
  error: { label: "Error: gate infrastructure", tone: "warn", passed: false },
};

export const visualStatusMeta = (status: VisualStatus): VisualStatusMeta => STATUS[status];

const NOTES: Readonly<Partial<Record<VisualStatus, string>>> = {
  unchecked:
    "A render or state was not reached, or axe could not decide an item: unreached is not clean, so this blocks like a failure.",
  skipped:
    "At merge levels 1 and 2 the task continues with this note; Level 3 never counts a skipped step as a pass.",
  error:
    "The browser did not match its pin or the runner crashed: gate infrastructure, not a verdict on the code.",
};

const COUNT_LABELS: Readonly<Record<keyof VisualSummary["counts"], string>> = {
  renders: "Renders",
  unreached: "Unreached",
  axe_violations: "Axe violations",
  axe_incomplete: "Axe needs review",
  style_mismatches: "Style mismatches",
  diffs_over_budget: "Diffs over budget",
  token_lint: "Token lint",
  detector: "Design detector",
};

export interface VisualSummaryModel {
  readonly status: VisualStatusMeta;
  readonly notes: readonly string[];
  readonly counts: readonly { label: string; value: number; bad: boolean }[];
  /** The full report, when the artifacts route can serve it. */
  readonly report: string | null;
  readonly findings: readonly ToolFinding[];
}

/** Why a step that did not pass did not, and what it means for the run. */
export const visualNotes = (status: VisualStatus, skippedReason?: string): string[] => {
  const note = NOTES[status];
  return [
    ...(skippedReason === undefined ? [] : [skippedReason]),
    ...(note === undefined ? [] : [note]),
  ];
};

export const visualSummaryModel = (summary: VisualSummary): VisualSummaryModel => {
  return {
    status: STATUS[summary.status],
    notes: visualNotes(summary.status, summary.skipped_reason),
    counts: (Object.keys(COUNT_LABELS) as (keyof VisualSummary["counts"])[]).map((key) => ({
      label: COUNT_LABELS[key],
      value: summary.counts[key],
      bad: key !== "renders" && summary.counts[key] > 0,
    })),
    report:
      summary.report !== null && isServableArtifactPath(summary.report) ? summary.report : null,
    findings: summary.findings,
  };
};

// ------------------------------------------------------------------ report

/** A `VisualReport` read through the artifacts route, or `null` for anything else. */
export const readVisualReport = (artifact: ArtifactContent): VisualReport | null => {
  if (
    artifact.encoding !== "utf8" ||
    !artifact.path.startsWith(".vtc/evidence/") ||
    !artifact.path.endsWith(".json")
  ) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(artifact.content);
  } catch {
    return null;
  }
  const parsed = parsePersisted(VisualReportSchema, raw);
  return parsed.success ? parsed.data : null;
};

interface RenderKey {
  readonly screen: string;
  readonly state: string;
  readonly width: number;
  readonly theme: string;
}

const splitKey = (key: string): RenderKey => {
  const [screen = "", state = "", width = "0", theme = ""] = key.split(":");
  return { screen, state, width: Number(width), theme };
};

export interface MatrixCell {
  readonly key: string;
  readonly label: string;
  readonly passed: boolean;
  readonly tone: StatusMeta["tone"];
  /** What keeps a rendered cell from passing. */
  readonly issues: readonly string[];
  readonly detail: string | null;
  readonly screenshot: string | null;
  readonly reference: string | null;
}

export interface RenderMatrix {
  readonly columns: readonly { key: string; label: string }[];
  readonly rows: readonly { key: string; label: string; cells: readonly MatrixCell[] }[];
  readonly summary: { readonly cells: number; readonly passed: number };
}

const count = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

const servable = (path: string | undefined): string | null =>
  path !== undefined && isServableArtifactPath(path) ? path : null;

const overBudget = (d: VisualReport["diffs"][number]): boolean =>
  d.dimension_mismatch || d.ratio_pct > d.budget_pct;

/**
 * The render matrix (§7.5 step 2): one row per screen and state, one column per width and
 * theme, each cell with what kept it from passing. A combination the report lacks was never
 * rendered, so it does not pass either.
 */
export const renderMatrix = (report: VisualReport): RenderMatrix => {
  const keys = [
    ...new Set([
      ...report.renders.map((r) => r.key),
      ...report.axe.map((a) => a.key),
      ...report.diffs.map((d) => d.key),
    ]),
  ].map((key) => ({ key, ...splitKey(key) }));
  const columns = [...new Map(keys.map((k) => [`${String(k.width)}:${k.theme}`, k])).values()]
    .sort((a, b) => a.width - b.width || a.theme.localeCompare(b.theme))
    .map((k) => ({
      key: `${String(k.width)}:${k.theme}`,
      label: `${String(k.width)} ${k.theme}`,
    }));
  const rowKeys = [...new Map(keys.map((k) => [`${k.screen}:${k.state}`, k])).values()].sort(
    (a, b) => a.screen.localeCompare(b.screen) || a.state.localeCompare(b.state),
  );
  const cell = (key: string): MatrixCell => {
    const render = report.renders.find((r) => r.key === key);
    const axe = report.axe.filter((a) => a.key === key);
    const violations = axe.reduce((n, a) => n + a.violations.length, 0);
    const incomplete = axe.reduce((n, a) => n + a.incomplete.length, 0);
    const styles = report.computed_style.filter((s) => s.key === key).length;
    const diffs = report.diffs.filter((d) => d.key === key && overBudget(d)).length;
    const issues = [
      ...(violations > 0 ? [count(violations, "axe violation")] : []),
      ...(incomplete > 0
        ? [count(incomplete, "axe item needs review", "axe items need review")]
        : []),
      ...(styles > 0 ? [count(styles, "style mismatch", "style mismatches")] : []),
      ...(diffs > 0 ? [count(diffs, "diff over budget", "diffs over budget")] : []),
    ];
    const base = {
      key,
      detail: render?.detail ?? null,
      screenshot: servable(render?.screenshot),
      reference: servable(render?.reference),
    };
    if (render === undefined) {
      return { ...base, label: "Not rendered", passed: false, tone: "danger", issues };
    }
    if (render.status === "unreached") {
      return { ...base, label: "Unreached", passed: false, tone: "danger", issues };
    }
    if (render.status === "error") {
      return { ...base, label: "Render error", passed: false, tone: "warn", issues };
    }
    return issues.length === 0
      ? { ...base, label: "Clean", passed: true, tone: "ok", issues }
      : { ...base, label: "Rendered", passed: false, tone: "danger", issues };
  };
  const rows = rowKeys.map((r) => ({
    key: `${r.screen}:${r.state}`,
    label: `${r.screen} · ${r.state}`,
    cells: columns.map((c) => cell(`${r.screen}:${r.state}:${c.key}`)),
  }));
  const cells = rows.flatMap((r) => r.cells);
  return {
    columns,
    rows,
    summary: { cells: cells.length, passed: cells.filter((c) => c.passed).length },
  };
};

export interface DiffRow {
  readonly key: string;
  readonly region: string;
  readonly overBudget: boolean;
  /** `1.4% of 0.5%`, or the dimension mismatch. */
  readonly ratio: string;
  readonly mismatchPx: number;
  readonly image: string | null;
}

/** Per-region pixel diffs against the approved prototype (§7.5 step 5), over budget first. */
export const visualDiffs = (report: VisualReport): DiffRow[] =>
  report.diffs
    .map((d) => ({
      key: d.key,
      region: d.region,
      overBudget: overBudget(d),
      ratio: d.dimension_mismatch
        ? "different dimensions (a layout finding)"
        : `${String(d.ratio_pct)}% of ${String(d.budget_pct)}%`,
      mismatchPx: d.mismatch_px,
      image: servable(d.diff_image),
    }))
    .sort((a, b) => Number(b.overBudget) - Number(a.overBudget));

// ------------------------------------------------------------------ images

const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A `data:` URL for a raster image the artifacts route returned base64-encoded (screenshots,
 * diff images), or `null`. SVG is never shown as an image: it is agent-written markup.
 */
export const imageDataUrl = (artifact: ArtifactContent): string | null =>
  artifact.encoding === "base64" && RASTER.has(artifact.media_type) && BASE64.test(artifact.content)
    ? `data:${artifact.media_type};base64,${artifact.content}`
    : null;
