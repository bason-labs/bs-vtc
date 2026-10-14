/**
 * Token lint (§7.5 step 1, §9 "values come only from tokens"; AD-24 rule 3): literal colours,
 * spacing lengths, radii, font families and shadows a diff added to UI source that are not the
 * project's DTCG tokens. VTC-owned, pure, no browser: it reads only the added lines
 * (`diff-lines.ts`), so only new literals are findings (§7.1). Findings carry rule ids under
 * `VISUAL_RULE_PREFIX.tokenLint` and category `design`; they route to the Engineer.
 */
import { VISUAL_RULE_PREFIX, type ToolFinding } from "@vtc/shared";
import { colorLiterals, deltaE, parseCssColor, toOklab } from "./color.js";
import type { AddedLine } from "./diff-lines.js";
import { lengthPx, nearestColor, onScale, type DesignTokens } from "./tokens.js";

export const TOKEN_LINT_TOOL = "vtc-token-lint";

/** Stylesheets: every declaration is a style. */
const STYLESHEET = /\.(css|scss|sass|less|pcss|styl)$/i;
/** Markup and components: only style contexts count (`style=`, CSS-in-JS, arbitrary classes). */
const MARKUP = /\.(html?|tsx|jsx|vue|svelte|astro|mdx)$/i;

/** Whether token lint and the detector read this changed path. */
export const isUiSource = (path: string): boolean =>
  !path.startsWith(".vtc/") &&
  !/(^|\/)node_modules\//.test(path) &&
  (STYLESHEET.test(path) || MARKUP.test(path));

const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "revert",
  "-apple-system",
  "blinkmacsystemfont",
]);

/** A declaration-like `prop: value` in CSS, inline styles or CSS-in-JS (`prop: "value"`). */
const DECLARATION =
  /(?<![\w-])([a-z-]+|[a-z]+(?:[A-Z][a-z]+)+)\s*:\s*(["'`]?)([^;"'`{}]+)\2\s*[;,}"']?/g;
/** Tailwind arbitrary values: `bg-[#123456]`, `p-[13px]`, `rounded-[7px]`, `text-[13px]`. */
const ARBITRARY = /(?<![\w-])([a-z]+(?:-[a-z]+)*)-\[([^\]\s]+)\]/g;

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const COLOR_PROPS =
  /^(color|background|background-color|border(-(top|right|bottom|left|block|inline))?(-color)?|outline(-color)?|fill|stroke|caret-color|accent-color|text-decoration-color|column-rule-color)$/;
const SPACING_PROPS =
  /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|block|inline|x|y)(-(start|end))?)?$/;
const RADIUS_PROPS = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;

const TW_COLOR =
  /^(bg|text|border(-[trblxy])?|ring|outline|fill|stroke|from|via|to|decoration|accent|caret|divide|placeholder|shadow)$/;
const TW_SPACING =
  /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)$/;
