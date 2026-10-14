/**
 * CSS colour parsing and OKLab/OKLCH maths for the visual step (§7.5 step 4, AD-24): computed
 * styles and literal colours are compared with the DTCG tokens by OKLab ΔE
 * (`VISUAL_DEFAULTS.color_delta`), and the novelty check's token vector reads OKLCH. Pure.
 */

/** sRGB in 0–1 per channel, alpha 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

export interface Oklch {
  readonly l: number;
  readonly c: number;
  /** Degrees 0–360. */
  readonly h: number;
}

/** The CSS basic colour keywords and `transparent`; other names are not literals we can check. */
const NAMED: Readonly<Record<string, string>> = {
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  white: "#ffffff",
  maroon: "#800000",
  red: "#ff0000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  green: "#008000",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  aqua: "#00ffff",
  orange: "#ffa500",
  transparent: "#00000000",
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const hex = (text: string): Rgba | null => {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (m?.[1] === undefined) return null;
  let digits = m[1];
  if (digits.length <= 4) digits = digits.replace(/./g, (d) => d + d);
  const byte = (i: number): number => parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;
  return { r: byte(0), g: byte(1), b: byte(2), a: digits.length === 8 ? byte(3) : 1 };
};

/** Splits `fn(a, b, c / d)` or `fn(a b c / d)` arguments; `null` when the text is not `fn(…)`. */
const args = (text: string, names: readonly string[]): string[] | null => {
  const m = /^([a-z]+)\(([^()]*)\)$/i.exec(text);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  if (!names.includes(m[1].toLowerCase())) return null;
  const parts = m[2]
    .replace("/", " / ")
    .split(/[\s,]+/)
    .filter((p) => p !== "");
  return parts;
};

const number = (part: string | undefined, percentOf = 1): number | null => {
  if (part === undefined) return null;
  const m = /^(-?\d*\.?\d+)(%|deg|turn|rad)?$/i.exec(part);
  if (m?.[1] === undefined) return null;
  const v = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === "%") return (v / 100) * percentOf;
  if (unit === "turn") return v * 360;
  if (unit === "rad") return (v * 180) / Math.PI;
  return v;
};

const alphaOf = (parts: readonly string[]): number | null => {
  const slash = parts.indexOf("/");
  const raw = slash >= 0 ? parts[slash + 1] : parts.length === 4 ? parts[3] : undefined;
  if (raw === undefined) return 1;
  const v = number(raw, 1);
  return v === null ? null : clamp01(v);
};

const channels = (parts: readonly string[]): string[] => parts.filter((p) => p !== "/").slice(0, 3);

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
};

const linear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const gamma = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** OKLab → sRGB (clamped into the gamut). */
export const oklabToRgb = (lab: Oklab, alpha = 1): Rgba => {
  const l = Math.pow(lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
  const m = Math.pow(lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
  const s = Math.pow(lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return { r: clamp01(gamma(r)), g: clamp01(gamma(g)), b: clamp01(gamma(b)), a: alpha };
};

/**
 * Parses a CSS colour literal: hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`, `oklab()`
 * and the basic keywords. `null` for anything else (`var()`, `currentColor`, `color-mix()`…),
 * which is not a literal the token checks can judge.
 */
export const parseCssColor = (input: string): Rgba | null => {
  const text = input.trim().toLowerCase();
  const named = NAMED[text];
  if (named !== undefined) return hex(named);
  if (text.startsWith("#")) return hex(text);
  const rgb = args(text, ["rgb", "rgba"]);
  if (rgb !== null) {
    const [r, g, b] = channels(rgb).map((p) => number(p, 255));
    const a = alphaOf(rgb);
    if (r == null || g == null || b == null || a === null) return null;
    return { r: clamp01(r / 255), g: clamp01(g / 255), b: clamp01(b / 255), a };
  }
  const hsl = args(text, ["hsl", "hsla"]);
  if (hsl !== null) {
    const [hRaw, sRaw, lRaw] = channels(hsl);
    const h = number(hRaw);
    const s = number(sRaw, 1);
    const l = number(lRaw, 1);
    const a = alphaOf(hsl);
    if (h === null || s === null || l === null || a === null) return null;
    const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, clamp01(s), clamp01(l));
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a };
  }
  const oklch = args(text, ["oklch"]);
  if (oklch !== null) {
    const [lRaw, cRaw, hRaw] = channels(oklch);
    const l = number(lRaw, 1);
    const c = number(cRaw, 0.4);
    const h = number(hRaw) ?? 0;
    const a = alphaOf(oklch);
    if (l === null || c === null || a === null) return null;
    const rad = (h * Math.PI) / 180;
    return oklabToRgb({ l, a: c * Math.cos(rad), b: c * Math.sin(rad) }, a);
  }
  const oklab = args(text, ["oklab"]);
  if (oklab !== null) {
    const [lRaw, aRaw, bRaw] = channels(oklab);
    const l = number(lRaw, 1);
    const ca = number(aRaw, 0.4);
    const cb = number(bRaw, 0.4);
    const a = alphaOf(oklab);
    if (l === null || ca === null || cb === null || a === null) return null;
    return oklabToRgb({ l, a: ca, b: cb }, a);
  }
  return null;
};

/** sRGB → OKLab (Björn Ottosson's matrices). Alpha is ignored. */
export const toOklab = (rgb: Rgba): Oklab => {
  const r = linear(rgb.r);
  const g = linear(rgb.g);
  const b = linear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
};

export const toOklch = (lab: Oklab): Oklch => {
  const c = Math.hypot(lab.a, lab.b);
  const h = c < 1e-6 ? 0 : ((((Math.atan2(lab.b, lab.a) * 180) / Math.PI) % 360) + 360) % 360;
  return { l: lab.l, c, h };
};

/** ΔE in OKLab (Euclidean distance). */
export const deltaE = (x: Oklab, y: Oklab): number => Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);

/** Every colour literal in a CSS value: hex, colour functions and basic keywords. */
export const colorLiterals = (value: string): string[] => {
  const out: string[] = [];
  const re =
    /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\([^()]*\)|\b(?:black|silver|gr[ae]y|white|maroon|red|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua|orange)\b/gi;
  for (const m of value.matchAll(re)) out.push(m[0]);
  return out;
};
