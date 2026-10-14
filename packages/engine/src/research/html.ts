/**
 * HTML → markdown for the `web` fetcher (spec §10 "web page → markdown"). Pure and dependency
 * free: it keeps the main content (`<main>` or `<article>` when the page has one), drops scripts,
 * styles and page chrome, and turns headings, paragraphs, lists, line breaks and code blocks into
 * markdown. Facts quote this text verbatim (`FactLocator` `quote`), so the output is
 * deterministic for the same input.
 *
 * It is a baseline, not Readability: the research proposes `@mozilla/readability`, `linkedom` and
 * `turndown` for better extraction, which needs the integrator to add them.
 */

const DROP_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "head",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
];

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

/** Decodes named (common) and numeric character references. */
export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code =
        ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });

const dropElement = (html: string, tag: string): string =>
  html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"), " ");

const innerOf = (html: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}\\s*>`, "i").exec(html);
  return match?.[1];
};

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, "");

/** The page's main text as markdown. */
export const htmlToMarkdown = (html: string): string => {
  let text = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DROP_ELEMENTS) text = dropElement(text, tag);
  text = innerOf(text, "main") ?? innerOf(text, "article") ?? innerOf(text, "body") ?? text;

  // Code blocks keep their whitespace: park them behind placeholders while the rest collapses.
  const blocks: string[] = [];
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner: string) => {
    blocks.push(decodeEntities(stripTags(inner)).replace(/^\n+|\n+$/g, ""));
    return `\n\n\uE000${String(blocks.length - 1)}\uE000\n\n`;
  });

  text = text
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => {
      const heading = stripTags(inner).replace(/\s+/g, " ").trim();
      return `\n\n${"#".repeat(Number(level))} ${heading}\n\n`;
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/?(p|div|section|ul|ol|table|tr|blockquote|dl|dt|dd|figure|header)\b[^>]*>/gi,
      "\n\n",
    )
    .replace(/<\/?(td|th)\b[^>]*>/gi, " ")
    .replace(
      /<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi,
      (_m, inner: string) => `\`${stripTags(inner)}\``,
    );

  text = decodeEntities(stripTags(text));
  const lines = text.split("\n").map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim());
  text = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.replace(
    /\uE000(\d+)\uE000/g,
    (_m, i: string) => `\`\`\`\n${blocks[Number(i)] ?? ""}\n\`\`\``,
  );
};
