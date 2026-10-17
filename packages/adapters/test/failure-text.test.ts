import { describe, expect, it } from "vitest";
import { resetFromClockText } from "../src/common/failure-text.js";

const MESSAGE = (at: string): string =>
  `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at ${at}.`;

describe("resetFromClockText (Codex limit text, codex-cli 0.163.0)", () => {
  it("reads a bare time in the given zone, on the day the run ended", () => {
    // 08:00Z is 15:00 at +07
    expect(
      resetFromClockText(MESSAGE("7:30 PM"), "2026-10-13T08:00:00.000Z", "Asia/Ho_Chi_Minh"),
    ).toBe("2026-10-13T12:30:00.000Z");
    expect(resetFromClockText(MESSAGE("12:05 AM"), "2026-10-13T08:00:00.000Z", "UTC")).toBe(
      "2026-10-14T00:05:00.000Z",
    );
    expect(resetFromClockText(MESSAGE("12:05 PM"), "2026-10-13T08:00:00.000Z", "UTC")).toBe(
      "2026-10-13T12:05:00.000Z",
    );
  });

  it("rolls a time already past to the next day, with a minute of slack", () => {
    expect(
      resetFromClockText(MESSAGE("2:00 PM"), "2026-10-13T08:00:00.000Z", "Asia/Ho_Chi_Minh"),
    ).toBe("2026-10-14T07:00:00.000Z");
    expect(
      resetFromClockText(MESSAGE("3:00 PM"), "2026-10-13T08:00:30.000Z", "Asia/Ho_Chi_Minh"),
    ).toBe("2026-10-13T08:00:00.000Z");
  });

  it("reads the dated form Codex prints for a reset on another day", () => {
    expect(
      resetFromClockText(
        MESSAGE("Oct 19th, 2026 9:15 AM"),
        "2026-10-13T08:00:00.000Z",
        "America/New_York",
      ),
    ).toBe("2026-10-19T13:15:00.000Z");
    // after the DST change: EST is -05
    expect(
      resetFromClockText(
        MESSAGE("Nov 2nd, 2026 9:15 AM"),
        "2026-10-31T08:00:00.000Z",
        "America/New_York",
      ),
    ).toBe("2026-11-02T14:15:00.000Z");
  });

  it("gives null when the text names no clock time, or an impossible one", () => {
    const end = "2026-10-13T08:00:00.000Z";
    expect(resetFromClockText("try again in 2 hours", end, "UTC")).toBeNull();
    expect(resetFromClockText(MESSAGE("13:00 PM"), end, "UTC")).toBeNull();
    expect(resetFromClockText(MESSAGE("Foo 3rd, 2026 1:00 PM"), end, "UTC")).toBeNull();
    expect(resetFromClockText(MESSAGE("1:00 PM"), "not a date", "UTC")).toBeNull();
    expect(resetFromClockText(MESSAGE("1:00 PM"), end, "Not/AZone")).toBeNull();
  });
});