const TW_RADIUS = /^rounded(-(t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?$/;

interface Hit {
  readonly kind: "color" | "length" | "radius" | "font" | "shadow";
  readonly value: string;
  readonly detail: string;
}

export interface TokenLintSettings {
  /** Largest OKLab ΔE between a literal colour and its nearest token. */
  readonly colorDelta: number;
}

const lengthsIn = (value: string): { text: string; px: number }[] =>
  value
    .split(/\s+/)
    .map((part) => ({ text: part, px: lengthPx(part) }))
    .filter((l): l is { text: string; px: number } => l.px !== null && l.px !== 0);

/** One file's literal values that are not tokens, from its added lines. */
const lintLine = (
  path: string,
  text: string,
  tokens: DesignTokens,
  settings: TokenLintSettings,
): Hit[] => {
  const trimmed = text.trim();
  if (trimmed === "" || /^(\/\/|\/\*|\*|<!--)/.test(trimmed)) return [];
  const stylesheet = STYLESHEET.test(path);
  const hits: Hit[] = [];
  const color = (literal: string): void => {
    const rgba = parseCssColor(literal);
    if (rgba === null || tokens.colors.length === 0) return;
    const near = nearestColor(tokens, toOklab(rgba), deltaE);
    if (
      near === null ||
      near.delta > settings.colorDelta ||
      Math.abs(near.token.rgba.a - rgba.a) > 0.02
    ) {
      hits.push({
        kind: "color",
        value: literal,
        detail:
          near === null
            ? "no colour token"
            : `nearest token ${near.token.name} (ΔE ${near.delta.toFixed(3)})`,
      });
    }
  };
  const length = (kind: "length" | "radius", value: string): void => {
    const scale = kind === "radius" && tokens.radii.length > 0 ? tokens.radii : tokens.lengths;
    if (scale.length === 0) return;
    for (const l of lengthsIn(value)) {
      if (kind === "radius" && l.px >= 999) continue;
      const { ok, nearest } = onScale(scale, Math.abs(l.px));
      if (!ok) {
        hits.push({
          kind,
          value: l.text,
          detail:
            nearest === null
              ? "no token scale"
              : `nearest token ${nearest.name} (${String(nearest.px)}px)`,
        });
      }
    }
  };
  for (const m of trimmed.matchAll(DECLARATION)) {
    const prop = kebab(m[1] ?? "");
    const value = (m[3] ?? "").trim();
    if (prop.startsWith("--") || value === "" || /var\(|calc\(|env\(/.test(value)) continue;
    if (!stylesheet && !/[;{"'`]|style/.test(trimmed)) continue;
    if (COLOR_PROPS.test(prop)) {
      for (const literal of colorLiterals(value)) {
        if (!stylesheet && !/^#|\(/.test(literal)) continue;
        color(literal);
      }
    } else if (SPACING_PROPS.test(prop)) length("length", value);
    else if (RADIUS_PROPS.test(prop)) length("radius", value);
    else if (prop === "font-family" && tokens.fonts.length > 0) {
      const first =
        value
          .split(",")[0]
          ?.trim()
          .replace(/^["']|["']$/g, "")
          .toLowerCase() ?? "";
      const known = tokens.fonts.some((f) => f.families.includes(first));
      if (first !== "" && !GENERIC_FONTS.has(first) && !known) {
        hits.push({ kind: "font", value: first, detail: "not a fontFamily token" });
      }
    } else if (prop === "box-shadow" && tokens.shadows.length > 0) {
      const css = value.replace(/\s+/g, " ").trim();
      const neutral = /^(none|inherit|initial|unset|revert)$/.test(css);
      if (!neutral && !tokens.shadows.some((s) => s.css === css)) {
        hits.push({ kind: "shadow", value: css, detail: "not a shadow token" });
      }
    }
  }
  for (const m of trimmed.matchAll(ARBITRARY)) {
    const utility = m[1] ?? "";
    const value = (m[2] ?? "").replaceAll("_", " ");
    if (/var\(|calc\(|theme\(/.test(value)) continue;
    if (TW_COLOR.test(utility) && parseCssColor(value) !== null) color(value);
    else if (TW_SPACING.test(utility)) length("length", value);
    else if (TW_RADIUS.test(utility)) length("radius", value);
  }
  return hits;
};

/**
 * Token lint over the added lines of changed UI files. With no tokens of a kind (no
 * `tokens.json`, or no colour tokens) that kind is not judged: a missing scale is not a finding.
 */
export const tokenLint = (
  added: ReadonlyMap<string, readonly AddedLine[]>,
  tokens: DesignTokens,
  settings: TokenLintSettings,
): ToolFinding[] => {
  const findings: ToolFinding[] = [];
  for (const [path, lines] of [...added].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isUiSource(path)) continue;
    for (const { line, text } of lines) {
      for (const hit of lintLine(path, text, tokens, settings)) {
        findings.push({
          tool: TOKEN_LINT_TOOL,
          rule_id: `${VISUAL_RULE_PREFIX.tokenLint}${hit.kind}`,
          category: "design",
          title: `Literal ${hit.kind} ${hit.value} is not a design token`.slice(0, 200),
          message: `${hit.detail}; use a token from .vtc/design/tokens.json (§9: values come only from tokens)`,
          location: { path, line },
          evidence: { type: "file_line", ref: `${path}:${String(line)}` },
          snippet: text.trim().slice(0, 400),
          sarif_level: "warning",
        });
      }
    }
  }
  return findings;
};
