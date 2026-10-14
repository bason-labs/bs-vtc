/**
 * Turns what the visual runner rendered into the visual step's verdict (§7.5, AD-24 rules 3–4):
 * the `VisualReport` written to evidence, the `VisualSummary` on the `GateReport`, and one
 * `ToolFinding` per problem with a `VISUAL_RULE_PREFIX` rule id. Pure.
 *
 * Status, most serious first: `error` (the runner failed as a whole), `fail` (a blocking
 * finding: an axe violation, a computed style off the tokens, a region over its pixel budget or
 * with other dimensions, token lint, a non-advisory detector rule), `unchecked` (a render, a
 * requested screen or a check that was not reached, or an axe `incomplete` item: "unreached is
 * not clean"), `pass`.
 *
 * Every finding's `location` is stable across gate runs: `DESIGN_SCREENS_PATH` with the screen
 * state, render key, region, selector or note as the symbol, never a per-attempt evidence file
 * (the attempt id changes every run, and triage fingerprints a finding by its location, so a
 * waiver, a deferral or the "reappeared" signal would never match the next round). The
 * screenshot or diff image of this run stays in `evidence.ref`.
 */
import {
  DESIGN_SCREENS_PATH,
  VISUAL_RULE_PREFIX,
  VisualReportSchema,
  VisualSummarySchema,
  type ToolFinding,
  type VisualReport,
  type VisualStatus,
  type VisualSummary,
} from "@vtc/shared";
import { deltaE, parseCssColor, toOklab } from "./color.js";
import type { RenderJob } from "./matrix.js";
import type { RunnerAxeItem, RunnerResult } from "./protocol.js";
import { lengthPx, nearestColor, onScale, type DesignTokens } from "./tokens.js";

/** `visualConfigFor(config.visual)`. */
export interface VisualSettings {
  readonly widths: readonly number[];
  readonly themes: readonly ("light" | "dark")[];
  readonly region_budget_pct: number;
  readonly color_delta: number;
  readonly pixel_threshold: number;
  readonly axe_tags: readonly string[];
  readonly include_best_practice: boolean;
  readonly dynamic_regions: readonly string[];
}

export interface BrowserIdentity {
  readonly name: string;
  readonly version: string;
  readonly executable_sha256: string;
}

/** Where the runner's files land in evidence (repo-relative), by the runner's file name. */
export type EvidencePathOf = (file: string) => string;

export interface EvaluateInput {
  readonly run: string;
  readonly task?: string | undefined;
  readonly feature?: string | undefined;
  readonly settings: VisualSettings;
  /** `null`: no `tokens.json`, so computed styles are not compared. */
  readonly tokens: DesignTokens | null;
  readonly jobs: readonly RenderJob[];
  /** Requested screens `screens.yaml` does not have. */
  readonly missingScreens: readonly string[];
  readonly result: RunnerResult;
  readonly browser: BrowserIdentity | null;
  readonly sourceHash: (key: string) => string;
  readonly evidencePath: EvidencePathOf;
  readonly tokenLint: readonly ToolFinding[];
  readonly detector: readonly ToolFinding[];
  /** Checks that could not run (no axe-core, no pixelmatch, no screens file…): never clean. */
  readonly notRun: readonly string[];
  /** Visible, non-blocking notes (a browser pinned on first use, evidence left out). */
  readonly notes?: readonly string[];
  /** Where the report itself is written (repo-relative). */
  readonly reportPath: string;
  readonly writtenAt: string;
}

export interface VisualOutcome {
  readonly report: VisualReport;
  readonly summary: VisualSummary;
}

/** Most findings a summary carries (the report has all of them, up to {@link MAX_REPORT_FINDINGS}). */
export const MAX_SUMMARY_FINDINGS = 200;
const MAX_REPORT_FINDINGS = 2000;
const VISUAL_TOOL = "vtc-visual";
const AXE_TOOL = "axe-core";
/** Rule id of a visible, non-blocking note of the step (`sarif_level: note`). */
export const VISUAL_NOTE_RULE = "vtc-visual/note";

/** One note-level finding per note (never blocking, never a pass by itself). */
export const noteFindings = (notes: readonly string[], reportPath: string): ToolFinding[] =>
  [...new Set(notes)].map((note) => ({
    tool: VISUAL_TOOL,
    rule_id: VISUAL_NOTE_RULE,
    category: "design",
    title: note.slice(0, 200),
    message: note.slice(0, 4000),
    location: { path: DESIGN_SCREENS_PATH, symbol: `note: ${note}`.slice(0, 512) },
    evidence: { type: "command_output", ref: reportPath },
    sarif_level: "note",
  }));

