import { describe, expect, it } from "vitest";
import { ageTone, formatAge, formatCountdown, formatDuration, formatLocalTime } from "@/lib/time";

const NOW = Date.parse("2026-10-13T09:41:00.000Z");
const UTC = { timeZone: "UTC", locale: "en-GB" } as const;

describe("formatDuration", () => {
  it.each([
    [0, "<1m"],
    [59_000, "<1m"],
    [60_000, "1m"],
    [45 * 60_000, "45m"],
    [(3 * 60 + 19) * 60_000, "3h 19m"],
    [3 * 3_600_000, "3h"],
    [(2 * 24 + 4) * 3_600_000, "2d 4h"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("formatLocalTime", () => {
  it("shows only the time for today, in the viewer's zone", () => {
    expect(formatLocalTime("2026-10-13T13:00:00.000Z", NOW, UTC)).toBe("13:00");
    expect(
      formatLocalTime("2026-10-13T13:00:00.000Z", NOW, { ...UTC, timeZone: "Asia/Ho_Chi_Minh" }),
    ).toBe("20:00");
  });
  it("adds the weekday within a week, and the date beyond", () => {
    expect(formatLocalTime("2026-10-18T00:00:00.000Z", NOW, UTC)).toBe("Sun 00:00");
    expect(formatLocalTime("2026-11-02T08:30:00.000Z", NOW, UTC)).toBe("2 Nov, 08:30");
  });
});

describe("formatAge / ageTone", () => {
  it("describes how old a reading is", () => {
    expect(formatAge("2026-10-13T09:40:40.000Z", NOW)).toBe("just now");
    expect(formatAge("2026-10-13T09:38:00.000Z", NOW)).toBe("3m ago");
    expect(formatAge("2026-10-13T07:30:00.000Z", NOW)).toBe("2h 11m ago");
    expect(formatAge(null, NOW)).toBe("never");
  });
  it("grades freshness", () => {
    expect(ageTone("2026-10-13T09:38:00.000Z", NOW)).toBe("fresh");
    expect(ageTone("2026-10-13T09:00:00.000Z", NOW)).toBe("stale");
    expect(ageTone("2026-10-12T09:00:00.000Z", NOW)).toBe("old");
    expect(ageTone(null, NOW)).toBe("never");
  });
});

describe("formatCountdown", () => {
  it("counts down to a time and says when it is due", () => {
    expect(formatCountdown("2026-10-13T13:00:00.000Z", NOW)).toBe("in 3h 19m");
    expect(formatCountdown("2026-10-13T09:40:30.000Z", NOW)).toBe("due now");
    // Clearly past (by more than a minute) is "passed", never "due now".
    expect(formatCountdown("2026-10-13T09:00:00.000Z", NOW)).toBe("passed");
  });
});
