/**
 * Files that hold both dependencies and lint/test configuration: `pyproject.toml` (`[tool.ruff]`,
 * `[tool.pytest.ini_options]`, `[tool.mypy]`, `[tool.coverage]`, …) and `package.json` (`scripts`,
 * `jest`, `eslintConfig`, `mocha`, …). Protecting them whole would flag every dependency change,
 * so only their tool sections are guarded (§7.2 L1/L5, §7.6 rule 5): L5 flags a diff that changes
 * a tool section, and L1 runs with the head file whose tool sections are put back to the base
 * version. Pure functions over file text.
 */
import { posix } from "node:path";

/**
 * pyproject.toml tables that configure a lint, type-check or test tool, or define a command a
 * calibrated gate can run (`tox`, `hatch run`, `pdm run`, `poe`; D-y, spine §5 reading 45), as key
 * paths. A table is guarded when its key path starts with one of these, or is an ancestor of one
 * (the root table, `[tool]`, `[tool.hatch]` and `[tool.pdm]`), because dotted keys in an ancestor
 * can set the same values (`[tool.hatch]` `envs.default.scripts.test = "true"`).
 */
const PYPROJECT_GUARDED: readonly (readonly string[])[] = [
  ["tool", "ruff"],
  ["tool", "pytest"],
  ["tool", "mypy"],
  ["tool", "coverage"],
  ["tool", "pyright"],
  ["tool", "basedpyright"],
  ["tool", "pylint"],
  ["tool", "flake8"],
  ["tool", "bandit"],
  ["tool", "tox"],
  ["tool", "hatch", "envs"],
  ["tool", "pdm", "scripts"],
  ["tool", "poe"],
];

/**
 * Top-level package.json keys that configure a gate. `scripts` is guarded whole: a gate command is
 * often `pnpm run test`, and a guarded script can call any other one.
 */
const PACKAGE_JSON_KEYS = ["scripts", "jest", "eslintConfig", "mocha", "ava", "c8", "nyc"];

type Kind = "pyproject" | "package_json";

const kindOf = (path: string): Kind | null => {
  // Any letter case: a case-insensitive file system finds PyProject.toml as pyproject.toml.
  const name = posix.basename(path).toLowerCase();
  return name === "pyproject.toml" ? "pyproject" : name === "package.json" ? "package_json" : null;
};

/** Whether a path is a file whose tool sections are guarded. */
export const isMixedConfig = (path: string): boolean => kindOf(path) !== null;

// ------------------------------------------------------------------- pyproject

interface Segment {
  /** The table's decoded key path, `null` for the root table before the first header. */
  readonly key: readonly string[] | null;
  readonly lines: string[];
}

interface Split {
  readonly segments: Segment[];
  /**
   * A top-level line starts like a table header but could not be decoded. Tools may still read
   * it as one, so the file fails closed: its whole text is guarded.
   */
  readonly undecodable: boolean;
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;
const HEX: Readonly<Record<string, RegExp>> = {
  u: /^[0-9A-Fa-f]{4}/,
  U: /^[0-9A-Fa-f]{8}/,
  x: /^[0-9A-Fa-f]{2}/,
};
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};

/** Decodes the body of a TOML basic string (`\uXXXX`, `\UXXXXXXXX`, `\xHH`, simple escapes). */
const decodeBasic = (body: string): string | null => {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charAt(i);
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body.charAt(i + 1);
    const simple = SIMPLE_ESCAPES[e];
    if (simple !== undefined) {
      out += simple;
      i += 1;
      continue;
    }
    const hex = HEX[e]?.exec(body.slice(i + 2))?.[0];
    if (hex === undefined) return null;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    out += String.fromCodePoint(code);
    i += 1 + hex.length;
  }
  return out;
};

/**
 * The decoded key path of a table header line (`[a."b".'c']` or `[[…]]`, optional comment), as
 * TOML reads it; `null` when the line is not a header TOML would accept.
 */
const headerKey = (line: string): string[] | null => {
  let i = 0;
  const ws = (): void => {
    while (line.charAt(i) === " " || line.charAt(i) === "\t") i += 1;
  };
  ws();
  if (line.charAt(i) !== "[") return null;
  const array = line.charAt(i + 1) === "[";
  i += array ? 2 : 1;
  const parts: string[] = [];
  for (;;) {
    ws();
    const c = line.charAt(i);
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length && line.charAt(j) !== c)
        j += c === '"' && line.charAt(j) === "\\" ? 2 : 1;
      if (j >= line.length) return null;
      const body = line.slice(i + 1, j);
      const part = c === '"' ? decodeBasic(body) : body;
      if (part === null) return null;
      parts.push(part);
      i = j + 1;
    } else {
      const match = BARE_KEY.exec(line.slice(i));
      if (match === null) return null;
      parts.push(match[0]);
      i += match[0].length;
    }
    ws();
    if (line.charAt(i) === ".") {
      i += 1;
      continue;
    }
    break;
  }
  const close = array ? "]]" : "]";
  if (!line.startsWith(close, i)) return null;
  i += close.length;
  ws();
  return i === line.length || line.charAt(i) === "#" ? parts : null;
};

interface ScanState {
  /** Open `[` and `{` of a value that spans lines. */
  depth: number;
  /** The delimiter of an open multi-line string. */
  open: '"""' | "'''" | null;
}

