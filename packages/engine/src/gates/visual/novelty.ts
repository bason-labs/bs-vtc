/**
 * The novelty check (§9.1 step 4, AD-24 rule 8, spine §5 reading 107): a design direction's
 * first viewport and tokens are compared with the per-client design library under
 * `~/.vtc/design-library/<scope>/`, with no ML embedding. Two signals: a 64-bit difference hash
 * (dHash) of the first-viewport screenshot and a token vector (OKLCH palette, type pair, radius,
 * density). A direction is `too_similar` only when both distances to one library entry are under
 * their thresholds. The chosen direction is recorded in the library (§9.1 step 6).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DESIGN_LIBRARY_DIR,
  DesignLibraryEntrySchema,
  NoveltyReportSchema,
  parsePersisted,
  SlugSchema,
  type DesignLibraryEntry,
  type NoveltyReport,
} from "@vtc/shared";
import { writeRepoFile } from "../../git/index.js";
import { toOklch } from "./color.js";
import { decodePng, type RgbaImage } from "./png.js";
import type { DesignTokens } from "./tokens.js";

/** Default thresholds: dHash Hamming distance (of 64 bits) and token-vector distance. */
export const NOVELTY_THRESHOLDS = { phash_distance: 10, token_distance: 0.25 } as const;
/** Length of {@link tokenVector}. */
export const TOKEN_VECTOR_LENGTH = 16;

