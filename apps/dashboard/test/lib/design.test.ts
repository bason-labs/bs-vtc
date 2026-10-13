import { describe, expect, it } from "vitest";
import { DESIGN_REVIEW_MAX_BYTES } from "@vtc/shared";
import {
  buildReviewInput,
  designReviewsPath,
  designSelection,
  parsePins,
  parseScreens,
  pinPosition,
  pinsInView,
  prototypeFrameUrl,
  VIEWPORTS,
} from "@/lib/design";
import { readDevFixture } from "../fixtures";

const PROTO = "http://127.0.0.1:4311/";

describe("parseScreens (screens.yaml, spec §9)", () => {
  it("reads each screen's id, route, states and REQs", () => {
    const parsed = parseScreens(readDevFixture(".vtc/design/screens.yaml"));
    expect(parsed?.skipped).toBe(0);
    expect(parsed?.screens[0]).toEqual({
      id: "reset-request",
      route: "/reset/",
      states: ["empty", "loading", "error", "success"],
      reqs: ["REQ-2"],
    });
  });

  it("skips malformed screens, defaults missing states, and returns null for non-YAML", () => {
    const parsed = parseScreens(
      [
        "screens:",
        "  - id: home",
        "    route: /",
        "  - id: Bad Id",
        "    route: /x",
        "  - id: no-route",
        "  - id: abs",
        "    route: http://evil.example/",
      ].join("\n"),
    );
    expect(parsed?.screens).toEqual([{ id: "home", route: "/", states: ["default"], reqs: [] }]);
    expect(parsed?.skipped).toBe(3);
    expect(parseScreens("screens: [")).toBeNull();
    expect(parseScreens("just text")).toBeNull();
  });
});

describe("prototypeFrameUrl (AD-5 rule 9: the separate prototype origin)", () => {
  it("puts the screen route on the prototype origin with ?state= and ?theme=", () => {
    expect(prototypeFrameUrl(PROTO, "/reset/", "error", "dark")).toBe(
      "http://127.0.0.1:4311/reset/?state=error&theme=dark",
    );
    expect(prototypeFrameUrl(PROTO, "/a/?x=1", "empty", "light")).toBe(
      "http://127.0.0.1:4311/a/?x=1&state=empty&theme=light",
    );
  });

  it("never leaves the prototype origin", () => {
    expect(prototypeFrameUrl(PROTO, "//evil.example/x", "s", "light")).toBe(
      "http://127.0.0.1:4311/evil.example/x?state=s&theme=light",
    );
    expect(prototypeFrameUrl(PROTO, "/../../etc", "s", "light")).toBe(
      "http://127.0.0.1:4311/etc?state=s&theme=light",
    );
    expect(prototypeFrameUrl("javascript:alert(1)", "/", "s", "light")).toBeNull();
    expect(prototypeFrameUrl("http://evil.example/", "/", "s", "light")).toBeNull();
  });
});

describe("designSelection (query string → screen, state, viewport, theme)", () => {
  const screens = parseScreens(readDevFixture(".vtc/design/screens.yaml"))?.screens ?? [];

  it("defaults to the first screen, its first state, desktop and light", () => {
    expect(designSelection(new URLSearchParams(), screens)).toEqual({
      screen: screens[0],
      state: "empty",
      viewport: 1440,
      theme: "light",
    });
  });

  it("keeps valid choices and replaces unknown ones", () => {
    const q = new URLSearchParams("screen=reset-confirm&state=expired&viewport=390&theme=dark");
    expect(designSelection(q, screens)).toMatchObject({
      screen: { id: "reset-confirm" },
      state: "expired",
      viewport: 390,
      theme: "dark",
    });
    const bad = new URLSearchParams("screen=nope&state=nope&viewport=123&theme=sepia");
    expect(designSelection(bad, screens)).toMatchObject({
      screen: { id: "reset-request" },
      state: "empty",
      viewport: 1440,
      theme: "light",
    });
    expect(designSelection(q, []).screen).toBeNull();
  });

  it("offers the §7.5 render widths", () => {
    expect(VIEWPORTS.map((v) => v.width)).toEqual([390, 768, 1440]);
  });
});

describe("pins (click-to-pin comments, .vtc/design/reviews/<screen>.jsonl)", () => {
  it("names the reviews file of a screen", () => {
    expect(designReviewsPath("reset-request")).toBe(".vtc/design/reviews/reset-request.jsonl");
  });

  it("reads the JSONL file, skipping lines that break the contract, dropping unknown keys", () => {
    const pins = parsePins(readDevFixture(".vtc/design/reviews/reset-request.jsonl"));
    expect(pins).toHaveLength(2);
    expect(pins[0]).toMatchObject({ n: 1, state: "empty", viewport: 1440, x_pct: 50 });
    expect(pins[0]).not.toHaveProperty("at");
    expect(parsePins('{"nope":1}\n\nnot json\n')).toEqual([]);
  });

  it("shows only the pins made on the same state, viewport and theme", () => {
    const pins = parsePins(readDevFixture(".vtc/design/reviews/reset-request.jsonl"));
    expect(pinsInView(pins, { state: "empty", viewport: 1440, theme: "light" })).toHaveLength(1);
    expect(pinsInView(pins, { state: "empty", viewport: 390, theme: "light" })).toHaveLength(0);
  });

  it("turns a click into percentages of the frame, clamped and rounded", () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    expect(pinPosition(rect, 300, 100)).toEqual({ x_pct: 50, y_pct: 25 });
    expect(pinPosition(rect, 99, 999)).toEqual({ x_pct: 0, y_pct: 100 });
    expect(pinPosition(rect, 233.33, 50)).toEqual({ x_pct: 33.3, y_pct: 0 });
    expect(pinPosition({ ...rect, width: 0 }, 300, 100)).toEqual({ x_pct: 50, y_pct: 50 });
  });

  it("builds a valid DesignReviewCommentInput, or says what is wrong", () => {
    const base = {
      screen: "reset-request",
      state: "empty",
      viewport: 390,
      theme: "dark" as const,
      x_pct: 10,
      y_pct: 20,
    };
    expect(buildReviewInput({ ...base, comment: "  Too tight  ", author: " " })).toEqual({
      ok: true,
      input: { ...base, comment: "Too tight" },
    });
    expect(buildReviewInput({ ...base, comment: "Hi", author: "Ba" })).toMatchObject({
      ok: true,
      input: { author: "Ba" },
    });
    expect(buildReviewInput({ ...base, comment: "   ", author: "" })).toEqual({
      ok: false,
      error: "Write a comment first.",
    });
    expect(buildReviewInput({ ...base, comment: "x".repeat(2001), author: "" })).toEqual({
      ok: false,
      error: "Keep the comment under 2,000 characters.",
    });
    expect(
      buildReviewInput({ ...base, comment: "é".repeat(1999), author: "a".repeat(100) }),
    ).toMatchObject({ ok: true });
    expect(DESIGN_REVIEW_MAX_BYTES).toBeGreaterThan(2000 * 2);
  });
});
