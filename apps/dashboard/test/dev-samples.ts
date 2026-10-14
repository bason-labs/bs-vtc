import {
  FactRowSchema,
  ScorecardIndexSchema,
  ScorecardSchema,
  VisualReportSchema,
  VisualSummarySchema,
  type VisualSummary,
} from "@vtc/shared";
import { artifactContent, devArtifact } from "../scripts/dev-fixtures.ts";
import { GOLDEN_RUN } from "../scripts/fixture-routes.ts";
import { readDevFixture } from "./fixtures";
import { SAMPLE_GATE_REPORT } from "./golden-samples";

/**
 * The files the golden run does not record (a visual QA report, Lookback scorecards, research
 * facts), read from the dashboard's own dev fixtures (`dev-fixtures/vtc/`) and checked against
 * their contracts here, so the tests and the dev fixture server use the same files. Visual
 * summaries start from engine core's golden gate report (`samples/gate-report-visual.json`).
 */
export const SHA = (c: string): string => c.repeat(40);
export const SHA256 = (c: string): string => c.repeat(64);

/** A JSON artifact as the artifacts route returns it. */
export const jsonArtifact = (path: string, value: unknown, run = GOLDEN_RUN) =>
  artifactContent(run, path, JSON.stringify(value, null, 2));

/** A gate run's visual evidence directory (`.vtc/evidence/<T-n|F-n>/gates/<attempt>/visual/`). */
export const VISUAL_DIR = ".vtc/evidence/T-1/gates/20261013T110000Z-round-aaaaaaaaaaaa/visual";
export const VISUAL_REPORT_PATH = `${VISUAL_DIR}/report.json`;
export const VISUAL_REPORT = VisualReportSchema.parse(
  JSON.parse(readDevFixture(VISUAL_REPORT_PATH)),
);

const screenshot = devArtifact(GOLDEN_RUN, `${VISUAL_DIR}/login-default-390-light.png`);
if (screenshot?.encoding !== "base64") throw new Error("the dev screenshot is missing");
/** The dev fixtures' screenshot, base64, as the artifacts route returns a binary file. */
export const PNG_BASE64 = screenshot.content;

export const pngArtifact = (path: string, run = GOLDEN_RUN) => ({
  ...screenshot,
  run,
  path,
});

export const SCORECARD_INDEX = ScorecardIndexSchema.parse(
  JSON.parse(readDevFixture(".vtc/lookback/scorecards/index.json")),
);
export const ENGINEER_SCORECARD = ScorecardSchema.parse(
  JSON.parse(readDevFixture(SCORECARD_INDEX.scorecards[0]?.path ?? "")),
);

export const FACTS_JSONL = readDevFixture(".vtc/research/facts.jsonl");
export const FACT_ROWS = FACTS_JSONL.trim()
  .split("\n")
  .map((line) => FactRowSchema.parse(JSON.parse(line)));

// --------------------------------------------------------- visual summaries

const golden = SAMPLE_GATE_REPORT.visual;
if (golden === undefined) throw new Error("the golden gate report has no visual summary");
const summary = (changes: Record<string, unknown>): VisualSummary =>
  VisualSummarySchema.parse({ ...golden, ...changes });

const NO_COUNTS = Object.fromEntries(Object.keys(golden.counts).map((k) => [k, 0]));

/**
 * The golden gate report's summary: a pass on the project's own Playwright (spine §5 readings
 * 124, 136), not a Level-3 pass, with its report at the gate runner's layout.
 */
export const VISUAL_SUMMARY_PROJECT_PASS = summary({ report: VISUAL_REPORT_PATH });

/** The dev visual report's run on VTC's own browser store: unchecked, with its findings. */
export const VISUAL_SUMMARY_UNCHECKED = summary({
  status: "unchecked",
  report: VISUAL_REPORT_PATH,
  toolchain: "vtc",
  counts: {
    ...NO_COUNTS,
    renders: VISUAL_REPORT.renders.length,
    unreached: VISUAL_REPORT.renders.filter((r) => r.status === "unreached").length,
    axe_violations: 1,
    axe_incomplete: 1,
    style_mismatches: 1,
    diffs_over_budget: 1,
  },
  findings: VISUAL_REPORT.findings,
});

/** No browser for the visual gates. */
export const VISUAL_SUMMARY_SKIPPED = summary({
  status: "skipped",
  report: null,
  toolchain: undefined,
  skipped_reason:
    "no browser for the visual gates: install Playwright in the project, or run vtc doctor --install-browser",
  counts: NO_COUNTS,
});

/** D-bj (spine §5 reading 164): Linux with `kernel.yama.ptrace_scope` 0 skips with a note. */
export const VISUAL_SUMMARY_PTRACE = summary({
  status: "skipped",
  report: VISUAL_REPORT_PATH,
  toolchain: undefined,
  skipped_reason:
    "the visual step does not render on this Linux host: kernel.yama.ptrace_scope is 0 or absent, so the app server (project code in the runner's sandbox, as the same user) could attach to the runner and sign any result; set kernel.yama.ptrace_scope to 1 or higher (sysctl) to run it",
  counts: NO_COUNTS,
});
