/**
 * HTML → markdown for the `web` fetcher (spec §10 "web page → markdown"). Pure and dependency
 * free: it keeps the main content (`<main>` or `<article>` when the page has one), drops scripts,
 * styles and page chrome, and turns headings, paragraphs, lists, line breaks and code blocks into
 * markdown. Facts quote this text verbatim (`FactLocator` `quote`), so the output is
 * deterministic for the same input.
 *
 * The page is untrusted, up to `RESEARCH_HTTP_LIMITS.maxBytes`, and this runs on the engine's one
 * thread, so the conversion is linear: one pass splits the page into tokens (text, tags) with
 * `indexOf` scans, and every later step walks the tokens once. No regular expression here runs
 * over markup, so many unclosed `<`, `<script` or `<!--` cost one pass, not a square.
 *
 * It is a baseline, not Readability: the research proposes `@mozilla/readability`, `linkedom` and
 * `turndown` for better extraction, which needs the integrator to add them.
 */

const DROP_ELEMENTS = new Set([
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
]);

const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "section",
  "ul",
  "ol",
  "table",
  "tr",
  "blockquote",
  "dl",
  "dt",
  "dd",
  "figure",
  "header",
]);

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

/** Decodes named (common) and numeric character references. Linear: every match starts at `&`. */
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

type Token =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tag"; readonly name: string; readonly closing: boolean };

const isAsciiLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isNameChar = (code: number): boolean =>
  isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 45;

/**
 * Splits the page into tokens in one left-to-right pass:
 * - `<!--` runs to its `-->` (a comment never closed is text from there on);
 * - `<name` / `</name` up to the next `>` is a tag, and `<!…>` / `<?…>` markup is dropped;
 * - any other `<`, and a `<` with no `>` anywhere after it, is text.
 */
const tokenize = (html: string): Token[] => {
  const tokens: Token[] = [];
  let pos = 0;
  let text = "";
  const flush = (): void => {
    if (text !== "") tokens.push({ kind: "text", text });
    text = "";
  };
  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open === -1) {
      text += html.slice(pos);
      break;
    }
    text += html.slice(pos, open);
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end === -1) {
        text += html.slice(open);
        break;
      }
      text += " ";
      pos = end + 3;
      continue;
    }
    const closing = html.charCodeAt(open + 1) === 47; // "/"
    const nameAt = open + (closing ? 2 : 1);
    const first = html.charCodeAt(nameAt);
    const markup = !closing && (first === 33 || first === 63); // "!" or "?"
    if (!isAsciiLetter(first) && !markup) {
      text += "<";
      pos = open + 1;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      // No `>` after this `<`, so no later `<` can open a tag either.
      text += html.slice(open);
      break;
    }
    if (!markup) {
      let end = nameAt;
      while (end < close && isNameChar(html.charCodeAt(end))) end += 1;
      flush();
      tokens.push({ kind: "tag", name: html.slice(nameAt, end).toLowerCase(), closing });
    }
    pos = close + 1;
  }
  flush();
  return tokens;
};

const isTag = (token: Token | undefined, name: string, closing: boolean): boolean =>
  token?.kind === "tag" && token.name === name && token.closing === closing;

/**
 * Finds the first closing tag of a name at or after a position. Callers move left to right and
 * skip past what they found, so each name's cursor only moves forward: linear overall.
 */
const closingFinder = (tokens: readonly Token[]): ((name: string, from: number) => number) => {
  const cursor = new Map<string, number>();
  return (name, from) => {
    let at = Math.max(cursor.get(name) ?? 0, from);
    while (at < tokens.length && !isTag(tokens[at], name, true)) at += 1;
    cursor.set(name, at);
    return at < tokens.length ? at : -1;
  };
};

/** Removes the dropped elements: an opening tag up to the first matching closing tag. */
const dropElements = (tokens: readonly Token[]): Token[] => {
  const out: Token[] = [];
  const closingOf = closingFinder(tokens);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind === "tag" && !token.closing && DROP_ELEMENTS.has(token.name)) {
      const end = closingOf(token.name, i + 1);
      if (end !== -1) {
        out.push({ kind: "text", text: " " });
        i = end;
        continue;
      }
    }
    out.push(token);
  }
  return out;
};

/** The tokens between the first `<name>` and the last `</name>` after it, or `undefined`. */
const innerOf = (tokens: readonly Token[], name: string): Token[] | undefined => {
  const first = tokens.findIndex((t) => isTag(t, name, false));
  if (first === -1) return undefined;
  for (let last = tokens.length - 1; last > first; last -= 1) {
    if (isTag(tokens[last], name, true)) return tokens.slice(first + 1, last);
  }
  return undefined;
};

/** The text of tokens with every tag stripped. */
const textOf = (tokens: readonly Token[]): string =>
  tokens.map((t) => (t.kind === "text" ? t.text : "")).join("");

const trimNewlines = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "\n") start += 1;
  while (end > start && text[end - 1] === "\n") end -= 1;
  return text.slice(start, end);
};

const HEADINGS: Readonly<Record<string, number>> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** The page's main text as markdown. */
export const htmlToMarkdown = (html: string): string => {
  const all = dropElements(tokenize(html));
  const tokens = innerOf(all, "main") ?? innerOf(all, "article") ?? innerOf(all, "body") ?? all;

  const closingOf = closingFinder(tokens);
  // Code blocks keep their whitespace: park them behind placeholders while the rest collapses.
  const blocks: string[] = [];
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind === "text") {
      parts.push(token.text);
      continue;
    }
    const { name, closing } = token;
    const level = HEADINGS[name];
    if (!closing && (name === "pre" || name === "code" || level !== undefined)) {
      const end = closingOf(name, i + 1);
      if (end !== -1) {
        const inner = textOf(tokens.slice(i + 1, end));
        i = end;
        if (name === "pre") {
          blocks.push(trimNewlines(decodeEntities(inner)));
          parts.push(`\n\n\uE000${String(blocks.length - 1)}\uE000\n\n`);
        } else if (name === "code") {
          parts.push(`\`${inner}\``);
        } else {
          parts.push(`\n\n${"#".repeat(level ?? 1)} ${inner.replace(/\s+/g, " ").trim()}\n\n`);
        }
        continue;
      }
    }
    if (name === "li" && !closing) parts.push("\n- ");
    else if (name === "br") parts.push("\n");
    else if (BLOCK_ELEMENTS.has(name)) parts.push("\n\n");
    else if (name === "td" || name === "th") parts.push(" ");
  }

  const text = decodeEntities(parts.join(""));
  const lines = text.split("\n").map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim());
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\uE000(\d+)\uE000/g, (_m, i: string) => `\`\`\`\n${blocks[Number(i)] ?? ""}\n\`\`\``);
};
