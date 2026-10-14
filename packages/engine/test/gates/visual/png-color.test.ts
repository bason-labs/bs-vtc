import { deflateSync } from "node:zlib";
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

  it("never inflates image data past the size IHDR declares (a decompression bomb)", () => {
    // 1x1 RGBA (5 bytes of image data) whose IDAT inflates to 64 MiB.
    const bomb = pngWith([
      ["IHDR", ihdr(1, 1)],
      ["IDAT", deflateSync(Buffer.alloc(64 * 1024 * 1024))],
      ["IEND", new Uint8Array(0)],
    ]);
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(() => decodePng(bomb)).toThrow(/larger than its IHDR size/);
  });

  it("rejects image data before IHDR and a second IHDR", () => {
    const idat = deflateSync(Buffer.alloc(5));
    expect(() =>
      decodePng(
        pngWith([
          ["IDAT", idat],
          ["IHDR", ihdr(1, 1)],
          ["IEND", new Uint8Array(0)],
        ]),
      ),
    ).toThrow(/does not start with an IHDR/);
    expect(() =>
      decodePng(
        pngWith([
          ["IHDR", ihdr(1, 1)],
          ["IHDR", ihdr(1, 1)],
          ["IDAT", idat],
        ]),
      ),
    ).toThrow(/more than one IHDR/);
  });
});

/** An 8-bit RGBA IHDR body. */
const ihdr = (width: number, height: number): Uint8Array => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return header;
};

/** A PNG made of the given chunks (CRCs zero: the decoder does not check them). */
const pngWith = (chunks: readonly (readonly [string, Uint8Array])[]): Uint8Array => {
  const parts: Uint8Array[] = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])];
  for (const [type, data] of chunks) {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    parts.push(out);
  }
  return Uint8Array.from(Buffer.concat(parts));
};

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
