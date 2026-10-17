/**
 * The project's design tokens (§9: DTCG `tokens.json`, the Designer's `design_tokens` artifact)
 * as the visual step reads them: colours in OKLab, lengths in px, radii, font families and
 * shadows. Token lint, the computed-style check (§7.5 steps 1 and 4) and the novelty check's
 * token vector (§9.1 step 4) compare against these. Pure.
 *
 * Reads the DTCG format: a token is an object with `$value`; `$type` is inherited from the
 * nearest group that sets it; `{group.token}` aliases resolve to the target's value. Both the
 * string forms (`"#0a0a0a"`, `"16px"`) and the object forms (`{ "value": 16, "unit": "px" }`,
 * `{ "colorSpace": "srgb", "components": [...] }`) are read; composite `typography`, `border`
 * and `shadow` tokens contribute their parts.
 */
import { oklabToRgb, parseCssColor, toOklab, type Oklab, type Rgba } from "./color.js";

/** Where the Designer writes the DTCG tokens (git-tracked, §9; `.vtc/design/tokens*`). */
export const DESIGN_TOKENS_PATH = ".vtc/design/tokens.json";

/** Root font size used to turn `rem`/`em` token values into px. */
export const ROOT_FONT_PX = 16;

export interface ColorToken {
  readonly name: string;
  readonly lab: Oklab;
  readonly rgba: Rgba;
}

export interface LengthToken {
  readonly name: string;
  readonly px: number;
}

export interface DesignTokens {
  readonly colors: readonly ColorToken[];
  /** Every dimension token (spacing, sizes, font sizes, radii, border widths). */
  readonly lengths: readonly LengthToken[];
  /** Dimension tokens whose path names a radius (`radius`, `radii`, `rounded`, `corner`). */
  readonly radii: readonly LengthToken[];
  /** Font family names in lower case, by token. */
  readonly fonts: readonly { readonly name: string; readonly families: readonly string[] }[];
  /** Shadow tokens as CSS `box-shadow` text, whitespace-normalised. */
  readonly shadows: readonly { readonly name: string; readonly css: string }[];
}

export const EMPTY_TOKENS: DesignTokens = {
  colors: [],
  lengths: [],
  radii: [],
  fonts: [],
  shadows: [],
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (v: unknown): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const RADIUS_NAME = /radius|radii|rounded|corner/i;

/** A CSS length in px (`px`, `rem`, `em`, unitless 0); `null` for anything else. */
export const lengthPx = (value: unknown): number | null => {
  if (typeof value === "number") return value;
  if (isObject(value) && typeof value.value === "number") {
    const unit = typeof value.unit === "string" ? value.unit : "px";
    return unit === "px"
      ? value.value
      : unit === "rem" || unit === "em"
        ? value.value * ROOT_FONT_PX
        : null;
  }
  if (typeof value !== "string") return null;
  const m = /^\s*(-?\d*\.?\d+)\s*(px|rem|em)?\s*$/i.exec(value);
  if (m?.[1] === undefined) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? (n === 0 ? "px" : "")).toLowerCase();
  if (unit === "px") return n;
  if (unit === "rem" || unit === "em") return n * ROOT_FONT_PX;
  return null;
};

const colorOf = (value: unknown): Rgba | null => {
  if (typeof value === "string") return parseCssColor(value);
  if (!isObject(value)) return null;
  if (typeof value.hex === "string") return parseCssColor(value.hex);
  const components = Array.isArray(value.components) ? value.components : null;
  const alpha = typeof value.alpha === "number" ? value.alpha : 1;
  if (components === null || components.some((c) => typeof c !== "number")) return null;
  const [x, y, z] = components as number[];
  if (x === undefined || y === undefined || z === undefined) return null;
  if (value.colorSpace === "srgb") return { r: x, g: y, b: z, a: alpha };
  if (value.colorSpace === "oklab") return oklabToRgb({ l: x, a: y, b: z }, alpha);
  if (value.colorSpace === "oklch") {
    const rad = (z * Math.PI) / 180;
    return oklabToRgb({ l: x, a: y * Math.cos(rad), b: y * Math.sin(rad) }, alpha);
  }
  return null;
};

const familiesOf = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return list
    .filter((f): f is string => typeof f === "string")
    .map((f) =>
      f
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase(),
    )
    .filter((f) => f !== "");
};

