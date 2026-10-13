/**
 * Files that hold both dependencies and lint/test configuration: `pyproject.toml` (`[tool.ruff]`,
 * `[tool.pytest.ini_options]`, `[tool.mypy]`, `[tool.coverage]`, …) and `package.json` (`scripts`,
 * `jest`, `eslintConfig`, `mocha`, …). Protecting them whole would flag every dependency change,
 * so only their tool sections are guarded (§7.2 L1/L5, §7.6 rule 5): L5 flags a diff that changes
 * a tool section, and L1 runs with the head file whose tool sections are put back to the base
 * version. Pure functions over file text.
 */
import { posix } from "node:path";

/** `[tool.<name>]` tables of pyproject.toml that configure a lint, type-check or test tool. */
const PYPROJECT_TOOLS = [
  "ruff",
  "pytest",
  "mypy",
  "coverage",
  "pyright",
  "basedpyright",
  "pylint",
  "flake8",
  "bandit",
];

/**
 * Top-level package.json keys that configure a gate. `scripts` is guarded whole: a gate command is
 * often `pnpm run test`, and a guarded script can call any other one.
 */
const PACKAGE_JSON_KEYS = ["scripts", "jest", "eslintConfig", "mocha", "ava", "c8", "nyc"];

type Kind = "pyproject" | "package_json";

const kindOf = (path: string): Kind | null => {
  const name = posix.basename(path);
  return name === "pyproject.toml" ? "pyproject" : name === "package.json" ? "package_json" : null;
};

/** Whether a path is a file whose tool sections are guarded. */
export const isMixedConfig = (path: string): boolean => kindOf(path) !== null;

// ------------------------------------------------------------------- pyproject

interface Segment {
  /** The normalized table name, `null` for the root table before the first header. */
  readonly name: string | null;
  readonly lines: string[];
}

const HEADER = /^\s*\[\[?([^[\]]+)\]\]?\s*(#.*)?$/;
const KEY_CHARS = /^[A-Za-z0-9_\-.]+$/;

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
 * Splits TOML text at table headers: lines that look like one outside any multi-line array,
 * inline table or string. Header names are normalized (quotes and whitespace removed), so
 * `[ tool . "ruff" ]` is `tool.ruff`.
 */
const segments = (text: string): Segment[] => {
  const out: Segment[] = [{ name: null, lines: [] }];
  const state: ScanState = { depth: 0, open: null };
  for (const line of text.split(/\r?\n/)) {
    const atTop = state.depth === 0 && state.open === null;
    const name = atTop ? HEADER.exec(line)?.[1]?.replace(/["'\s]/g, "") : undefined;
    if (name !== undefined && KEY_CHARS.test(name)) {
      out.push({ name, lines: [line] });
      continue;
    }
    out.at(-1)?.lines.push(line);
    scanLine(line, state);
  }
  return out;
};

/**
 * Guarded segments: the root table and `[tool]` (dotted keys such as `tool.ruff.lint.ignore` can
 * live there) and every `[tool.<tool>…]` table of {@link PYPROJECT_TOOLS}.
 */
const guardedSegment = (s: Segment): boolean =>
  s.name === null ||
  s.name === "tool" ||
  PYPROJECT_TOOLS.some((t) => s.name === `tool.${t}` || s.name?.startsWith(`tool.${t}.`) === true);

const canonicalLines = (lines: readonly string[]): string[] =>
  lines.map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));

const pyprojectSections = (text: string): string =>
  segments(text)
    .filter(guardedSegment)
    .map((s) => canonicalLines(s.lines).join("\n"))
    .filter((s) => s !== "")
    .join("\n");

const pyprojectWithBase = (head: string, base: string | undefined): string => {
  const baseSegs = base === undefined ? [] : segments(base);
  const root = baseSegs.find((s) => s.name === null)?.lines ?? [];
  const rest = segments(head)
    .filter((s) => !guardedSegment(s))
    .flatMap((s) => s.lines);
  const tools = baseSegs
    .filter((s) => s.name !== null && guardedSegment(s))
    .flatMap((s) => s.lines);
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
