/**
 * The gate report rendered for a screenshot (D-ce, the non-UI evidence): self-contained, escaped
 * and redacted, with the gate table, the layers and the test results.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GateReportSchema, type GateReport, type GateResultInput } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvidenceRecorder,
  GATE_REPORT_HTML,
  gateReportHtml,
  MAX_REPORT_FINDINGS,
  scrubLocalPaths,
} from "../../../src/gates/capture/index.js";
import { cleanupDirs, tempDir } from "../../helpers/repo.js";

afterEach(cleanupDirs);

const TOKEN = `ghp_${"z".repeat(36)}`;

const finding = (i: number) => ({
  tool: "eslint",
  rule_id: `no-unused-vars-${String(i)}`,
  category: "maintainability" as const,
  title: i === 0 ? `<script>alert(1)</script> uses ${TOKEN}` : `finding ${String(i)}`,
  location: { path: `src/f${String(i)}.ts`, line: i + 1 },
  evidence: { type: "log_line" as const, ref: ".vtc/evidence/T-1/gates/a/lint.log" },
});

const report = (extra: Partial<GateResultInput>[] = []): GateReport => {
  const results: GateResultInput[] = [
    {
      gate_id: "lint",
      layer: "L1",
      phase: "verify",
      status: "fail",
      failure_class: "product",
      blocking: true,
      new_violations: 25,
      baseline_violations: 2,
      findings: Array.from({ length: 25 }, (_, i) => finding(i)),
      duration_ms: 1500,
    },
    {
      gate_id: "unit",
      layer: "L2",
      phase: "verify",
      status: "pass",
      blocking: true,
      new_violations: 0,
      baseline_violations: 0,
      tests: {
        executed: 120,
        skipped: 3,
        failed: 0,
        inventory: ".vtc/evidence/T-1/gates/a/inventory.json",
        line_coverage_pct: 81.25,
      },
      duration_ms: 42_000,
    },
    {
      gate_id: "osv",
      layer: "L3",
      phase: "verify",
      status: "skipped",
      skipped_reason: "when_changed did not match",
      blocking: true,
      new_violations: 0,
      baseline_violations: 0,
      duration_ms: 0,
    },
    ...(extra as GateResultInput[]),
  ];
  return GateReportSchema.parse({
    run: "r1",
    task: "T-1",
    reason: "round",
    scope: "affected",
    base: "a".repeat(40),
    head: "b".repeat(40),
    results,
    sandbox: "sandbox-exec",
    verdict: "fail",
    started_at: "2026-10-14T08:00:00.000Z",
    finished_at: "2026-10-14T08:01:30.000Z",
  });
};

describe("the gate report page (D-ce)", () => {
  it("shows the verdict, the test results, the layers and every gate", () => {
    const html = gateReportHtml(report());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<span class="badge s-fail">fail</span>');
    expect(html).toContain("run r1");
    expect(html).toContain("aaaaaaaaaaaa..bbbbbbbbbbbb");
    expect(html).toContain("<b>120</b><small>executed</small>");
    expect(html).toContain("<b>3</b><small>skipped</small>");
    expect(html).toContain("<b>81.3%</b><small>line coverage</small>");
    expect(html).toContain("<b>n/a</b><small>diff coverage</small>");
    // Layers: L1 one fail, L2 one pass, L3 one skipped.
    expect(html).toContain('<tr><td>L1</td><td class="num">0</td><td class="num">1</td>');
    expect(html).toContain("120 run, 0 failed, 3 skipped");
    expect(html).toContain("when_changed did not match");
    expect(html).toContain(`${String(25 - MAX_REPORT_FINDINGS)} more not shown.`);
    expect(html).toContain("src/f0.ts:1");
  });

  it("loads nothing: no script, link, image or remote URL, and a default-src 'none' policy", () => {
    const html = gateReportHtml(report());
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|src=|href=|url\(|https?:\/\//i);
  });

  it("escapes and redacts every value", () => {
    const html = gateReportHtml(report());
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain(TOKEN);
    expect(html).toContain("[REDACTED:github_token]");
  });

  it("replaces local account paths in free-text reasons", () => {
    const home = homedir();
    const html = gateReportHtml(
      report([
        {
          gate_id: "visual",
          layer: "L4",
          phase: "verify",
          status: "skipped",
          skipped_reason: `the visual runner wrote no result (exit 1): Error at ${join(home, ".vtc/browsers/x.mjs")} and /home/alice/repo/a.ts`,
          blocking: true,
          new_violations: 0,
          baseline_violations: 0,
          duration_ms: 10,
        },
      ]),
    );
    expect(html).toContain("Error at ~/.vtc/browsers/x.mjs and ~&lt;user&gt;/repo/a.ts");
    expect(html).not.toContain(home);
    expect(html).not.toContain("alice");
    expect(
      scrubLocalPaths("at /Users/bob/x, C:\\Users\\carol\\y and /Users/me2/z", "/Users/me"),
    ).toBe("at ~<user>/x, ~<user>\\y and ~<user>/z");
    expect(scrubLocalPaths("at /Users/me/x and /Users/me", "/Users/me")).toBe("at ~/x and ~");
  });

  it("says so when no tests ran", () => {
    const r = report();
    const html = gateReportHtml({ ...r, results: r.results.filter((x) => x.layer !== "L2") });
    expect(html).toContain("No tests ran in this gate run.");
  });

  it("rejects a report that is not a GateReport", () => {
    expect(() => gateReportHtml({ ...report(), verdict: "pass" })).toThrow();
  });

  it("renderGateReport writes the page into outDir and returns its file name", async () => {
    const outDir = join(tempDir("vtc-report-"), "staging");
    const recorder = createEvidenceRecorder({ vtcHome: tempDir("vtc-home-") });
    const { html } = await recorder.renderGateReport({ report: report(), outDir });
    expect(html).toBe(GATE_REPORT_HTML);
    expect(readFileSync(join(outDir, html), "utf8")).toBe(gateReportHtml(report()));
    expect(statSync(join(outDir, html)).mode & 0o777).toBe(0o600);
    await expect(
      recorder.renderGateReport({ report: report(), outDir: "relative" }),
    ).rejects.toThrow(/absolute/);
  });
});
