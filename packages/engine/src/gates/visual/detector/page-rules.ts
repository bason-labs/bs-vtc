/*
 * Derived from impeccable (https://github.com/pbakaus/impeccable) at
 * 2f98774f86bc05563876643db37e6c37c322850f, crates/detect/src/regex_matchers.rs
 * (`REGEX_ANALYZERS`: monotonous spacing, em-dash overuse, marketing buzzwords, aphoristic
 * cadence, marquee) and crates/core/src/checks/{html_patterns,css_scan}.rs (theater framing,
 * the marquee element), with the thresholds of crates/foundation/src/constants.rs.
 * Copyright 2025 Paul Bakaus. Licensed under the Apache License, Version 2.0
 * (THIRD_PARTY/impeccable/LICENSE). Modified by VTC: ported from Rust to TypeScript, UTF-16
 * bookkeeping replaced by JavaScript string indices, and the marquee keyframe scan left out
 * (only the `<marquee>` element is detected).
 */

/** One page-level hit: the rule, a short description and the line it starts on, if known. */
export interface PageHit {
  readonly rule: string;
  readonly snippet: string;
  readonly line?: number;
}

/** Fewest em-dashes that can count as saturation. */
export const EM_DASH_FLOOR = 8;
/** At most this many characters of body text per em-dash for saturation. */
export const EM_DASH_CHARS_PER_DASH = 500;

const BUZZWORDS: readonly string[] = [
  "streamline your",
  "empower your",
  "supercharge your",
  "unleash your",
  "unleash the power",
  "leverage the power",
  "built for the modern",
  "trusted by leading",
  "trusted by the world",
  "best-in-class",
  "industry-leading",
  "world-class",
  "enterprise-grade",
  "next-generation",
  "cutting-edge",
  "transform your business",
  "revolutionize",
  "game-changer",
  "game changing",
  "mission-critical",
  "best of breed",
  "future-proof",
  "future proof",
  "seamless experience",
  "seamlessly integrate",
  "drive engagement",
  "drive growth",
  "drive results",
  "harness the power",
];

const THEATER_HEADS: ReadonlySet<string> = new Set([
  "accessibility",
  "accountability",
  "agile",
  "alignment",
  "compliance",
  "diversity",
  "engagement",
  "governance",
  "growth",
  "hiring",
  "hygiene",
  "innovation",
  "inclusion",
  "kindness",
  "leadership",
  "metrics",
  "privacy",
  "process",
  "productivity",
  "quality",
  "safety",
  "security",
  "strategy",
  "sustainability",
  "transparency",
  "trust",
  "wellness",
]);

/** Visible text of markup: scripts, styles, comments and tags removed, whitespace collapsed. */
export const stripHtmlToText = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

const lineOf = (content: string, index: number): number =>
  content.slice(0, index).split("\n").length;

export const monotonousSpacing = (content: string): PageHit | null => {
  const values: number[] = [];
  for (const m of content.matchAll(
    /(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*(\d+)px/gi,
  )) {
    const v = Number(m[1]);
    if (v > 0 && v < 200) values.push(v);
  }
  for (const m of content.matchAll(
    /(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*([0-9.]+)rem/gi,
  )) {
    const v = Math.round(Number(m[1]) * 16);
    if (v > 0 && v < 200) values.push(v);
  }
  for (const m of content.matchAll(/gap\s*:\s*(\d+)px/gi)) values.push(Number(m[1]));
  for (const m of content.matchAll(
    /(?<![\w-])(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap)-(\d+)(?![\w-])/g,
  )) {
    values.push(Number(m[1]) * 4);
  }
  const rounded = values.map((v) => Math.round(v / 4) * 4);
  if (rounded.length < 10) return null;
  const counts = new Map<number, number>();
  for (const v of rounded) counts.set(v, (counts.get(v) ?? 0) + 1);
  const ordered = [...counts].sort(([a, ca], [b, cb]) => cb - ca || a - b);
  const [dominant, max] = ordered[0] ?? [0, 0];
  const pct = max / rounded.length;
  const unique = [...counts.keys()].filter((v) => v > 0);
  if (pct <= 0.6 || unique.length > 3) return null;
  return {
    rule: "monotonous-spacing",
    snippet: `~${String(dominant)}px used ${String(max)}/${String(rounded.length)} times (${String(Math.round(pct * 100))}%)`,
  };
};

const countEmDashes = (text: string): number => {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "—") count += 1;
    else if (text[i] === "-" && text[i + 1] === "-") {
      const after = text[i + 2];
      if (after !== undefined && !/\s/.test(after)) {
        count += 1;
        i += 1;
      }
    }
  }
  return count;
};

export const emDashOveruse = (content: string): PageHit | null => {
  const text = stripHtmlToText(content).replace(/&mdash;|&#0*8212;|&#x0*2014;/gi, "—");
  const count = countEmDashes(text);
  if (count < EM_DASH_FLOOR || text.length > count * EM_DASH_CHARS_PER_DASH) return null;
  return { rule: "em-dash-overuse", snippet: `${String(count)} em-dashes in body text` };
};

export const marketingBuzzword = (content: string): PageHit | null => {
  const text = stripHtmlToText(content);
  const lower = text.toLowerCase();
  let count = 0;
  let sample = "";
  for (const phrase of BUZZWORDS) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(phrase, from);
      if (idx < 0) break;
      count += 1;
      if (sample === "") {
        sample = text.slice(Math.max(0, idx - 12), idx + phrase.length + 12).trim();
      }
      from = idx + phrase.length;
    }
  }
  if (count === 0) return null;
  return {
    rule: "marketing-buzzword",
    snippet: `${String(count)} buzzword phrase${count === 1 ? "" : "s"}: "${sample}"`,
  };
};

export const aphoristicCadence = (content: string): PageHit | null => {
  const text = stripHtmlToText(content);
  const matches = [
    ...text.matchAll(/\bNot an? [a-z][^.!?]{1,40}[.!]\s+[A-Z][^.!?]{1,60}[.!]/g),
    ...text.matchAll(/\b[A-Z][^.!?]{4,80}[.!]\s+(?:No|Just)\s+[a-z][^.!?]{2,60}[.!]/g),
  ];
  if (matches.length < 3) return null;
  return {
    rule: "aphoristic-cadence",
    snippet: `${String(matches.length)} aphoristic constructions: "${(matches[0]?.[0] ?? "").trim().slice(0, 80)}"`,
  };
};

export const marquee = (content: string): PageHit | null => {
  const m = /<marquee\b/i.exec(content);
  return m === null
    ? null
    : { rule: "marquee", snippet: "<marquee> element", line: lineOf(content, m.index) };
};

export const theaterPhrase = (content: string): PageHit | null => {
  const text = stripHtmlToText(content);
  for (const m of text.matchAll(/\b(\w+)\s+theater\b/gi)) {
    if (THEATER_HEADS.has((m[1] ?? "").toLowerCase())) {
      return { rule: "theater-slop-phrase", snippet: `"${m[0].trim()}"` };
    }
  }
  return null;
};

/** Analyzers that read visible copy: they run on markup and components, not stylesheets. */
export const TEXT_ANALYZERS = [
  emDashOveruse,
  marketingBuzzword,
  aphoristicCadence,
  theaterPhrase,
  marquee,
];
/** Analyzers that read styles: they run on every UI file. */
export const STYLE_ANALYZERS = [monotonousSpacing];