const shadowCss = (value: unknown, resolve: (v: unknown) => unknown): string | null => {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  const layers = Array.isArray(value) ? value : [value];
  const parts: string[] = [];
  for (const layer of layers) {
    if (!isObject(layer)) return null;
    const len = (k: string): string => {
      const px = lengthPx(resolve(layer[k]));
      return `${String(px ?? 0)}px`;
    };
    const color = colorOf(resolve(layer.color));
    const rgb =
      color === null
        ? "transparent"
        : `rgba(${[color.r, color.g, color.b].map((c) => String(Math.round(c * 255))).join(", ")}, ${String(color.a)})`;
    parts.push(
      `${layer.inset === true ? "inset " : ""}${len("offsetX")} ${len("offsetY")} ${len("blur")} ${len("spread")} ${rgb}`,
    );
  }
  return parts.join(", ");
};

/** Parses DTCG token JSON; tolerant: tokens it cannot read are skipped, never fatal. */
export const parseDesignTokens = (text: string): DesignTokens => {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return EMPTY_TOKENS;
  }
  if (!isObject(root)) return EMPTY_TOKENS;
  const tokens = new Map<string, { type: string | undefined; value: Json }>();
  const walk = (
    node: Record<string, Json>,
    path: string[],
    inherited: string | undefined,
  ): void => {
    const type = typeof node.$type === "string" ? node.$type : inherited;
    if ("$value" in node) {
      tokens.set(path.join("."), { type, value: node.$value ?? null });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$") || !isObject(child)) continue;
      walk(child, [...path, key], type);
    }
  };
  walk(root, [], undefined);

  const resolve = (value: unknown, depth = 0): unknown => {
    if (depth > 16 || typeof value !== "string") return value;
    const m = /^\{([^{}]+)\}$/.exec(value.trim());
    if (m?.[1] === undefined) return value;
    const target = tokens.get(m[1]);
    return target === undefined ? null : resolve(target.value, depth + 1);
  };
  const typeOf = (name: string, depth = 0): string | undefined => {
    const token = tokens.get(name);
    if (token === undefined) return undefined;
    if (token.type !== undefined || depth > 16) return token.type;
    const m = typeof token.value === "string" ? /^\{([^{}]+)\}$/.exec(token.value.trim()) : null;
    return m?.[1] === undefined ? undefined : typeOf(m[1], depth + 1);
  };

  const colors: ColorToken[] = [];
  const lengths: LengthToken[] = [];
  const radii: LengthToken[] = [];
  const fonts: { name: string; families: string[] }[] = [];
  const shadows: { name: string; css: string }[] = [];
  const addLength = (name: string, raw: unknown): void => {
    const px = lengthPx(resolve(raw));
    if (px === null) return;
    lengths.push({ name, px });
    if (RADIUS_NAME.test(name)) radii.push({ name, px });
  };
  const addColor = (name: string, raw: unknown): void => {
    const rgba = colorOf(resolve(raw));
    if (rgba !== null) colors.push({ name, rgba, lab: toOklab(rgba) });
  };
  for (const [name, token] of tokens) {
    const type = typeOf(name);
    const value = resolve(token.value);
    if (type === "color") addColor(name, value);
    else if (type === "dimension") addLength(name, value);
    else if (type === "fontFamily") {
      const families = familiesOf(value);
      if (families.length > 0) fonts.push({ name, families });
    } else if (type === "shadow") {
      const css = shadowCss(value, (v) => resolve(v));
      if (css !== null) shadows.push({ name, css });
    } else if (type === "typography" && isObject(value)) {
      const families = familiesOf(resolve(value.fontFamily));
      if (families.length > 0) fonts.push({ name: `${name}.fontFamily`, families });
      addLength(`${name}.fontSize`, value.fontSize);
    } else if (type === "border" && isObject(value)) {
      addColor(`${name}.color`, value.color);
      addLength(`${name}.width`, value.width);
    }
  }
  return { colors, lengths, radii, fonts, shadows };
};

/** The colour token nearest to `lab`, with its ΔE; `null` when there are no colour tokens. */
export const nearestColor = (
  tokens: Pick<DesignTokens, "colors">,
  lab: Oklab,
  distance: (x: Oklab, y: Oklab) => number,
): { token: ColorToken; delta: number } | null => {
  let best: { token: ColorToken; delta: number } | null = null;
  for (const token of tokens.colors) {
    const delta = distance(token.lab, lab);
    if (best === null || delta < best.delta) best = { token, delta };
  }
  return best;
};

/** Whether `px` sits on the scale (within half a pixel), and the nearest token. */
export const onScale = (
  scale: readonly LengthToken[],
  px: number,
): { ok: boolean; nearest: LengthToken | null } => {
  let nearest: LengthToken | null = null;
  for (const token of scale) {
    if (nearest === null || Math.abs(token.px - px) < Math.abs(nearest.px - px)) nearest = token;
  }
  return { ok: nearest !== null && Math.abs(nearest.px - px) <= 0.5, nearest };
};