/** Advances the value state over one non-header line: brackets, strings and comments. */
const scanLine = (line: string, state: ScanState): void => {
  let i = 0;
  while (i < line.length) {
    if (state.open !== null) {
      if (state.open === '"""' && line[i] === "\\") i += 2;
      else if (line.startsWith(state.open, i)) {
        state.open = null;
        i += 3;
      } else i += 1;
      continue;
    }
    const c = line[i];
    if (c === "#") return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.open = line.startsWith('"""', i) ? '"""' : "'''";
      i += 3;
    } else if (c === '"' || c === "'") {
      i += 1;
      while (i < line.length && line[i] !== c) i += c === '"' && line[i] === "\\" ? 2 : 1;
      i += 1;
    } else {
      if (c === "[" || c === "{") state.depth += 1;
      else if (c === "]" || c === "}") state.depth = Math.max(0, state.depth - 1);
      i += 1;
    }
  }
};

/**
 * Splits TOML text at table headers: lines that start with `[` outside any multi-line array,
 * inline table or string. Header keys are decoded as TOML decodes them (quotes, escapes and
 * whitespace), so `[ tool . "\u0072uff" ]` is `tool.ruff`. Such a line that does not decode marks
 * the split `undecodable` (fail closed).
 */
const split = (text: string): Split => {
  const segments: Segment[] = [{ key: null, lines: [] }];
  const state: ScanState = { depth: 0, open: null };
  let undecodable = false;
  for (const line of text.split(/\r?\n/)) {
    const atTop = state.depth === 0 && state.open === null;
    if (atTop && line.trimStart().startsWith("[")) {
      const key = headerKey(line);
      if (key !== null) {
        segments.push({ key, lines: [line] });
        continue;
      }
      undecodable = true;
    }
    segments.at(-1)?.lines.push(line);
    if (!(atTop && line.trimStart().startsWith("["))) scanLine(line, state);
  }
  return { segments, undecodable };
};

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((part, i) => path[i] === part);

/**
 * Guarded segments: the root table, and every table on a {@link PYPROJECT_GUARDED} path (at or
 * below it, or an ancestor whose dotted keys can reach it).
 */
const guardedSegment = (s: Segment): boolean =>
  s.key === null ||
  PYPROJECT_GUARDED.some((g) => startsWith(s.key ?? [], g) || startsWith(g, s.key ?? []));

const canonicalLines = (lines: readonly string[]): string[] =>
  lines.map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));

const pyprojectSections = (text: string): string => {
  const { segments, undecodable } = split(text);
  // Fail closed: a header this splitter cannot decode makes the whole file guarded.
  if (undecodable) return `undecodable\u0000${text}`;
  return segments
    .filter(guardedSegment)
    .map((s) => canonicalLines(s.lines).join("\n"))
    .filter((s) => s !== "")
    .join("\n");
};

const pyprojectWithBase = (head: string, base: string | undefined): string => {
  const headSplit = split(head);
  const baseSplit = base === undefined ? null : split(base);
  // Fail closed: when either side does not decode, L1 runs with the base file as it was.
  if (headSplit.undecodable || baseSplit?.undecodable === true) return base ?? "";
  const baseSegs = baseSplit?.segments ?? [];
  const root = baseSegs.find((s) => s.key === null)?.lines ?? [];
  const rest = headSplit.segments.filter((s) => !guardedSegment(s)).flatMap((s) => s.lines);
  const tools = baseSegs.filter((s) => s.key !== null && guardedSegment(s)).flatMap((s) => s.lines);
  return `${[...root, ...rest, ...tools].join("\n").trimEnd()}\n`;
};

// ---------------------------------------------------------------- package.json

const parseObject = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const packageJsonSections = (text: string): string => {
  const pkg = parseObject(text);
  // Unparseable: the whole text counts, so any change is flagged.
  if (pkg === null) return text;
  return JSON.stringify(PACKAGE_JSON_KEYS.map((k) => [k, pkg[k] ?? null]));
};

const packageJsonWithBase = (head: string, base: string | undefined): string => {
  const pkg = parseObject(head);
  const basePkg = base === undefined ? {} : parseObject(base);
  // A head or base the tools could not parse either: run with the base file as it was.
  if (pkg === null || basePkg === null) return base ?? head;
  const merged: Record<string, unknown> = { ...pkg };
  for (const key of PACKAGE_JSON_KEYS) {
    if (key in basePkg) merged[key] = basePkg[key];
    else Reflect.deleteProperty(merged, key);
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
};

// ---------------------------------------------------------------------- public

/**
 * The guarded tool sections of a mixed config file in a canonical form (blank lines and comments
 * dropped); `""` for a missing file or one without tool sections. Two versions differ in their
 * tool configuration exactly when these differ.
 */
export const guardedSections = (path: string, text: string | undefined): string => {
  if (text === undefined) return "";
  const kind = kindOf(path);
  if (kind === "pyproject") return pyprojectSections(text);
  if (kind === "package_json") return packageJsonSections(text);
  return text;
};

/** The head file with its guarded tool sections taken from the base version (`undefined`: none). */
export const withBaseSections = (path: string, head: string, base: string | undefined): string => {
  const kind = kindOf(path);
  if (kind === "pyproject") return pyprojectWithBase(head, base);
  if (kind === "package_json") return packageJsonWithBase(head, base);
  return base ?? head;
};
