/**
 * The gate report and its test results as one self-contained HTML page (D-ce: the non-UI evidence
 * of an automatic PR; AD-27 rule 6). The recorder screenshots it from the evidence snapshot
 * server like any other page. The page has inline CSS only: no script, no link, no image and a
 * `default-src 'none'` policy, so it loads nothing. Every string is passed through
 * `redactSecrets` and HTML-escaped; findings show rule, place and title only, at most
 * {@link MAX_REPORT_FINDINGS}.
 */
import {
  GateReportSchema,
  redactSecrets,
  type GateLayer,
  type GateReport,
  type GateResult,
} from "@vtc/shared";

/** The file `renderGateReport` writes into `outDir`. */
export const GATE_REPORT_HTML = "gate-report.html";
export const MAX_REPORT_FINDINGS = 20;

const LAYERS: readonly GateLayer[] = ["L0", "L1", "L2", "L3", "L4", "L5", "L6"];
const STATUSES = ["pass", "fail", "error", "skipped"] as const;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Redacted, clipped and escaped: the only way a value reaches the page. */
const t = (value: string | number | null | undefined, max = 300): string => {
  if (value === null || value === undefined) return "";
  const s = redactSecrets(String(value));
  return escapeHtml(s.length > max ? `${s.slice(0, max - 1)}…` : s);
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

const badge = (status: string): string =>
  `<span class="badge s-${t(status, 20)}">${t(status, 20)}</span>`;

/** The run's L2 metrics: the last L2 result's `tests` (the combined metrics, `TestMetrics`). */
const lastTests = (results: readonly GateResult[]): GateResult["tests"] =>
  results.filter((r) => r.layer === "L2" && r.tests !== undefined).at(-1)?.tests;

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 32px; background: #ffffff; color: #1b1f24;
  font: 14px/1.45 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 24px 0 8px; }
