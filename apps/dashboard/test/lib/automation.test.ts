import { describe, expect, it } from "vitest";
import {
  AutoKindSchema,
  AutomationReportSchema,
  AutomationSkipReasonSchema,
  type AutomationReport,
} from "@vtc/shared";
import { AUTO_KIND_LABELS, automationView, SKIP_REASONS } from "@/lib/automation";
import { readAutomationFixture } from "../fixtures";

const report = (): AutomationReport => AutomationReportSchema.parse(readAutomationFixture());

describe("automationView (D-ca, AD-27 rule 7)", () => {
  it("says what is on, where upstream reports go and how evidence is hosted", () => {
    const view = automationView(report());
    expect(view.switches).toEqual([
      { id: "issues", label: "Issues", on: true },
      { id: "prs", label: "Pull requests", on: true },
      { id: "upstream", label: "Reports to bason-labs/bs-vtc", on: true },
    ]);
    expect(view.off).toBe(false);
    expect(view.hosting).toBe("committed to the orphan vtc-evidence branch");
    expect(view.notes).toEqual(report().notes);
  });

  it("is off, with its notes, when neither issues nor PRs are on", () => {
    const view = automationView({
      ...report(),
      issues: false,
      prs: false,
      notes: ["this project has no GitHub remote"],
    });
    expect(view.off).toBe(true);
    expect(view.notes).toEqual(["this project has no GitHub remote"]);
  });

  it("lists items newest first with their issue, PR, state and evidence", () => {
    const { items } = automationView(report());
    expect(items.map((i) => i.last)).toEqual([...items.map((i) => i.last)].sort().reverse());
    const ci = items.find((i) => i.kind === "Post-merge CI failure")!;
    expect(ci.target).toBe("This project · example-org/golden-app");
    expect(ci.issue).toMatchObject({
      label: "Issue #41",
      href: "https://github.com/example-org/golden-app/issues/41",
      state: { label: "open" },
    });
    expect(ci.pr).toMatchObject({
      label: "PR #42",
      href: "https://github.com/example-org/golden-app/pull/42",
      state: { label: "draft" },
      evidence: { label: "evidence complete", tone: "ok" },
    });
    const lookback = items.find((i) => i.kind === "Lookback prompt change")!;
    expect(lookback.target).toBe("VTC · bason-labs/bs-vtc");
    expect(lookback.pr?.evidence).toMatchObject({ label: "evidence partial", tone: "warn" });
    const merged = items.find((i) => i.pr?.state.label === "merged");
    expect(merged?.pr?.state.tone).toBe("ok");
    const issueOnly = items.find((i) => i.pr === null);
    expect(issueOnly?.issue?.state.label).toBe("closed");
  });

  it("never links anything but http(s)", () => {
    const base = report();
    const [first] = base.items;
    const view = automationView({
      ...base,
      items: [{ ...first!, issue: { number: 7, url: "javascript:alert(1)", state: "open" } }],
    });
    expect(view.items[0]?.issue?.href).toBeNull();
  });

  it("lists the latest skips newest first, each with its reason", () => {
    const { skipped } = automationView(report());
    expect(skipped.map((s) => s.at)).toEqual([...skipped.map((s) => s.at)].sort().reverse());
    expect(skipped[0]).toMatchObject({ reason: SKIP_REASONS.rate_limit });
    expect(skipped.every((s) => s.detail.length > 0)).toBe(true);
  });

  it("names every kind and skip reason", () => {
    for (const k of AutoKindSchema.options) expect(AUTO_KIND_LABELS[k]).not.toBe("");
    for (const r of AutomationSkipReasonSchema.options) expect(SKIP_REASONS[r]).not.toBe("");
  });
});
