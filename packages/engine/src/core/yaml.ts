/**
 * A small, strict YAML reader for VTC's own config files (`.vtc/project.yaml`, `.vtc/gates.yml`):
 * block mappings and sequences, flow sequences and mappings of scalars, quoted and plain scalars,
 * comments. Anything else (anchors, tags, multi-document streams, block scalars) is an error,
 * never a guess. JSON, a subset of YAML, is accepted as is. A `__proto__` key is an error (it
 * would set the object's prototype). A YAML library would replace this once the engine package
 * declares one: the dependency is proposed to the integrator (AD-15 rule 2).
 */

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${String(line)}: ${message}`);
    this.name = "YamlError";
  }
}

/** A mapping key, refusing `__proto__` (assigning it would replace the prototype). */
const mapKey = (raw: string, line: number): string => {
  const key = String(parseScalar(raw, line));
  if (key === "__proto__") throw new YamlError("the key __proto__ is not allowed", line);
  return key;
};

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

const stripComment = (raw: string): string => {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charAt(i);
    if (quote !== null) {
      if (c === "\\" && quote === '"') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(raw.charAt(i - 1)))) return raw.slice(0, i);
  }
  return raw;
};

const splitFlow = (body: string, line: number): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charAt(i);
    if (quote !== null) {
      current += c;
      if (c === "\\" && quote === '"') {
        current += body.charAt(i + 1);
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === "[" || c === "{") depth += 1;
    if (c === "]" || c === "}") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (quote !== null || depth !== 0) throw new YamlError("unbalanced flow collection", line);
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
};

const findColon = (text: string): number => {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quote !== null) {
      if (c === "\\" && quote === '"') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ":" && (i + 1 === text.length || text.charAt(i + 1) === " ")) return i;
  }
  return -1;
};

export const parseScalar = (raw: string, line: number): unknown => {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null") return null;
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new YamlError("unterminated flow sequence", line);
    return splitFlow(text.slice(1, -1), line).map((p) => parseScalar(p, line));
  }
  if (text.startsWith("{")) {
    if (!text.endsWith("}")) throw new YamlError("unterminated flow mapping", line);
    const out: Record<string, unknown> = {};
    for (const part of splitFlow(text.slice(1, -1), line)) {
      const colon = findColon(part);
      if (colon < 0) throw new YamlError(`expected key: value in ${part}`, line);
      out[mapKey(part.slice(0, colon), line)] = parseScalar(part.slice(colon + 1), line);
    }
    return out;
  }
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new YamlError("unterminated string", line);
    return JSON.parse(text) as unknown;
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new YamlError("unterminated string", line);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!|>%@`]/.test(text)) throw new YamlError(`unsupported YAML syntax: ${text}`, line);
  if (text === "true" || text === "True") return true;
  if (text === "false" || text === "False") return false;
  if (/^[-+]?\d+$/.test(text)) return Number(text);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
};

const parseBlock = (lines: readonly Line[], start: number, indent: number): [unknown, number] => {
  const first = lines[start];
  if (first === undefined) return [null, start];
  if (first.text.startsWith("- ") || first.text === "-") {
    const items: unknown[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined || line.indent < indent) break;
      if (line.indent > indent) throw new YamlError("unexpected indentation", line.number);
      if (!(line.text.startsWith("- ") || line.text === "-")) break;
      const rest = line.text === "-" ? "" : line.text.slice(2);
      if (rest.trim() === "") {
        const next = lines[i + 1];
        if (next === undefined || next.indent <= indent) {
          items.push(null);
          i += 1;
        } else {
          const [value, after] = parseBlock(lines, i + 1, next.indent);
          items.push(value);
          i = after;
        }
      } else if (
        findColon(rest) >= 0 &&
        !rest.trim().startsWith("[") &&
        !rest.trim().startsWith("{")
      ) {
        // A mapping that starts on the dash line: re-read it with the dash as indentation.
        const inner: Line[] = [{ indent: indent + 2, text: rest, number: line.number }];
        let j = i + 1;
        while (j < lines.length && (lines[j]?.indent ?? 0) > indent) {
          const l = lines[j];
          if (l !== undefined) inner.push(l);
          j += 1;
        }
        const [value] = parseBlock(inner, 0, indent + 2);
        items.push(value);
        i = j;
      } else {
        items.push(parseScalar(rest, line.number));
        i += 1;
      }
    }
    return [items, i];
  }
  const map: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) throw new YamlError("unexpected indentation", line.number);
    const colon = findColon(line.text);
    if (colon < 0) throw new YamlError(`expected key: value, got ${line.text}`, line.number);
    const key = mapKey(line.text.slice(0, colon), line.number);
    if (Object.hasOwn(map, key)) throw new YamlError(`duplicate key ${key}`, line.number);
    const rest = line.text.slice(colon + 1).trim();
    if (rest === "") {
      const next = lines[i + 1];
      if (
        next !== undefined &&
        (next.indent > indent || (next.indent === indent && next.text.startsWith("- ")))
      ) {
        const [value, after] = parseBlock(lines, i + 1, next.indent);
        map[key] = value;
        i = after;
      } else {
        map[key] = null;
        i += 1;
      }
    } else {
      map[key] = parseScalar(rest, line.number);
      i += 1;
    }
  }
  return [map, i];
};

/** Parses a YAML (or JSON) document into plain data. Throws {@link YamlError}. */
export const parseYaml = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // fall through: YAML flow syntax
    }
  }
  const lines: Line[] = [];
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((raw, index) => {
      if (raw.includes("\t") && /^\s*\t/.test(raw))
        throw new YamlError("tabs are not allowed for indentation", index + 1);
      const content = stripComment(raw);
      if (content.trim() === "") return;
      if (content.trim() === "---" || content.trim() === "...") {
        if (lines.length > 0)
          throw new YamlError("multiple documents are not supported", index + 1);
        return;
      }
      const indent = content.length - content.trimStart().length;
      lines.push({ indent, text: content.trim(), number: index + 1 });
    });
  if (lines.length === 0) return null;
  const [value, end] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  const leftover = lines[end];
  if (leftover !== undefined) throw new YamlError("unexpected content", leftover.number);
  return value;
};

const plain = /^[A-Za-z_][A-Za-z0-9_./-]*$/;

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    return plain.test(value) && !["true", "false", "null", "True", "False"].includes(value)
      ? value
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
};

/** Serialises plain data as block YAML (strings JSON-quoted when needed). */
export const toYaml = (value: unknown, indent = 0): string => {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const body = toYaml(item, indent + 2).trimStart();
          return `${pad}- ${body}`;
        }
        return `${pad}- ${scalar(item)}\n`;
      })
      .join("");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return `${pad}{}\n`;
    return entries
      .map(([key, v]) => {
        const k = plain.test(key) ? key : JSON.stringify(key);
        if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []\n`;
        if (
          v !== null &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          Object.keys(v).length === 0
        ) {
          return `${pad}${k}: {}\n`;
        }
        if (v !== null && typeof v === "object") return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
        return `${pad}${k}: ${scalar(v)}\n`;
      })
      .join("");
  }
  return `${pad}${scalar(value)}\n`;
};
