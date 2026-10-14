/*
 * Derived from impeccable (https://github.com/pbakaus/impeccable) at
 * 2f98774f86bc05563876643db37e6c37c322850f, crates/detect/src/regex_matchers.rs
 * (`REGEX_MATCHERS`) and crates/foundation/src/{constants,fonts}.rs.
 * Copyright 2025 Paul Bakaus. Licensed under the Apache License, Version 2.0
 * (THIRD_PARTY/impeccable/LICENSE). Modified by VTC: ported from Rust to TypeScript regular
 * expressions (lookbehind instead of the hand-written boundary helpers), the stripe-child
 * variant of side-tab left out, and the neutral-colour test reimplemented on VTC's colour parser.
 */
import { parseCssColor } from "../color.js";

/** One line-level match: the rule, the matched text and its offset in the line. */
export interface LineHit {
  readonly rule: string;
  readonly snippet: string;
}

interface Matcher {
  readonly rule: string;
  readonly re: RegExp;
  readonly test: (m: RegExpMatchArray, line: string) => boolean;
  readonly fmt?: (m: RegExpMatchArray, line: string) => string;
}

/** The faces generated interfaces converge on (upstream `OVERUSED_FONTS`). */
export const OVERUSED_FONTS: readonly string[] = [
  "inter",
  "roboto",
  "open sans",
  "lato",
  "montserrat",
  "arial",
  "helvetica",
  "fraunces",
  "instrument sans",
  "instrument serif",
  "geist",
  "geist sans",
  "geist mono",
  "mona sans",
  "plus jakarta sans",
  "space grotesk",
  "recoleta",
];

const num = (s: string | undefined): number => Number(s ?? "NaN");

const hasRounded = (text: string): boolean =>
  /(?<![\w-])rounded(?:-[\w]+)?(?![\w-])/.test(
    text.replace(/(?<![\w-])rounded-none(?![\w-])/g, ""),
  );
const hasBorderRadius = (text: string): boolean => /border-radius/i.test(text);
/** Elements where a side border is a convention, not decoration (quotes, nav, code, links, inputs). */
const isSafeElement = (line: string): boolean =>
  /<(?:blockquote|nav[\s>]|pre[\s>]|code[\s>]|a\s|input[\s>]|span[\s>])/i.test(line);

/** Upstream `isNeutralAuthoredColor`: keywords, or channels within 30/255 of each other. */
const isNeutralColor = (raw: string): boolean => {
  const c = raw.trim().toLowerCase();
  if (
    /^(transparent|currentcolor|black|white|gr[ae]y|silver|dimgr[ae]y|darkgr[ae]y|lightgr[ae]y|gainsboro|whitesmoke)$/.test(
      c,
    )
  ) {
    return true;
  }
  const rgb = parseCssColor(c);
  if (rgb === null) return false;
  const channels = [rgb.r, rgb.g, rgb.b].map((v) => v * 255);
  return Math.max(...channels) - Math.min(...channels) < 30;
};

const isNeutralBorder = (decl: string): boolean => {
  const m =
    /solid\s+((?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^)]*\)|#[0-9a-f]{3,8}\b|[a-z]+)/i.exec(
      decl,
    );
  return m?.[1] !== undefined && isNeutralColor(m[1]);
};

/** The `<…>` tag around `index`, or the whole line when the match is not inside a tag. */
const containingTag = (line: string, index: number): string => {
  const open = line.lastIndexOf("<", index);
  if (open < 0 || line.lastIndexOf(">", index - 1) > open) return line;
  const close = line.indexOf(">", index);
  return close < 0 ? line.slice(open) : line.slice(open, close + 1);
};

/** Families named in a Google Fonts URL (`family=Inter:wght@400|Open+Sans`), lower case. */
export const googleFontFamilies = (url: string): string[] => {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1).replaceAll("&amp;", "&") : "";
  const out: string[] = [];
  for (const pair of query.split("&")) {
    const [name, value = ""] = pair.split("=");
    if (name !== "family") continue;
    let decoded = value.replaceAll("+", " ");
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // keep the raw text
    }
    for (const part of decoded.split("|")) {
      const family = (part.split(":")[0] ?? "").trim().toLowerCase();
      if (family !== "") out.push(family);
    }
  }
  return out;
};

const OVERUSED_FONT_RE = new RegExp(
  `font-family\\s*:\\s*['"]?(${OVERUSED_FONTS.map((f) => f.replace(" ", "\\s")).join("|")})\\b`,
  "gi",
);