/** 64-bit dHash, hex: the image shrunk to 9×8 grey cells, each bit "left cell brighter". */
export const dhash = (image: RgbaImage): string => {
  const cols = 9;
  const rows = 8;
  const grey = new Float64Array(cols * rows);
  for (let cy = 0; cy < rows; cy += 1) {
    const y0 = Math.floor((cy * image.height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * image.height) / rows));
    for (let cx = 0; cx < cols; cx += 1) {
      const x0 = Math.floor((cx * image.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * image.width) / cols));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * image.width + x) * 4;
          sum +=
            0.299 * (image.data[i] ?? 0) +
            0.587 * (image.data[i + 1] ?? 0) +
            0.114 * (image.data[i + 2] ?? 0);
          n += 1;
        }
      }
      grey[cy * cols + cx] = n === 0 ? 0 : sum / n;
    }
  }
  let bits = 0n;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols - 1; cx += 1) {
      bits =
        (bits << 1n) | ((grey[cy * cols + cx] ?? 0) > (grey[cy * cols + cx + 1] ?? 0) ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
};

/** Hamming distance of two 64-bit hex hashes. */
export const hammingDistance = (a: string, b: string): number => {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** FNV-1a of a font family, scaled into [0, 1): equal families give equal values. */
const fontCode = (family: string | undefined): number => {
  if (family === undefined) return 0;
  let h = 0x811c9dc5;
  for (const ch of family.toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 2 ** 32;
};

/**
 * The token vector (16 numbers): mean and spread of OKLCH lightness, mean and peak chroma, a
 * chroma-weighted hue histogram in 8 bins, the display and body font, the median radius and the
 * median spacing (density), each scaled to about 0–1.
 */
export const tokenVector = (tokens: DesignTokens): number[] => {
  const lch = tokens.colors.map((c) => toOklch(c.lab));
  const ls = lch.map((c) => c.l);
  const mean = (v: readonly number[]): number =>
    v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
  const meanL = mean(ls);
  const stdL = Math.sqrt(mean(ls.map((l) => (l - meanL) ** 2)));
  const hues = new Array<number>(8).fill(0);
  for (const c of lch) hues[Math.floor(c.h / 45) % 8] = (hues[Math.floor(c.h / 45) % 8] ?? 0) + c.c;
  const hueTotal = hues.reduce((a, b) => a + b, 0);
  const pick = (re: RegExp): string | undefined =>
    tokens.fonts.find((f) => re.test(f.name))?.families[0];
  const display = pick(/display|heading|title|headline/i) ?? tokens.fonts[0]?.families[0];
  const body = pick(/body|text|copy|base/i) ?? tokens.fonts[1]?.families[0] ?? display;
  const radius = median((tokens.radii.length > 0 ? tokens.radii : []).map((r) => r.px));
  const spacing = median(
    tokens.lengths
      .filter((l) => /space|spacing|gap|padding|margin|size/i.test(l.name))
      .map((l) => l.px),
  );
  const round = (v: number): number => Number(v.toFixed(6));
  return [
    meanL,
    stdL,
    mean(lch.map((c) => c.c)),
    Math.max(0, ...lch.map((c) => c.c)),
    ...hues.map((h) => (hueTotal === 0 ? 0 : h / hueTotal)),
    fontCode(display),
    fontCode(body),
    Math.min(1.5, radius / 32),
    Math.min(1.5, spacing / 32),
  ].map(round);
};

export const tokenDistance = (a: readonly number[], b: readonly number[]): number => {
  const n = Math.max(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += ((a[i] ?? 0) - (b[i] ?? 0)) ** 2;
  return Number(Math.sqrt(sum).toFixed(6));
};

export interface NoveltyInput {
  readonly direction: string;
  /** PNG bytes of the direction's first viewport; `null` when it was not rendered. */
  readonly firstViewport: Uint8Array | null;
  readonly tokens: DesignTokens;
  readonly library: readonly DesignLibraryEntry[];
  readonly thresholds?: NoveltyReport["thresholds"];
}

/** The novelty report of one direction. `unchecked` when its first viewport is missing or unreadable. */
export const checkNovelty = (input: NoveltyInput): NoveltyReport => {
  const thresholds = input.thresholds ?? { ...NOVELTY_THRESHOLDS };
  const vector = tokenVector(input.tokens);
  let phash: string | null = null;
  if (input.firstViewport !== null) {
    try {
      phash = dhash(decodePng(input.firstViewport));
    } catch {
      phash = null;
    }
  }
  if (phash === null) {
    return NoveltyReportSchema.parse({
      v: 1,
      direction: input.direction,
      phash: "0".repeat(16),
      token_vector: vector,
      nearest: [],
      thresholds,
      verdict: "unchecked",
    });
  }
  const hash = phash;
  const score = (n: { phash_distance: number; token_distance: number }): number =>
    n.phash_distance + n.token_distance * 64;
  const isTooSimilar = (n: { phash_distance: number; token_distance: number }): boolean =>
    n.phash_distance < thresholds.phash_distance && n.token_distance < thresholds.token_distance;
  // Judged over the whole library; only the reported list is cut to ten, too-similar ones first.
  const all = input.library.map((entry) => ({
    entry: entry.id,
    phash_distance: hammingDistance(hash, entry.phash),
    token_distance: tokenDistance(vector, entry.token_vector),
  }));
  const tooSimilar = all.some(isTooSimilar);
  const nearest = all
    .sort((a, b) => Number(isTooSimilar(b)) - Number(isTooSimilar(a)) || score(a) - score(b))
    .slice(0, 10);
  return NoveltyReportSchema.parse({
    v: 1,
    direction: input.direction,
    phash: hash,
    token_vector: vector,
    nearest,
    thresholds,
    verdict: tooSimilar ? "too_similar" : "novel",
  });
};

/** `~/.vtc/design-library/<scope>/`: one library per client (`default` without one). */
export const designLibraryDir = (vtcHome: string, scope: string): string =>
  join(vtcHome, DESIGN_LIBRARY_DIR, SlugSchema.parse(scope));

/** The library's valid entries, sorted by id; unreadable files are skipped. */
export const readDesignLibrary = (vtcHome: string, scope: string): DesignLibraryEntry[] => {
  const dir = designLibraryDir(vtcHome, scope);
  if (!existsSync(dir)) return [];
  const entries: DesignLibraryEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parsePersisted(
        DesignLibraryEntrySchema,
        JSON.parse(readFileSync(join(dir, name), "utf8")),
      );
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // not an entry
    }
  }
  return entries;
};

/** Records a chosen direction in the library (§9.1 step 6); returns the file written. */
export const recordDesignChoice = (
  vtcHome: string,
  scope: string,
  entry: DesignLibraryEntry,
): string => {
  const valid = DesignLibraryEntrySchema.parse(entry);
  const file = join(designLibraryDir(vtcHome, scope), `${valid.id}.json`);
  writeRepoFile(
    vtcHome,
    relative(vtcHome, file).split(sep).join("/"),
    `${JSON.stringify(valid, null, 2)}\n`,
    0o600,
  );
  return file;
};
