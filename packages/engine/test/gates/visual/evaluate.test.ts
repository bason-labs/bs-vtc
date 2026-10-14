import { describe, expect, it } from "vitest";
import {
  VISUAL_SKIPPED_NO_BROWSER,
  VisualReportSchema,
  VisualSummarySchema,
  visualConfigFor,
  type ToolFinding,
} from "@vtc/shared";
import {
  evaluateVisual,
  MAX_SUMMARY_FINDINGS,
  ranOnProjectToolchain,
  styleMismatch,
  VISUAL_NOTE_RULE,
  VISUAL_PROJECT_TOOLCHAIN_RULE,
  visualWithoutRenders,
  type EvaluateInput,
} from "../../../src/gates/visual/evaluate.js";
import { expandMatrix, parseScreens } from "../../../src/gates/visual/matrix.js";
import { RunnerResultSchema, type RunnerResult } from "../../../src/gates/visual/protocol.js";
import { parseDesignTokens } from "../../../src/gates/visual/tokens.js";

const SHA = "a".repeat(64);
const tokens = parseDesignTokens(
  JSON.stringify({
    color: { $type: "color", ink: { $value: "#111111" }, paper: { $value: "#ffffff" } },
    space: { $type: "dimension", s: { $value: "8px" }, m: { $value: "16px" } },
    font: { body: { $type: "fontFamily", $value: "Söhne" } },
  }),
);
const screens = parseScreens("screens:\n  - id: home\n    route: /\n");
const settings = { ...visualConfigFor(undefined), widths: [390], themes: ["light" as const] };
const { jobs } = expandMatrix(screens, [], settings);
const KEY = "home:default:390:light";

const rendered = (extra: Record<string, unknown> = {}): RunnerResult =>
  RunnerResultSchema.parse({
    v: 1,
    browser: { name: "chromium", version: "140.0" },
    renders: [
      {
        key: KEY,
        status: "rendered",
        screenshot: "home_default_390_light.png",
        reference: { status: "rendered", screenshot: "home_default_390_light.ref.png" },
        axe: { violations: [], incomplete: [] },
        styles: [
          { selector: "body", property: "color", value: "rgb(17, 17, 17)" },
          { selector: "main", property: "padding", value: "16px 8px" },
        ],
        diffs: [{ region: "main", mismatch_px: 10, total_px: 100000 }],
        ...extra,
      },
    ],
  });

const input = (result: RunnerResult, extra: Partial<EvaluateInput> = {}): EvaluateInput => ({
  run: "r1",
  task: "T-1",
  settings,
  tokens,
  jobs,
  missingScreens: [],
  result,
  browser: { name: "chromium", version: "140.0", executable_sha256: SHA },
  sourceHash: () => SHA,
  evidencePath: (file) => `.vtc/evidence/T-1/visual/${file}`,
  tokenLint: [],
  detector: [],
  notRun: [],
  reportPath: ".vtc/evidence/T-1/visual/report.json",
  writtenAt: "2026-10-14T08:00:00.000Z",
  ...extra,
});

const ruleIds = (findings: readonly ToolFinding[]): string[] => findings.map((f) => f.rule_id);

