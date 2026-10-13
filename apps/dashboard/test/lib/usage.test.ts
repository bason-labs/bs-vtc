import { describe, expect, it } from "vitest";
import { UsageReportSchema, type UsageReport } from "@vtc/shared";
import { usagePanelModel } from "@/lib/usage";
import { readFixture } from "../fixtures";

const NOW = Date.parse("2026-10-13T09:41:00.000Z");
const opts = { timeZone: "UTC", locale: "en-GB" } as const;
const golden = (): UsageReport => UsageReportSchema.parse(readFixture("usage"));

describe("usagePanelModel", () => {
  it("shows one card per host, Claude first", () => {
    const model = usagePanelModel(golden(), NOW, opts);
    expect(model.cards.map((c) => c.name)).toEqual(["Claude Code", "Codex"]);
  });

  it("shows used and remaining % with the local reset time and countdown", () => {
    const [claude] = usagePanelModel(golden(), NOW, opts).cards;
    const [five, weekly] = claude!.windows;
    expect(five).toMatchObject({
      title: "5-hour window",
      usedPct: 41,
      usedText: "41% used",
      remainingText: "59% left",
      resetText: "resets 13:00 (in 3h 19m)",
      tone: "ok",
    });
    expect(weekly).toMatchObject({
      title: "Weekly",
      usedText: "18% used",
      remainingText: "82% left",
      resetText: "resets Sun 00:00 (in 4d 14h)",
    });
    expect(claude!.updated).toEqual({ text: "updated just now", tone: "fresh" });
    expect(claude!.sourceText).toBe("Claude Code statusline");
  });

  it("shows unknown, never 0%, when a host has no data", () => {
    const codex = usagePanelModel(golden(), NOW, opts).cards[1]!;
    expect(
      codex.windows.map((w) => [w.title, w.usedPct, w.usedText, w.remainingText, w.resetText]),
    ).toEqual([
      ["5-hour window", null, "unknown", "unknown", "reset time unknown"],
      ["Weekly", null, "unknown", "unknown", "reset time unknown"],
    ]);
    expect(codex.updated).toEqual({ text: "never updated", tone: "never" });
  });

  it("adds a card for a host the report leaves out", () => {
    const model = usagePanelModel(
      { hosts: [], interrupted_tasks: [], auto_resume_at: null },
      NOW,
      opts,
    );
    expect(model.cards.map((c) => c.windows[0]?.usedText)).toEqual(["unknown", "unknown"]);
  });

  it("keeps a reading with an unknown reset, and other windows by label", () => {
    const report: UsageReport = {
      hosts: [
        {
          host: "codex",
          source: "app_server",
          windows: [
            {
              kind: "five_hour",
              label: "primary",
              window_minutes: 300,
              used_pct: 92.4,
              resets_at: null,
            },
            { kind: "other", label: "burst", window_minutes: 60, used_pct: 10, resets_at: null },
          ],
          model_limits: [
            {
              model: "gpt-5-codex",
              resets_at: "2026-10-13T12:00:00.000Z",
              observed_at: "2026-10-13T09:00:00.000Z",
            },
          ],
          updated_at: "2026-10-13T09:00:00.000Z",
        },
      ],
      interrupted_tasks: ["T-3", "T-4"],
      auto_resume_at: "2026-10-13T10:01:00.000Z",
    };
    const model = usagePanelModel(report, NOW, opts);
    const codex = model.cards[1]!;
    expect(codex.windows[0]).toMatchObject({
      usedText: "92% used",
      remainingText: "8% left",
      tone: "danger",
      resetText: "reset time unknown",
    });
    expect(codex.windows[1]).toMatchObject({ usedText: "unknown" });
    expect(codex.windows[2]).toMatchObject({ title: "burst", usedText: "10% used" });
    expect(codex.modelLimits).toEqual(["gpt-5-codex: limit reached, resets 12:00"]);
    expect(codex.updated).toEqual({ text: "updated 41m ago", tone: "stale" });
    expect(model.interrupted).toEqual({ count: 2, tasks: ["T-3", "T-4"] });
    expect(model.autoResume).toBe("Auto-resume 10:01 (in 20m)");
  });

  it("says when nothing is scheduled", () => {
    expect(usagePanelModel(golden(), NOW, opts).autoResume).toBeNull();
  });
});