const COLOR_PROPERTIES = new Set(["color", "background-color", "border-top-color"]);
const SPACING_PROPERTIES = new Set(["padding", "margin", "gap"]);

/** Whether a finding fails the step (unreached markers and notes do not). */
const isBlocking = (f: ToolFinding): boolean =>
  f.rule_id !== VISUAL_RULE_PREFIX.unreached &&
  f.sarif_level !== "note" &&
  f.sarif_level !== "none";

const screenState = (key: string): string => key.split(":").slice(0, 2).join(":");

const axeEntry = (item: RunnerAxeItem): VisualReport["axe"][number]["violations"][number] => ({
  rule: item.rule,
  impact: item.impact,
  help: item.help,
  nodes: item.nodes,
});

interface StyleMismatch {
  readonly key: string;
  readonly selector: string;
  readonly property: string;
  readonly value: string;
  readonly nearest_token: string | null;
  readonly delta: number;
}

/** A computed style that is not on the tokens, or `null` when it is (or cannot be judged). */
export const styleMismatch = (
  tokens: DesignTokens,
  colorDelta: number,
  style: { key: string; selector: string; property: string; value: string },
): StyleMismatch | null => {
  const { property, value } = style;
  if (COLOR_PROPERTIES.has(property)) {
    const rgba = parseCssColor(value);
    if (rgba === null || rgba.a === 0 || tokens.colors.length === 0) return null;
    const near = nearestColor(tokens, toOklab(rgba), deltaE);
    if (near === null || near.delta <= colorDelta) return null;
    return {
      ...style,
      nearest_token: near.token.name.slice(0, 200),
      delta: Number(near.delta.toFixed(4)),
    };
  }
  if (property === "font-family") {
    if (tokens.fonts.length === 0) return null;
    const first =
      value
        .split(",")[0]
        ?.trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase() ?? "";
    const token = tokens.fonts.find((f) => f.families.includes(first));
    return token === undefined ? { ...style, nearest_token: null, delta: 1 } : null;
  }
  const lengthsOf = (scale: DesignTokens["lengths"]): StyleMismatch | null => {
    if (scale.length === 0) return null;
    for (const part of value.split(/\s+/)) {
      const px = lengthPx(part);
      if (px === null || px === 0 || (property === "border-radius" && px >= 999)) continue;
      const { ok, nearest } = onScale(scale, Math.abs(px));
      if (!ok) {
        return {
          ...style,
          nearest_token: nearest?.name.slice(0, 200) ?? null,
          delta:
            nearest === null
              ? Math.abs(px)
              : Number(Math.abs(nearest.px - Math.abs(px)).toFixed(2)),
        };
      }
    }
    return null;
  };
  if (property === "border-radius") {
    return lengthsOf(tokens.radii.length > 0 ? tokens.radii : tokens.lengths);
  }
  if (property === "font-size" || SPACING_PROPERTIES.has(property))
    return lengthsOf(tokens.lengths);
  return null;
};