const MATCHERS: readonly Matcher[] = [
  {
    rule: "side-tab",
    re: /(?<![\w-])border-[lrse]-(\d+)(?![\w-])/g,
    test: (m, line) => num(m[1]) >= (hasRounded(line) ? 2 : 4),
  },
  {
    rule: "side-tab",
    re: /border-(?:left|right)\s*:\s*(\d+)px\s+solid[^;"'}]*/gi,
    test: (m, line) =>
      !isSafeElement(line) &&
      !isNeutralBorder(m[0]) &&
      num(m[1]) >= (hasBorderRadius(line) ? 2 : 3),
    fmt: (m) => m[0].replace(/\s*;?\s*$/, ""),
  },
  {
    rule: "side-tab",
    re: /border-(?:left|right)-width\s*:\s*(\d+)px/gi,
    test: (m, line) => !isSafeElement(line) && num(m[1]) >= 3,
  },
  {
    rule: "side-tab",
    re: /border-inline-(?:start|end)\s*:\s*(\d+)px\s+solid/gi,
    test: (m, line) => !isSafeElement(line) && num(m[1]) >= 3,
  },
  {
    rule: "side-tab",
    re: /border-inline-(?:start|end)-width\s*:\s*(\d+)px/gi,
    test: (m, line) => !isSafeElement(line) && num(m[1]) >= 3,
  },
  {
    rule: "side-tab",
    re: /border(?:Left|Right)\s*[:=]\s*["'`](\d+)px\s+solid/g,
    test: (m) => num(m[1]) >= 3,
  },
  {
    rule: "border-accent-on-rounded",
    re: /(?<![\w-])border-[tb]-(\d+)(?![\w-])/g,
    test: (m, line) => {
      const scope = containingTag(line, m.index ?? 0);
      return hasRounded(scope) && num(m[1]) >= 1 && !/(?<![\w-])animate-spin(?![\w-])/.test(scope);
    },
  },
  {
    rule: "border-accent-on-rounded",
    re: /border-(?:top|bottom)\s*:\s*(\d+)px\s+solid/gi,
    test: (m, line) => num(m[1]) >= 3 && hasBorderRadius(line),
  },
  { rule: "overused-font", re: OVERUSED_FONT_RE, test: () => true },
  {
    rule: "overused-font",
    re: /fonts\.googleapis\.com\/css2?\?[^"'\s)<>]*/gi,
    test: (m) => googleFontFamilies(m[0]).some((f) => OVERUSED_FONTS.includes(f)),
    fmt: (m) =>
      `Google Fonts: ${googleFontFamilies(m[0]).find((f) => OVERUSED_FONTS.includes(f)) ?? ""}`,
  },
  {
    rule: "gradient-text",
    re: /(?:-webkit-)?background-clip\s*:\s*text/gi,
    test: (_m, line) => /gradient/i.test(line),
    fmt: () => "background-clip: text + gradient",
  },
  {
    rule: "gradient-text",
    re: /(?<![\w-])bg-clip-text(?![\w-])/g,
    test: (_m, line) => /(?<![\w-])bg-gradient-to-/i.test(line),
    fmt: () => "bg-clip-text + bg-gradient",
  },
  {
    rule: "ai-color-palette",
    re: /(?<![\w-])text-(?:purple|violet|indigo)-(\d+)(?![\w-])/g,
    test: (_m, line) => /(?<![\w-])text-(?:[2-9]xl)(?![\w-])|<h[1-3]/i.test(line),
    fmt: (m) => `${m[0]} on heading`,
  },
  {
    rule: "ai-color-palette",
    re: /(?<![\w-])from-(?:purple|violet|indigo)-(\d+)(?![\w-])/g,
    test: (_m, line) =>
      /(?<![\w-])to-(?:purple|violet|indigo|blue|cyan|pink|fuchsia)-\d+(?![\w-])/.test(line),
    fmt: (m) => `${m[0]} gradient`,
  },
  {
    rule: "bounce-easing",
    re: /(?<![\w-])animate-bounce(?![\w-])/g,
    test: () => true,
    fmt: () => "animate-bounce (Tailwind)",
  },
  {
    rule: "bounce-easing",
    re: /animation(?:-name)?\s*:\s*([^;{}]*(?:bounce|elastic|wobble|jiggle|spring)[^;{}]*)/gi,
    test: () => true,
    fmt: (m) => {
      const token = (m[1] ?? "")
        .split(/[,\s]+/)
        .find((part) => /bounce|elastic|wobble|jiggle|spring/i.test(part));
      return `animation: ${token ?? (m[1] ?? "").trim()}`;
    },
  },
  {
    rule: "bounce-easing",
    re: /cubic-bezier\(\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*\)/g,
    test: (m) => {
      const y1 = num(m[2]);
      const y2 = num(m[4]);
      return y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1;
    },
    fmt: (m) => `cubic-bezier(${m[1] ?? ""}, ${m[2] ?? ""}, ${m[3] ?? ""}, ${m[4] ?? ""})`,
  },
];

/** Every line-level hit in one line, in matcher order. */
export const matchLine = (line: string): LineHit[] => {
  const hits: LineHit[] = [];
  for (const matcher of MATCHERS) {
    for (const m of line.matchAll(matcher.re)) {
      if (!matcher.test(m, line)) continue;
      hits.push({ rule: matcher.rule, snippet: (matcher.fmt?.(m, line) ?? m[0]).slice(0, 200) });
    }
  }
  return hits;
};
