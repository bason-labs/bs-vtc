/**
 * A small, non-validating XML reader for test reports (JUnit). Reports are untrusted tool output:
 * no DTDs or external entities are ever resolved (only the five predefined entities and numeric
 * character references), and the nesting depth is bounded. Pure.
 */

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  /** Concatenated text and CDATA directly inside this element. */
  text: string;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

const MAX_DEPTH = 256;

const ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** Decodes predefined entities and character references; unknown entities stay as written. */
export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#")) {
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body] ?? whole;
  });

const NAME = /[A-Za-z_:][\w:.-]*/y;
const ATTR = /\s*([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;

/** Parses a document and returns its root element. Throws {@link XmlError} on malformed input. */
export const parseXml = (source: string): XmlElement => {
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  const top = (): XmlElement | undefined => stack[stack.length - 1];

  const skipTo = (marker: string, what: string): void => {
    const end = source.indexOf(marker, i);
    if (end < 0) throw new XmlError(`unterminated ${what}`);
    i = end + marker.length;
  };

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    const textEnd = lt < 0 ? source.length : lt;
    if (textEnd > i) {
      const parent = top();
      if (parent !== undefined) parent.text += decodeEntities(source.slice(i, textEnd));
      i = textEnd;
      continue;
    }
    if (source.startsWith("<?", i)) {
      skipTo("?>", "processing instruction");
    } else if (source.startsWith("<!--", i)) {
      skipTo("-->", "comment");
    } else if (source.startsWith("<![CDATA[", i)) {
      const start = i + 9;
      skipTo("]]>", "CDATA section");
      const parent = top();
      if (parent !== undefined) parent.text += source.slice(start, i - 3);
    } else if (source.startsWith("<!", i)) {
      // DOCTYPE and other declarations: skipped, never resolved.
      skipTo(">", "declaration");
    } else if (source.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const match = NAME.exec(source);
      if (match === null) throw new XmlError(`bad closing tag at ${String(i)}`);
      const open = stack.pop();
      if (open?.name !== match[0]) {
        throw new XmlError(`closing </${match[0]}> does not match <${open?.name ?? "(none)"}>`);
      }
      i = NAME.lastIndex;
      skipTo(">", "closing tag");
    } else {
      NAME.lastIndex = i + 1;
      const match = NAME.exec(source);
      if (match === null) throw new XmlError(`bad tag at ${String(i)}`);
      i = NAME.lastIndex;
      const attrs: Record<string, string> = {};
      for (;;) {
        ATTR.lastIndex = i;
        const attr = ATTR.exec(source);
        if (attr === null) break;
        attrs[attr[1] ?? ""] = decodeEntities(attr[3] ?? attr[4] ?? "");
        i = ATTR.lastIndex;
      }
      while (/\s/.test(source.charAt(i))) i += 1;
      const selfClosing = source.startsWith("/>", i);
      if (!selfClosing && source.charAt(i) !== ">") {
        throw new XmlError(`malformed tag <${match[0]}> at ${String(i)}`);
      }
      i += selfClosing ? 2 : 1;
      const element: XmlElement = { name: match[0], attrs, children: [], text: "" };
      const parent = top();
      if (parent === undefined) {
        if (root !== undefined) throw new XmlError("more than one root element");
        root = element;
      } else {
        parent.children.push(element);
      }
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new XmlError("elements nested too deeply");
        stack.push(element);
      }
    }
  }
  if (stack.length > 0) throw new XmlError(`unclosed <${top()?.name ?? ""}>`);
  if (root === undefined) throw new XmlError("no root element");
  return root;
};

/** Every descendant element named `name`, in document order (the element itself included). */
export const findAll = (element: XmlElement, name: string): XmlElement[] => {
  const out: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    if (node.name === name) out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(element);
  return out;
};