export const evaluateVisual = (input: EvaluateInput): VisualOutcome => {
  const { settings, result } = input;
  const byKey = new Map(result.renders.map((r) => [r.key, r]));
  const renders: VisualReport["renders"] = [];
  const axe: VisualReport["axe"] = [];
  const styles: StyleMismatch[] = [];
  const diffs: VisualReport["diffs"] = [];
  const findings: ToolFinding[] = [];
  const unreachedBy = new Map<string, string[]>();
  const axeBy = new Map<string, { item: RunnerAxeItem; keys: string[]; shot: string | null }>();
  const incompleteBy = new Map<
    string,
    { item: RunnerAxeItem; keys: string[]; shot: string | null }
  >();
  const notRun = [...input.notRun];

  for (const job of input.jobs) {
    const out = byKey.get(job.key);
    let status: "rendered" | "unreached" | "error" = out?.status ?? "error";
    let detail = out === undefined ? "the visual runner did not report this render" : out.detail;
    if (
      status === "rendered" &&
      out?.reference !== undefined &&
      out.reference.status !== "rendered"
    ) {
      status = "unreached";
      detail = `the approved prototype did not render: ${out.reference.detail ?? out.reference.status}`;
    }
    const screenshot =
      out?.screenshot === undefined ? undefined : input.evidencePath(out.screenshot);
    const reference =
      out?.reference?.screenshot === undefined
        ? undefined
        : input.evidencePath(out.reference.screenshot);
    renders.push({
      key: job.key,
      status,
      ...(screenshot === undefined ? {} : { screenshot }),
      ...(reference === undefined ? {} : { reference }),
      source_hash: input.sourceHash(job.key),
      ...(detail === undefined || detail === "" ? {} : { detail: detail.slice(0, 500) }),
    });
    if (status !== "rendered") {
      const list = unreachedBy.get(screenState(job.key)) ?? [];
      list.push(job.key);
      unreachedBy.set(screenState(job.key), list);
      continue;
    }
    if (out === undefined) continue;
    if (out.axe === null) notRun.push(`axe did not run on ${job.key}`);
    else {
      axe.push({
        key: job.key,
        violations: out.axe.violations.map(axeEntry),
        incomplete: out.axe.incomplete.map(axeEntry),
      });
      for (const item of out.axe.violations) {
        const id = `${screenState(job.key)}\u0000${item.rule}`;
        const entry = axeBy.get(id) ?? { item, keys: [], shot: screenshot ?? null };
        entry.keys.push(job.key);
        axeBy.set(id, entry);
      }
      for (const item of out.axe.incomplete) {
        const id = `${screenState(job.key)}\u0000${item.rule}`;
        const entry = incompleteBy.get(id) ?? { item, keys: [], shot: screenshot ?? null };
        entry.keys.push(job.key);
        incompleteBy.set(id, entry);
      }
    }
    if (input.tokens !== null) {
      for (const style of out.styles) {
        const mismatch = styleMismatch(input.tokens, settings.color_delta, {
          key: job.key,
          ...style,
        });
        if (mismatch !== null) styles.push(mismatch);
      }
    }
    if (out.reference !== undefined && out.diffs.length === 0) {
      notRun.push(`no region was compared on ${job.key}`);
    }
    for (const d of out.diffs) {
      const ratio = d.total_px === 0 ? 0 : Math.min(100, (d.mismatch_px / d.total_px) * 100);
      const diffImage = d.diff_image === undefined ? undefined : input.evidencePath(d.diff_image);
      diffs.push({
        key: job.key,
        region: d.region,
        mismatch_px: d.mismatch_px,
        ratio_pct: Number(ratio.toFixed(4)),
        budget_pct: settings.region_budget_pct,
        dimension_mismatch: d.dimension_mismatch,
        ...(diffImage === undefined ? {} : { diff_image: diffImage }),
      });
    }
  }

  // ---------------------------------------------------------------- findings
  for (const [state, keys] of unreachedBy) {
    findings.push({
      tool: VISUAL_TOOL,
      rule_id: VISUAL_RULE_PREFIX.unreached,
      category: "design",
      title: `Not rendered: ${state} (${String(keys.length)} of its renders)`.slice(0, 200),
      message: `Unreached is not clean (§7.5): ${keys.join(", ")}`.slice(0, 4000),
      location: { path: DESIGN_SCREENS_PATH, symbol: state },
      evidence: { type: "command_output", ref: input.reportPath },
      sarif_level: "warning",
    });
  }
  for (const screen of input.missingScreens) {
    findings.push({
      tool: VISUAL_TOOL,
      rule_id: VISUAL_RULE_PREFIX.unreached,
      category: "design",
      title: `Requested screen ${screen} is not in screens.yaml`.slice(0, 200),
      location: { path: DESIGN_SCREENS_PATH, symbol: screen },
      evidence: { type: "command_output", ref: input.reportPath },
      sarif_level: "warning",
    });
  }
  for (const { item, keys, shot } of axeBy.values()) {
    findings.push({
      tool: AXE_TOOL,
      rule_id: `${VISUAL_RULE_PREFIX.axe}${item.rule}`,
      category: "accessibility",
      title: item.help.slice(0, 200),
      message:
        `${String(item.nodes)} element(s), e.g. ${item.targets.join(" | ") || "(no selector)"}; renders: ${keys.join(", ")}`.slice(
          0,
          4000,
        ),
      location: { path: DESIGN_SCREENS_PATH, symbol: screenState(keys[0] ?? "") },
      evidence:
        shot === null
          ? { type: "command_output", ref: input.reportPath }
          : { type: "screenshot", ref: shot },
      ...(item.targets[0] === undefined ? {} : { snippet: item.targets[0] }),
      label: item.impact ?? "moderate",
    });
  }
  // AD-24 rule 4: an incomplete item is never clean; a note-level finding names what needs review.
  for (const { item, keys, shot } of incompleteBy.values()) {
    findings.push({
      tool: AXE_TOOL,
      rule_id: `${VISUAL_RULE_PREFIX.axe}${item.rule}`,
      category: "accessibility",
      title: `Needs review (axe incomplete): ${item.help}`.slice(0, 200),
      message:
        `axe could not decide ${String(item.nodes)} element(s), e.g. ${item.targets.join(" | ") || "(no selector)"}; renders: ${keys.join(", ")}. The step stays unchecked until a human or the vision judge reviews it.`.slice(
          0,
          4000,
        ),
      location: {
        path: DESIGN_SCREENS_PATH,
        symbol: `${screenState(keys[0] ?? "")} (needs review)`,
      },
      evidence:
        shot === null
          ? { type: "command_output", ref: input.reportPath }
          : { type: "screenshot", ref: shot },
      ...(item.targets[0] === undefined ? {} : { snippet: item.targets[0] }),
      sarif_level: "note",
    });
  }
  const styleGroups = new Map<string, StyleMismatch[]>();
  for (const s of styles) {
    const id = `${s.property}\u0000${s.value}`;
    styleGroups.set(id, [...(styleGroups.get(id) ?? []), s]);
  }
  for (const group of styleGroups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const shot = renders.find((r) => r.key === first.key)?.screenshot;
    findings.push({
      tool: VISUAL_TOOL,
      rule_id: `${VISUAL_RULE_PREFIX.computedStyle}${first.property}`,
      category: "design",
      title: `Computed ${first.property} ${first.value} is not a design token`.slice(0, 200),
      message:
        `nearest token ${first.nearest_token ?? "(none)"}, Δ ${String(first.delta)}; seen on ${String(group.length)} element(s), first ${first.selector} on ${first.key}`.slice(
          0,
          4000,
        ),
      location: { path: DESIGN_SCREENS_PATH, symbol: first.selector.slice(0, 512) },
      evidence:
        shot === undefined
          ? { type: "command_output", ref: input.reportPath }
          : { type: "screenshot", ref: shot },
      snippet: `${first.property}: ${first.value}`,
      sarif_level: "warning",
    });
  }
  for (const d of diffs) {
    if (!d.dimension_mismatch && d.ratio_pct <= d.budget_pct) continue;
    findings.push({
      tool: VISUAL_TOOL,
      rule_id: `${VISUAL_RULE_PREFIX.layoutDiff}${d.dimension_mismatch ? "dimensions" : "pixels"}`,
      category: "design",
      title: (d.dimension_mismatch
        ? `Region ${d.region} has other dimensions than the approved prototype on ${d.key}`
        : `Region ${d.region} differs from the approved prototype by ${String(d.ratio_pct)}% on ${d.key}`
      ).slice(0, 200),
      message: `budget ${String(d.budget_pct)}%, ${String(d.mismatch_px)} px differ`,
      location: { path: DESIGN_SCREENS_PATH, symbol: `${d.key} ${d.region}`.slice(0, 512) },
      evidence:
        d.diff_image === undefined
          ? { type: "command_output", ref: input.reportPath }
          : { type: "screenshot", ref: d.diff_image },
      sarif_level: "warning",
    });
  }
  findings.push(...input.tokenLint, ...input.detector);
  findings.push(...noteFindings(input.notes ?? [], input.reportPath));

  // ------------------------------------------------------------------ status
  const blocking = findings.some(isBlocking);
  const unreached = renders.filter((r) => r.status !== "rendered").length;
  const incomplete = axe.reduce((n, a) => n + a.incomplete.length, 0);
  const nothingChecked = input.jobs.length === 0;
  if (nothingChecked && input.missingScreens.length === 0) notRun.push("no screen to render");
  let status: VisualStatus;
  if (result.error !== undefined) status = "error";
  else if (blocking) status = "fail";
  else if (
    unreached > 0 ||
    incomplete > 0 ||
    input.missingScreens.length > 0 ||
    notRun.length > 0
  ) {
    status = "unchecked";
  } else status = "pass";

  if (notRun.length > 0) {
    findings.push({
      tool: VISUAL_TOOL,
      rule_id: VISUAL_RULE_PREFIX.unreached,
      category: "design",
      title: `Visual checks not run: ${notRun[0] ?? ""}`.slice(0, 200),
      message: [...new Set(notRun)].join("; ").slice(0, 4000),
      location: { path: DESIGN_SCREENS_PATH, symbol: "checks not run" },
      evidence: { type: "command_output", ref: input.reportPath },
      sarif_level: "warning",
    });
  }

  const report = VisualReportSchema.parse({
    v: 1,
    run: input.run,
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.feature === undefined || input.task !== undefined ? {} : { feature: input.feature }),
    status,
    browser: input.browser,
    renders,
    axe,
    computed_style: styles.slice(0, 2000),
    diffs,
    findings: findings.slice(0, MAX_REPORT_FINDINGS),
    written_at: input.writtenAt,
  });
  const summary = VisualSummarySchema.parse({
    status,
    report: input.reportPath,
    counts: {
      renders: renders.length,
      unreached,
      axe_violations: axe.reduce((n, a) => n + a.violations.length, 0),
      axe_incomplete: incomplete,
      style_mismatches: styles.length,
      diffs_over_budget: diffs.filter((d) => d.dimension_mismatch || d.ratio_pct > d.budget_pct)
        .length,
      token_lint: input.tokenLint.length,
      detector: input.detector.length,
    },
    findings: findings.slice(0, MAX_SUMMARY_FINDINGS),
  });
  return { report, summary };
};