describe("evaluateVisual", () => {
  it("passes when every render is reached, axe is clean, styles are tokens and diffs fit", () => {
    const { report, summary } = evaluateVisual(input(rendered()));
    expect(summary.status).toBe("pass");
    expect(VisualReportSchema.parse(report)).toEqual(report);
    expect(VisualSummarySchema.parse(summary)).toEqual(summary);
    expect(report.renders[0]).toMatchObject({
      key: KEY,
      status: "rendered",
      screenshot: ".vtc/evidence/T-1/visual/home_default_390_light.png",
      reference: ".vtc/evidence/T-1/visual/home_default_390_light.ref.png",
      source_hash: SHA,
    });
    expect(summary.counts).toMatchObject({ renders: 1, unreached: 0, diffs_over_budget: 0 });
  });

  it("fails on an axe violation, with one accessibility finding per rule and screen state", () => {
    const { summary } = evaluateVisual(
      input(
        rendered({
          axe: {
            violations: [
              {
                rule: "color-contrast",
                impact: "serious",
                help: "Contrast",
                nodes: 3,
                targets: [".x"],
              },
            ],
            incomplete: [],
          },
        }),
      ),
    );
    expect(summary.status).toBe("fail");
    const f = summary.findings.find((x) => x.rule_id === "axe/color-contrast");
    expect(f).toMatchObject({
      tool: "axe-core",
      category: "accessibility",
      label: "serious",
      evidence: { type: "screenshot", ref: ".vtc/evidence/T-1/visual/home_default_390_light.png" },
    });
  });

  it("is unchecked, never pass, for an axe incomplete item or an unreached render", () => {
    const incomplete = evaluateVisual(
      input(
        rendered({
          axe: {
            violations: [],
            incomplete: [
              {
                rule: "color-contrast",
                impact: null,
                help: "Review",
                nodes: 1,
                targets: ["#hero"],
              },
            ],
          },
        }),
      ),
    );
    expect(incomplete.summary.status).toBe("unchecked");
    expect(incomplete.summary.counts.axe_incomplete).toBe(1);
    const review = incomplete.summary.findings.find((x) => x.rule_id === "axe/color-contrast");
    expect(review).toMatchObject({
      tool: "axe-core",
      sarif_level: "note",
      snippet: "#hero",
      location: { symbol: "home:default (needs review)" },
    });
    expect(review?.title).toMatch(/Needs review/);
    expect(review?.message).toMatch(/home:default:390:light/);

    const unreached = evaluateVisual(
      input(rendered({ status: "unreached", detail: "HTTP 404", screenshot: undefined })),
    );
    expect(unreached.summary.status).toBe("unchecked");
    expect(unreached.summary.counts.unreached).toBe(1);
    expect(ruleIds(unreached.summary.findings)).toContain("vtc-visual/unreached");

    const noReference = evaluateVisual(
      input(rendered({ reference: { status: "unreached", detail: "no prototype" } })),
    );
    expect(noReference.report.renders[0]?.status).toBe("unreached");
    expect(noReference.report.renders[0]?.detail).toMatch(/approved prototype/);
  });

  it("fails on computed styles off the tokens and on diffs over budget or of other dimensions", () => {
    const { report, summary } = evaluateVisual(
      input(
        rendered({
          styles: [
            { selector: "h1", property: "color", value: "rgb(255, 0, 0)" },
            { selector: "p", property: "color", value: "rgb(255, 0, 0)" },
            { selector: "main", property: "padding", value: "13px" },
          ],
          diffs: [
            { region: "main", mismatch_px: 5000, total_px: 100000, diff_image: "d.png" },
            { region: "nav", mismatch_px: 0, total_px: 0, dimension_mismatch: true },
          ],
        }),
      ),
    );
    expect(summary.status).toBe("fail");
    expect(report.computed_style).toHaveLength(3);
    expect(ruleIds(summary.findings).sort()).toEqual([
      "vtc-layout/dimensions",
      "vtc-layout/pixels",
      "vtc-style/color",
      "vtc-style/padding",
    ]);
    expect(summary.counts).toMatchObject({ style_mismatches: 3, diffs_over_budget: 2 });
  });

  it("is error when the runner failed as a whole, and unchecked when nothing could render", () => {
    expect(
      evaluateVisual(input(RunnerResultSchema.parse({ v: 1, error: "browser did not start" })))
        .summary.status,
    ).toBe("error");
    const none = evaluateVisual(
      input(RunnerResultSchema.parse({ v: 1 }), { jobs: [], missingScreens: ["settings"] }),
    );
    expect(none.summary.status).toBe("unchecked");
    expect(none.summary.findings[0]?.title).toMatch(/settings/);
    const empty = evaluateVisual(input(RunnerResultSchema.parse({ v: 1 }), { jobs: [] }));
    expect(empty.summary.status).toBe("unchecked");
  });

  it("keeps token lint and detector findings; advisory detector notes do not fail the step", () => {
    const note: ToolFinding = {
      tool: "vtc-design-detector",
      rule_id: "vtc-design/em-dash-overuse",
      category: "design",
      title: "Em-dash",
      location: { path: "web/a.html" },
      evidence: { type: "file", ref: "web/a.html" },
      sarif_level: "note",
    };
    const pass = evaluateVisual(input(rendered(), { detector: [note] }));
    expect(pass.summary.status).toBe("pass");
    expect(pass.summary.counts.detector).toBe(1);
    const fail = evaluateVisual(
      input(rendered(), { detector: [{ ...note, sarif_level: "warning" }] }),
    );
    expect(fail.summary.status).toBe("fail");
  });
});

