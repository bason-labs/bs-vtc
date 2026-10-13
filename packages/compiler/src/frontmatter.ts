/** YAML frontmatter of Markdown sources (SKILL.md, command files). */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type FrontmatterCheck =
  | { readonly ok: true; readonly data: Readonly<Record<string, unknown>>; readonly body: string }
  | { readonly ok: false; readonly error: string };

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Splits `---\n<yaml>\n---\n<body>`; the YAML must be a mapping. */
export const parseFrontmatter = (text: string): FrontmatterCheck => {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = FRONTMATTER.exec(normalized);
  if (match?.[1] === undefined) return { ok: false, error: "missing YAML frontmatter" };
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `frontmatter: ${message.split("\n")[0] ?? message}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "frontmatter must be a YAML mapping" };
  }
  return {
    ok: true,
    data: data as Record<string, unknown>,
    body: normalized.slice(match[0].length),
  };
};

/** Renders frontmatter plus body. Keys keep their insertion order; strings are quoted only when YAML needs it. */
export const renderFrontmatter = (data: Readonly<Record<string, string>>, body: string): string => {
  const yaml = stringifyYaml(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body}`;
};