.meta { color: #57606a; margin: 0 0 16px; }
.meta span { margin-right: 16px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #d8dee4; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
.s-pass { background: #dafbe1; color: #116329; }
.s-fail, .s-infra_error { background: #ffebe9; color: #a40e26; }
.s-error { background: #fff1e5; color: #953800; }
.s-skipped { background: #eaeef2; color: #424a53; }
.verdict { font-size: 14px; margin-left: 8px; vertical-align: middle; }
.tiles { display: flex; gap: 12px; flex-wrap: wrap; }
.tile { border: 1px solid #d8dee4; border-radius: 8px; padding: 10px 14px; min-width: 110px; }
.tile b { display: block; font-size: 20px; }
.tile small { color: #57606a; }
.muted { color: #57606a; }
`;

/**
 * Pure: the page for `report` (validated first). Sections: the verdict and run, the test totals,
 * the layers, every gate, the findings and the visual step.
 */
export const gateReportHtml = (input: GateReport): string => {
  const report = GateReportSchema.parse(input);
  const owner = report.task ?? report.feature ?? "";
  const tests = lastTests(report.results);
  const durationMs = Math.max(0, Date.parse(report.finished_at) - Date.parse(report.started_at));

  const meta = [
    `run ${t(report.run, 64)}`,
    owner === "" ? "" : t(owner, 20),
    `reason ${t(report.reason, 30)}`,
    `scope ${t(report.scope, 10)}`,
    `${t(report.base.slice(0, 12))}..${t(report.head.slice(0, 12))}`,
    report.sandbox === undefined ? "" : `sandbox ${t(report.sandbox, 20)}`,
    `took ${seconds(durationMs)}`,
  ]
    .filter((s) => s !== "")
    .map((s) => `<span>${s}</span>`)
    .join("");

  const testTiles =
    tests === undefined
      ? `<p class="muted">No tests ran in this gate run.</p>`
      : `<div class="tiles">${[
          ["executed", tests.executed],
          ["failed", tests.failed],
          ["skipped", tests.skipped],
          [
            "line coverage",
            tests.line_coverage_pct === null ? "n/a" : `${tests.line_coverage_pct.toFixed(1)}%`,
          ],
          [
            "diff coverage",
            tests.diff_coverage_pct === null ? "n/a" : `${tests.diff_coverage_pct.toFixed(1)}%`,
          ],
        ]
          .map(
            ([label, value]) =>
              `<div class="tile"><b>${t(value)}</b><small>${t(label)}</small></div>`,
          )
          .join("")}</div>`;

  const layerRows = LAYERS.map((layer) => {
    const of = report.results.filter((r) => r.layer === layer);
    if (of.length === 0) return "";
    const cells = STATUSES.map(
      (s) => `<td class="num">${String(of.filter((r) => r.status === s).length)}</td>`,
    ).join("");
    return `<tr><td>${layer}</td>${cells}</tr>`;
  }).join("");

  const gateRows = report.results
    .map((r) => {
      const l2 =
        r.tests === undefined
          ? ""
          : `${String(r.tests.executed)} run, ${String(r.tests.failed)} failed, ${String(r.tests.skipped)} skipped`;
      const note =
        r.skipped_reason ??
        (r.monotonic.length > 0 ? `${String(r.monotonic.length)} monotonic violation(s)` : "");
      return `<tr><td>${t(r.gate_id, 80)}</td><td>${t(r.layer)}</td><td>${badge(r.status)}</td><td>${r.blocking ? "yes" : "no"}</td><td>${t(r.failure_class ?? "")}</td><td class="num">${String(r.new_violations)}</td><td class="num">${String(r.baseline_violations)}</td><td>${t(l2)}</td><td class="num">${seconds(r.duration_ms)}</td><td class="muted">${t(note, 160)}</td></tr>`;
    })
    .join("");

  const findings = report.results.flatMap((r) => r.findings.map((f) => ({ gate: r.gate_id, f })));
  const findingRows = findings
    .slice(0, MAX_REPORT_FINDINGS)
    .map(({ gate, f }) => {
      const place = `${f.location.path}${f.location.line === undefined ? "" : `:${String(f.location.line)}`}`;
      return `<tr><td>${t(gate, 80)}</td><td>${t(f.rule_id, 120)}</td><td>${t(place, 200)}</td><td>${t(f.title, 200)}</td></tr>`;
    })
    .join("");
  const findingSection =
    findings.length === 0
      ? `<p class="muted">No new findings.</p>`
      : `<table><thead><tr><th>Gate</th><th>Rule</th><th>Where</th><th>Finding</th></tr></thead><tbody>${findingRows}</tbody></table>${
          findings.length > MAX_REPORT_FINDINGS
            ? `<p class="muted">${String(findings.length - MAX_REPORT_FINDINGS)} more not shown.</p>`
            : ""
        }`;

  const visual =
    report.visual === undefined
      ? ""
      : `<h2>Visual step</h2><p>${badge(report.visual.status)} <span class="muted">${t(
          report.visual.skipped_reason ??
            `${String(report.visual.counts.renders)} renders, ${String(report.visual.counts.axe_violations)} axe violations, ${String(report.visual.counts.diffs_over_budget)} diffs over budget`,
          300,
        )}</span></p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gate report ${t(owner === "" ? report.run : owner, 64)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Gate report <span class="verdict">${badge(report.verdict)}</span></h1>
<p class="meta">${meta}</p>
<h2>Tests</h2>
${testTiles}
<h2>Layers</h2>
<table><thead><tr><th>Layer</th>${STATUSES.map((s) => `<th class="num">${s}</th>`).join("")}</tr></thead><tbody>${layerRows}</tbody></table>
<h2>Gates</h2>
<table><thead><tr><th>Gate</th><th>Layer</th><th>Status</th><th>Blocking</th><th>Class</th><th class="num">New</th><th class="num">Baseline</th><th>Tests</th><th class="num">Time</th><th>Note</th></tr></thead><tbody>${gateRows}</tbody></table>
<h2>Findings</h2>
${findingSection}
${visual}
</body>
</html>
`;
};
