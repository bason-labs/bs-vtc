/**
 * What a report parser returns: tool findings without their evidence pointer (the Gate Runner
 * adds it once the redacted report has its evidence path) and the secret values a secret scanner
 * matched (redacted everywhere before evidence is written, §7.2).
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FindingCategory, ToolFinding } from "@vtc/shared";

export type ParsedFinding = Omit<ToolFinding, "evidence"> & {
  /** Pointer inside the report: the SARIF result index or the JSON entry index. */
  readonly index: number;
};

export interface ParsedFindings {
  readonly findings: ParsedFinding[];
  /** Matched secret values (raw). Used only as redaction input, never written. */
  readonly secrets: string[];
}

export interface ParseContext {
  /** Absolute path of the checkout the tool ran in: absolute report paths are made relative to it. */
  readonly checkoutAbs: string;
  /** Category for findings the tool does not classify (L1 lint vs L4 security scanner). */
  readonly defaultCategory: FindingCategory;
  /** Location used when a result names no file (e.g. the report itself). */
  readonly fallbackPath: string;
}

/** Tool name → the category its findings always have. */
export const categoryForTool = (tool: string, fallback: FindingCategory): FindingCategory => {
  const t = tool.toLowerCase();
  if (/gitleaks|betterleaks|trufflehog|detect-secrets/.test(t)) return "secret";
  if (/osv|audit|dependency|licen[cs]e/.test(t)) return "supply_chain";
  return fallback;
};

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export const clipTitle = (text: string): string => {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return clip(line.trim() === "" ? "finding" : line.trim(), 200);
};

export const clipMessage = (text: string): string => clip(text, 4000);

export const clipRule = (text: string): string => clip(text.trim() === "" ? "unknown" : text, 200);

/**
 * A repo-relative POSIX path for a tool-reported location: `file://` URIs and absolute paths
 * inside the checkout are made relative; anything outside the checkout, or unsafe, falls back.
 */
export const relativeLocation = (raw: string | undefined, ctx: ParseContext): string => {
  if (raw === undefined || raw.trim() === "") return ctx.fallbackPath;
  let path = raw.trim();
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return ctx.fallbackPath;
    }
  }
  path = path.replace(/\\/g, "/");
  const root = ctx.checkoutAbs.replace(/\\/g, "/").replace(/\/+$/, "");
  if (path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
  else if (/^(\/|[A-Za-z]:\/)/.test(path)) return ctx.fallbackPath;
  while (path.startsWith("./")) path = path.slice(2);
  if (path === "" || path.split("/").includes("..")) return ctx.fallbackPath;
  // What `RelPathSchema` accepts: a report must never make the whole GateReport invalid.
  if (path.length > 1024 || path.includes("\0")) return ctx.fallbackPath;
  return path;
};

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const sourceCache = new WeakMap<ParseContext, Map<string, readonly string[] | null>>();

const linesOf = (ctx: ParseContext, path: string): readonly string[] | null => {
  let cache = sourceCache.get(ctx);
  if (cache === undefined) {
    cache = new Map();
    sourceCache.set(ctx, cache);
  }
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  let lines: readonly string[] | null = null;
  try {
    const root = realpathSync(ctx.checkoutAbs);
    const abs = realpathSync(join(ctx.checkoutAbs, path));
    const rel = relative(root, abs);
    const stat = statSync(abs);
    if (!rel.startsWith("..") && !rel.startsWith(sep) && stat.isFile()) {
      if (stat.size <= MAX_SOURCE_BYTES) lines = readFileSync(abs, "utf8").split(/\r?\n/);
    }
  } catch {
    lines = null;
  }
  cache.set(path, lines);
  return lines;
};

/**
 * The trimmed source line a finding points at, read from the checkout the tool ran in: a
 * line-independent anchor for findings that carry no snippet or symbol (ESLint, Ruff), so a
 * baseline violation keeps its fingerprint when the diff shifts lines above it (§7.1). Never for
 * paths outside the checkout (symlinks resolved) or files over 2 MB.
 */
export const sourceLine = (
  ctx: ParseContext,
  path: string,
  line: number | undefined,
): string | undefined => {
  if (line === undefined || path === ctx.fallbackPath) return undefined;
  const text = linesOf(ctx, path)?.[line - 1]?.trim();
  return text === undefined || text === "" ? undefined : clip(text, 500);
};

/** A `CWE-n` id from a tag such as `CWE-79: XSS` or `external/cwe/cwe-079`. */
export const cweFrom = (tags: readonly unknown[]): `CWE-${string}` | undefined => {
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const match = /cwe[-/](\d+)/i.exec(tag);
    if (match?.[1] !== undefined) {
      const n = Number(match[1]);
      if (n > 0) return `CWE-${String(n)}`;
    }
  }
  return undefined;
};