const ZERO_COUNTS: VisualSummary["counts"] = {
  renders: 0,
  unreached: 0,
  axe_violations: 0,
  axe_incomplete: 0,
  style_mismatches: 0,
  diffs_over_budget: 0,
  token_lint: 0,
  detector: 0,
};

/**
 * The outcome of a step that rendered nothing: `skipped` (no browser, D-ay: with the reason) or
 * `error` (the browser pin did not match, the runner failed: gate infrastructure, §6.8). Token
 * lint and detector findings need no browser and are kept: when one of them blocks, a skipped
 * step is `fail` (the skip reason goes into a finding), so the Engineer still gets them.
 */
export const visualWithoutRenders = (input: {
  readonly run: string;
  readonly task?: string | undefined;
  readonly feature?: string | undefined;
  readonly status: "skipped" | "error";
  readonly reason: string;
  readonly browser: BrowserIdentity | null;
  readonly findings: readonly ToolFinding[];
  readonly reportPath: string;
  readonly writtenAt: string;
  readonly counts?: Partial<VisualSummary["counts"]>;
  /** Visible, non-blocking notes ({@link noteFindings}). */
  readonly notes?: readonly string[];
}): VisualOutcome => {
  const reason = input.reason.slice(0, 500);
  const findings = [...input.findings, ...noteFindings(input.notes ?? [], input.reportPath)];
  const status: VisualStatus =
    input.status === "skipped" && findings.some(isBlocking) ? "fail" : input.status;
  if (status !== "skipped") {
    findings.push({
      tool: VISUAL_TOOL,
      rule_id: VISUAL_RULE_PREFIX.unreached,
      category: "design",
      title: `${input.status === "error" ? "Visual step failed" : "Not rendered"}: ${reason}`.slice(
        0,
        200,
      ),
      location: {
        path: DESIGN_SCREENS_PATH,
        symbol: input.status === "error" ? "visual step failed" : "not rendered",
      },
      evidence: { type: "command_output", ref: input.reportPath },
      sarif_level: "warning",
    });
  }
  const skipped = status === "skipped" ? { skipped_reason: reason } : {};
  const report = VisualReportSchema.parse({
    v: 1,
    run: input.run,
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.feature === undefined || input.task !== undefined ? {} : { feature: input.feature }),
    status,
    ...skipped,
    browser: input.browser,
    findings: findings.slice(0, MAX_REPORT_FINDINGS),
    written_at: input.writtenAt,
  });
  const summary = VisualSummarySchema.parse({
    status,
    report: input.reportPath,
    ...skipped,
    counts: { ...ZERO_COUNTS, ...input.counts },
    findings: findings.slice(0, MAX_SUMMARY_FINDINGS),
  });
  return { report, summary };
};
