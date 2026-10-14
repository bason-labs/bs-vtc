import { describe, expect, it } from "vitest";
import { decodePng, encodePng } from "../../../src/gates/visual/png.js";
import { deltaE, parseCssColor, toOklab, toOklch } from "../../../src/gates/visual/color.js";

const solid = (w: number, h: number, rgba: [number, number, number, number]): Uint8Array => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) data.set(rgba, i * 4);
  return data;
};

describe("png", () => {
  it("round-trips RGBA pixels through encode and decode", () => {
    const data = solid(3, 2, [10, 20, 30, 255]);
    data.set([200, 100, 0, 128], 4);
    const png = encodePng({ width: 3, height: 2, data });
    const back = decodePng(png);
    expect(back.width).toBe(3);
    expect(back.height).toBe(2);
    expect([...back.data]).toEqual([...data]);
  });

  it("rejects bytes that are not a PNG", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
  });
});

describe("color", () => {
  it("parses hex, rgb, hsl, oklch and named colours", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseCssColor("#00000080")?.a).toBeCloseTo(128 / 255, 5);
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseCssColor("rgb(255 0 0 / 50%)")?.a).toBe(0.5);
    expect(parseCssColor("hsl(120, 100%, 50%)")).toMatchObject({ r: 0, g: 1, b: 0 });
    expect(parseCssColor("white")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseCssColor("oklch(62.8% 0.2577 29.23)")?.r).toBeCloseTo(1, 1);
    expect(parseCssColor("var(--brand)")).toBeNull();
    expect(parseCssColor("currentColor")).toBeNull();
  });

  it("measures OKLab distance: identical colours are 0, near ones small, far ones large", () => {
    const red = toOklab(parseCssColor("#ff0000")!);
    const nearRed = toOklab(parseCssColor("#fe0101")!);
    const blue = toOklab(parseCssColor("#0000ff")!);
    expect(deltaE(red, red)).toBe(0);
    expect(deltaE(red, nearRed)).toBeLessThan(0.02);
    expect(deltaE(red, blue)).toBeGreaterThan(0.3);
    expect(toOklab(parseCssColor("#ffffff")!).l).toBeCloseTo(1, 3);
    expect(toOklch(toOklab(parseCssColor("#808080")!)).c).toBeLessThan(0.001);
  });
});
