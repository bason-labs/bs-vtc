/**
 * A small PNG codec for the visual step (AD-24): the novelty check's perceptual hash decodes a
 * first-viewport screenshot, and tests encode fixtures. Decodes 8-bit, non-interlaced greyscale,
 * RGB, palette, greyscale+alpha and RGBA images (what a Chromium screenshot is); anything else is
 * refused rather than guessed. Pure apart from `node:zlib`.
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, row-major RGBA. */
  readonly data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Largest image decoded (pixels): a 1440 × 20 000 full-page screenshot fits. */
const MAX_PIXELS = 40_000_000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decodes a PNG into RGBA pixels; throws on anything it does not support. */
export const decodePng = (bytes: Uint8Array): RgbaImage => {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error("not a PNG file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error("PNG chunk runs past the end of the file");
    offset += 12 + length;
    if (type === "IHDR") {
      if (length < 13) throw new Error("PNG IHDR chunk is too short");
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      const bitDepth = data[8];
      colorType = data[9] ?? -1;
      const interlace = data[12];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${String(bitDepth)}`);
      if (CHANNELS[colorType] === undefined) {
        throw new Error(`unsupported PNG colour type ${String(colorType)}`);
      }
      if (interlace !== 0) throw new Error("interlaced PNGs are not supported");
      if (width === 0 || height === 0 || width * height > MAX_PIXELS) {
        throw new Error(`unsupported PNG size ${String(width)}x${String(height)}`);
      }
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (colorType < 0) throw new Error("PNG has no IHDR chunk");
  const channels = CHANNELS[colorType] ?? 4;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is truncated");
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (pixels[out + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[out - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[out - stride + x - channels] ?? 0) : 0;
      const value = line[x] ?? 0;
      let decoded: number;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + ((left + up) >> 1);
      else if (filter === 4) decoded = value + paeth(left, up, upLeft);
      else throw new Error(`unknown PNG filter ${String(filter)}`);
      pixels[out + x] = decoded & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const p = i * channels;
    let rgba: [number, number, number, number];
    if (colorType === 0) {
      const v = pixels[p] ?? 0;
      rgba = [v, v, v, 255];
    } else if (colorType === 2) {
      rgba = [pixels[p] ?? 0, pixels[p + 1] ?? 0, pixels[p + 2] ?? 0, 255];
    } else if (colorType === 3) {
      const index = pixels[p] ?? 0;
      if (palette === null) throw new Error("palette PNG without a PLTE chunk");
      rgba = [
        palette[index * 3] ?? 0,
        palette[index * 3 + 1] ?? 0,
        palette[index * 3 + 2] ?? 0,
        transparency?.[index] ?? 255,
      ];
    } else if (colorType === 4) {
      const v = pixels[p] ?? 0;
      rgba = [v, v, v, pixels[p + 1] ?? 255];
    } else {
      rgba = [pixels[p] ?? 0, pixels[p + 1] ?? 0, pixels[p + 2] ?? 0, pixels[p + 3] ?? 255];
    }
    data.set(rgba, i * 4);
  }
  return { width, height, data };
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

/** Encodes RGBA pixels as an 8-bit RGBA PNG (filter 0). */
export const encodePng = (image: RgbaImage): Uint8Array => {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) throw new Error("RGBA data does not match the size");
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  return Uint8Array.from(Buffer.concat(parts));
};