describe("visual notes and the project toolchain (reading 124)", () => {
  const many: ToolFinding[] = Array.from({ length: MAX_SUMMARY_FINDINGS + 50 }, (_, i) => ({
    tool: "vtc-design-detector",
    rule_id: "vtc-design/side-stripe",
    category: "design",
    title: `stripe ${String(i)}`,
    location: { path: "web/a.css", line: i + 1 },
    evidence: { type: "file_line", ref: `web/a.css:${String(i + 1)}` },
    sarif_level: "warning",
  }));
  const notes = [
    "pinned the browser",
    { rule_id: VISUAL_PROJECT_TOOLCHAIN_RULE, text: "project code" },
  ];

  it("keeps every note in the capped summary, ahead of the other findings", () => {
    const { summary } = evaluateVisual(input(rendered(), { detector: many, notes }));
    expect(summary.findings).toHaveLength(MAX_SUMMARY_FINDINGS);
    expect(ruleIds(summary.findings.slice(0, 2))).toEqual([
      VISUAL_NOTE_RULE,
      VISUAL_PROJECT_TOOLCHAIN_RULE,
    ]);
    expect(summary.findings.slice(0, 2).every((f) => f.sarif_level === "note")).toBe(true);
    expect(ranOnProjectToolchain(summary)).toBe(true);
    const without = visualWithoutRenders({
      run: "r1",
      task: "T-1",
      status: "error",
      reason: "the render crashed",
      browser: null,
      findings: many,
      notes,
      reportPath: ".vtc/evidence/T-1/visual/report.json",
      writtenAt: "2026-10-14T08:00:00.000Z",
    });
    expect(ranOnProjectToolchain(without.summary)).toBe(true);
  });

  it("tells a run on VTC's own store from one on the project's Playwright", () => {
    const store = evaluateVisual(input(rendered(), { notes: ["pinned the browser"] }));
    expect(ranOnProjectToolchain(store.summary)).toBe(false);
    expect(ranOnProjectToolchain(undefined)).toBe(false);
    expect(ranOnProjectToolchain(null)).toBe(false);
    // A plain note that merely mentions the project's Playwright is not the marker.
    const prose = evaluateVisual(
      input(rendered(), { notes: ["ran on the project's own Playwright"] }),
    );
    expect(ranOnProjectToolchain(prose.summary)).toBe(false);
  });
});

describe("styleMismatch", () => {
  it("ignores transparent colours, auto lengths and pills", () => {
    const at = (property: string, value: string) =>
      styleMismatch(tokens, 0.02, { key: KEY, selector: "x", property, value });
    expect(at("background-color", "rgba(0, 0, 0, 0)")).toBeNull();
    expect(at("margin", "0px auto")).toBeNull();
    expect(at("border-radius", "9999px")).toBeNull();
    expect(at("font-family", '"Söhne", sans-serif')).toBeNull();
    expect(at("font-family", "Inter")).toMatchObject({ nearest_token: null, delta: 1 });
    expect(at("font-size", "17px")).toMatchObject({ nearest_token: "space.m", delta: 1 });
  });
});

describe("visualWithoutRenders", () => {
  const base = {
    run: "r1",
    task: "T-1",
    browser: null,
    reportPath: ".vtc/evidence/T-1/visual/report.json",
    writtenAt: "2026-10-14T08:00:00.000Z",
  };

  it("is skipped with the no-browser reason, and fail when token lint already blocks", () => {
    const skipped = visualWithoutRenders({
      ...base,
      status: "skipped",
      reason: VISUAL_SKIPPED_NO_BROWSER,
      findings: [],
    });
    expect(skipped.summary).toMatchObject({
      status: "skipped",
      skipped_reason: VISUAL_SKIPPED_NO_BROWSER,
    });
    expect(skipped.report.skipped_reason).toBe(VISUAL_SKIPPED_NO_BROWSER);
    const lint: ToolFinding = {
      tool: "vtc-token-lint",
      rule_id: "vtc-token/color",
      category: "design",
      title: "x",
      location: { path: "a.css", line: 1 },
      evidence: { type: "file_line", ref: "a.css:1" },
      sarif_level: "warning",
    };
    const failed = visualWithoutRenders({
      ...base,
      status: "skipped",
      reason: VISUAL_SKIPPED_NO_BROWSER,
      findings: [lint],
      counts: { token_lint: 1 },
    });
    expect(failed.summary.status).toBe("fail");
    expect(failed.summary.skipped_reason).toBeUndefined();
    expect(failed.summary.findings.at(-1)?.title).toMatch(/Not rendered: no browser/);
  });

  it("is error for a pin mismatch", () => {
    const out = visualWithoutRenders({
      ...base,
      status: "error",
      reason: "pin mismatch",
      findings: [],
    });
    expect(out.summary.status).toBe("error");
    expect(out.summary.findings[0]?.title).toMatch(/pin mismatch/);
  });
});
