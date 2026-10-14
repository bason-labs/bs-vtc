import { describe, expect, it } from "vitest";
import { VisualStatusSchema } from "@vtc/shared";
import {
  imageDataUrl,
  readVisualReport,
  renderMatrix,
  visualDiffs,
  visualStatusMeta,
  visualSummaryModel,
} from "@/lib/visual";
import {
  jsonArtifact,
  pngArtifact,
  VISUAL_REPORT,
  VISUAL_REPORT_PATH,
  VISUAL_SUMMARY_SKIPPED,
  VISUAL_SUMMARY_UNCHECKED,
} from "../wave3-fixtures";

describe("visualStatusMeta (§7.5, spine §5 reading 105)", () => {
  it("counts only pass as passed", () => {
    for (const status of VisualStatusSchema.options) {
      expect(visualStatusMeta(status).passed).toBe(status === "pass");
    }
  });

  it("shows skipped and unchecked as not passed", () => {
    expect(visualStatusMeta("skipped")).toMatchObject({ label: "Not passed: skipped" });
    expect(visualStatusMeta("skipped").tone).not.toBe("ok");
    expect(visualStatusMeta("unchecked")).toMatchObject({
      label: "Not passed: unchecked",
      tone: "danger",
    });
    expect(visualStatusMeta("error").label).toMatch(/infrastructure/);
  });
});

describe("visualSummaryModel (GateReport.visual)", () => {
  it("shows a skipped step's reason and that Level 3 never counts it", () => {
    const m = visualSummaryModel(VISUAL_SUMMARY_SKIPPED);
    expect(m.status.label).toBe("Not passed: skipped");
    expect(m.notes.join(" ")).toContain("vtc doctor --install-browser");
    expect(m.notes.join(" ")).toMatch(/Level 3/);
    expect(m.report).toBeNull();
  });

  it("lists the counts that are not clean and links the full report", () => {
    const m = visualSummaryModel(VISUAL_SUMMARY_UNCHECKED);
    expect(m.notes.join(" ")).toMatch(/unreached is not clean/i);
    expect(m.report).toBe(VISUAL_REPORT_PATH);
    expect(m.counts.find((c) => c.label === "Unreached")).toMatchObject({ value: 1, bad: true });
    expect(m.counts.find((c) => c.label === "Renders")).toMatchObject({ value: 3, bad: false });
    expect(m.counts.find((c) => c.label === "Token lint")).toMatchObject({ value: 0, bad: false });
    expect(m.findings).toHaveLength(1);
  });

  it("drops a report path the artifacts route cannot serve", () => {
    const m = visualSummaryModel({ ...VISUAL_SUMMARY_UNCHECKED, report: ".vtc/state/x.json" });
    expect(m.report).toBeNull();
  });
});

describe("readVisualReport", () => {
  it("reads a visual report under .vtc/evidence/", () => {
    const report = readVisualReport(jsonArtifact(VISUAL_REPORT_PATH, VISUAL_REPORT));
    expect(report?.status).toBe("unchecked");
  });

  it("ignores other paths, other JSON and binary files", () => {
    expect(readVisualReport(jsonArtifact(".vtc/design/report.json", VISUAL_REPORT))).toBeNull();
    expect(readVisualReport(jsonArtifact(VISUAL_REPORT_PATH, { v: 1 }))).toBeNull();
    expect(readVisualReport(pngArtifact(".vtc/evidence/T-1/visual/a.png"))).toBeNull();
  });

  it("drops keys a newer engine added", () => {
    const report = readVisualReport(
      jsonArtifact(VISUAL_REPORT_PATH, { ...VISUAL_REPORT, extra_from_5_0: true }),
    );
    expect(report).not.toBeNull();
  });
});

describe("renderMatrix (screen × state × width × theme)", () => {
  const m = renderMatrix(VISUAL_REPORT);

  it("has one row per screen and state and one column per width and theme", () => {
    expect(m.rows.map((r) => r.label)).toEqual(["login · default", "login · error"]);
    expect(m.columns.map((c) => c.label)).toEqual(["390 light", "1440 dark"]);
  });

  it("marks clean, failing, unreached and missing cells", () => {
    const [def, err] = m.rows;
    // 390 light rendered, but a style mismatch and a diff over budget: not passed.
    expect(def?.cells[0]?.passed).toBe(false);
    expect(def?.cells[0]?.issues).toEqual(["1 style mismatch", "1 diff over budget"]);
    expect(def?.cells[0]?.screenshot).toBe(".vtc/evidence/T-1/visual/login-default-390-light.png");
    // 1440 dark: an axe violation and an incomplete item.
    expect(def?.cells[1]?.issues).toEqual(["1 axe violation", "1 axe item needs review"]);
    expect(err?.cells[0]).toMatchObject({ passed: false, label: "Unreached" });
    expect(err?.cells[0]?.detail).toMatch(/redirected/);
    expect(err?.cells[1]).toMatchObject({ passed: false, label: "Not rendered" });
    expect(m.summary).toEqual({ cells: 4, passed: 0 });
  });

  it("lists diffs with the ones over budget first", () => {
    const diffs = visualDiffs(VISUAL_REPORT);
    expect(diffs.map((d) => [d.region, d.overBudget])).toEqual([
      ["header", true],
      ["form", false],
    ]);
    expect(diffs[0]?.ratio).toBe("1.4% of 0.5%");
  });
});

describe("imageDataUrl", () => {
  it("shows raster images the artifacts route returned as base64", () => {
    expect(imageDataUrl(pngArtifact(".vtc/evidence/T-1/visual/a.png"))).toMatch(
      /^data:image\/png;base64,iVBOR/,
    );
  });

  it("never turns text, SVG or malformed base64 into an image", () => {
    expect(imageDataUrl(jsonArtifact(VISUAL_REPORT_PATH, {}))).toBeNull();
    expect(imageDataUrl({ ...pngArtifact(".vtc/a.svg"), media_type: "image/svg+xml" })).toBeNull();
    expect(imageDataUrl({ ...pngArtifact(".vtc/a.png"), content: "<script>" })).toBeNull();
  });
});
