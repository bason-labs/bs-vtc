import { describe, expect, it } from "vitest";
import { visualConfigFor } from "@vtc/shared";
import { expandMatrix, parseScreens } from "../../../src/gates/visual/matrix.js";
import { lengthPx, onScale, parseDesignTokens } from "../../../src/gates/visual/tokens.js";

const TOKENS = JSON.stringify({
  color: {
    $type: "color",
    ink: { $value: "#111111" },
    paper: { $value: { colorSpace: "srgb", components: [1, 1, 1] } },
    accent: { $value: "oklch(60% 0.15 250)" },
    link: { $value: "{color.accent}" },
  },
  space: { $type: "dimension", s: { $value: "8px" }, m: { $value: { value: 1, unit: "rem" } } },
  radius: { $type: "dimension", card: { $value: "6px" } },
  font: {
    body: { $type: "fontFamily", $value: ["Söhne", "system-ui"] },
    heading: { $type: "typography", $value: { fontFamily: "Tiempos", fontSize: "32px" } },
  },
  elevation: {
    $type: "shadow",
    low: {
      $value: {
        color: "#00000033",
        offsetX: "0px",
        offsetY: "1px",
        blur: "2px",
        spread: "0px",
      },
    },
  },
});

describe("design tokens", () => {
  it("reads colours, aliases, lengths, radii, fonts and shadows from DTCG", () => {
    const t = parseDesignTokens(TOKENS);
    expect(t.colors.map((c) => c.name).sort()).toEqual([
      "color.accent",
      "color.ink",
      "color.link",
      "color.paper",
    ]);
    expect(t.lengths.map((l) => [l.name, l.px])).toEqual(
      expect.arrayContaining([
        ["space.s", 8],
        ["space.m", 16],
        ["radius.card", 6],
        ["font.heading.fontSize", 32],
      ]),
    );
    expect(t.radii.map((r) => r.name)).toEqual(["radius.card"]);
    expect(t.fonts).toEqual([
      { name: "font.body", families: ["söhne", "system-ui"] },
      { name: "font.heading.fontFamily", families: ["tiempos"] },
    ]);
    expect(t.shadows[0]?.css).toBe("0px 1px 2px 0px rgba(0, 0, 0, 0.2)");
  });

  it("is tolerant of broken input", () => {
    expect(parseDesignTokens("{not json").colors).toEqual([]);
    expect(
      parseDesignTokens(JSON.stringify({ a: { $type: "color", $value: "var(--x)" } })).colors,
    ).toEqual([]);
  });

  it("puts lengths on a scale within half a pixel", () => {
    const { lengths } = parseDesignTokens(TOKENS);
    expect(onScale(lengths, 8.4).ok).toBe(true);
    expect(onScale(lengths, 13).ok).toBe(false);
    expect(onScale([], 4).ok).toBe(false);
    expect(lengthPx("1.5rem")).toBe(24);
    expect(lengthPx("0")).toBe(0);
    expect(lengthPx("12vw")).toBeNull();
  });
});

describe("render matrix", () => {
  const screens = parseScreens(`
version: 1
screens:
  - id: invoices
    route: /invoices
    states: [empty, error]
    reqs: [REQ-2]
  - id: home
    route: /
`);

  it("expands screen × state × width × theme with the default settings", () => {
    const m = expandMatrix(screens, [], visualConfigFor(undefined));
    // invoices: 2 states × 3 widths × 2 themes; home: 1 default state × 3 × 2
    expect(m.jobs).toHaveLength(18);
    expect(m.jobs[0]).toEqual({
      key: "invoices:empty:390:light",
      screen: "invoices",
      state: "empty",
      width: 390,
      theme: "light",
      path: "/invoices?state=empty&theme=light",
    });
    expect(m.jobs.some((j) => j.key === "home:default:1440:dark")).toBe(true);
    expect(m.missing).toEqual([]);
  });

  it("renders only the requested screens and reports unknown ones as missing", () => {
    const m = expandMatrix(screens, ["home", "settings"], { widths: [768], themes: ["dark"] });
    expect(m.jobs.map((j) => j.key)).toEqual(["home:default:768:dark"]);
    expect(m.missing).toEqual(["settings"]);
  });

  it("rejects an invalid screens file", () => {
    expect(() => parseScreens("screens: [{ id: Bad, route: x }]")).toThrow(/screens/);
  });
});
