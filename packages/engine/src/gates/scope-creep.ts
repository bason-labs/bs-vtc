/**
 * The scope-creep flag (§7.4: "a changed file that no REQ covers is a scope-creep flag"), built
 * by code from the REQ tags in JUnit output, the tests' source files and the diff.
 *
 * A changed file is covered when a test tagged with one of the run's requirements (any tagged
 * test when the request names none) is in it, or reaches it through static imports from such a
 * test file (JS/TS and Python, relative imports, a bounded walk). That is the deterministic
 * stand-in for per-test coverage contexts, which most runners do not report. Files of other
 * languages, and files that are not code, cannot be judged this way and are never flagged.
 *
 * A test's file is the runner's `file` attribute, else the path of a pytest node id
 * (`path/test_x.py::test_y`), else a pytest dotted classname (`tests.test_models` or
 * `tests.test_models.TestX`, pytest's default xunit2 output) mapped to the longest module path
 * that exists (`tests/test_models.py`). When a tagged test's file cannot be found at all, coverage
 * is incomplete, so uncovered files are listed as unjudged instead of flagged.
 *
 * Each flagged path becomes one `ToolFinding` with `SCOPE_CREEP_RULE_ID`, category
 * `spec_mismatch` and SARIF level `none`: triage makes it `info` and routes it `defer`, so it is
 * listed in the evidence bundle and shown at Final Review step 3, and never blocks by itself.
 */
import { posix } from "node:path";
import {
  parseReqTags,
  SCOPE_CREEP_RULE_ID,
  type GitChangedFile,
  type RequirementRef,
  type ToolFinding,
} from "@vtc/shared";
import { importsOf } from "./arch/evaluate.js";
import { tagCovers } from "./traceability.js";

export const SCOPE_CREEP_TOOL = "vtc-traceability";

/** Code the import walk can follow. */
const JUDGED = /\.((m|c)?(j|t)sx?|vue|svelte|py)$/i;
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
/** How many import hops from a tagged test file still count as reaching a file. */
const MAX_DEPTH = 6;
const MAX_FILES = 2000;

export interface ScopeCreepInput {
  readonly changed: readonly GitChangedFile[];
  /** Every L2 case of the run, with its source file when the runner reported one. */
  readonly cases: readonly { readonly id: string; readonly file?: string | undefined }[];
  /** The requirements the run traces (`GateRunRequest.req_tags`); empty = any tag. */
  readonly reqTags: readonly RequirementRef[];
  /** The absolute checkout, to make reported test file paths repo-relative. */
  readonly checkoutAbs: string;
  /** A file's content at the head commit (`undefined` when absent or too large). */
  readonly readHead: (path: string) => Promise<string | undefined>;
  /** Whether a repo path exists at the head (import resolution). */
  readonly exists: (path: string) => boolean;
}

export interface ScopeCreep {
  /** Changed code files no requirement covers, sorted. */
  readonly paths: readonly string[];
  /** Changed files that could not be judged (other languages, non-code). */
  readonly unjudged: readonly string[];
}

const repoRelative = (file: string, checkoutAbs: string): string => {
  const normalized = file.replace(/\\/g, "/");
  const root = checkoutAbs.replace(/\\/g, "/").replace(/\/$/, "");
  const rel = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  return posix.normalize(rel).replace(/^\.\//, "");
};

const DOTTED = /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/;

/**
 * The repo path of a case's test file: its `file`, the path of a pytest node id, or the longest
 * existing module path of a pytest dotted classname; `null` when none is found.
 */
export const caseFile = (
  c: { readonly id: string; readonly file?: string | undefined },
  checkoutAbs: string,
  exists: (path: string) => boolean,
): string | null => {
  if (c.file !== undefined) return repoRelative(c.file, checkoutAbs);
  const node = /^([^\s:]+\.py)::/.exec(c.id)?.[1];
  if (node !== undefined) return repoRelative(node, checkoutAbs);
  const cut = c.id.indexOf(" > ");
  const classname = cut < 0 ? null : c.id.slice(0, cut).trim();
  if (classname === null || !DOTTED.test(classname)) return null;
  const parts = classname.split(".");
  for (let n = parts.length; n >= 1; n -= 1) {
    const path = `${parts.slice(0, n).join("/")}.py`;
    if (exists(path)) return path;
  }
  return null;
};

/** The repo paths an import may name; empty for a package import. */
const resolveImport = (
  importer: string,
  spec: string,
  exists: (p: string) => boolean,
): string[] => {
  let bases: string[];
  if (/\.py$/i.test(importer)) {
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
    const rest = spec
      .slice(dots)
      .split(".")
      .filter((s) => s !== "");
    let dir = "";
    if (dots > 0) {
      dir = posix.dirname(importer);
      for (let k = 1; k < dots; k += 1) dir = posix.dirname(dir);
    }
    const base = posix.normalize(posix.join(dir === "." ? "" : dir, ...rest));
    bases = [`${base}.py`, `${base}/__init__.py`];
  } else {
    if (!spec.startsWith(".")) return [];
    const base = posix.normalize(posix.join(posix.dirname(importer), spec));
    bases = [
      base,
      ...JS_EXTENSIONS.map((e) => `${base}${e}`),
      ...JS_EXTENSIONS.map((e) => `${base}/index${e}`),
    ];
  }
  return bases.filter((b) => !b.startsWith("..") && exists(b));
};

export const computeScopeCreep = async (input: ScopeCreepInput): Promise<ScopeCreep> => {
  const changed = input.changed.filter(
    (f) => f.status !== "deleted" && !f.path.startsWith(".vtc/"),
  );
  const judged = changed.filter((f) => JUDGED.test(f.path)).map((f) => f.path);
  const unjudged = changed
    .filter((f) => !JUDGED.test(f.path))
    .map((f) => f.path)
    .sort();
  if (judged.length === 0) return { paths: [], unjudged };

  const wanted = (id: string): boolean => {
    const tags = parseReqTags(id);
    if (tags.length === 0) return false;
    return (
      input.reqTags.length === 0 || tags.some((t) => input.reqTags.some((r) => tagCovers(t, r)))
    );
  };
  const roots = new Set<string>();
  let unresolved = false;
  for (const c of input.cases) {
    if (!wanted(c.id)) continue;
    const file = caseFile(c, input.checkoutAbs, input.exists);
    if (file === null) unresolved = true;
    else roots.add(file);
  }

  const contents = new Map<string, string | undefined>();
  const read = async (path: string): Promise<string | undefined> => {
    if (!contents.has(path)) contents.set(path, await input.readHead(path));
    return contents.get(path);
  };
  const known = new Set<string>();
  const covered = new Set<string>();
  let frontier = [...roots];
  for (
    let depth = 0;
    depth <= MAX_DEPTH && frontier.length > 0 && covered.size < MAX_FILES;
    depth += 1
  ) {
    const next: string[] = [];
    for (const path of frontier) {
      if (covered.has(path)) continue;
      const content = await read(path);
      if (content === undefined) continue;
      covered.add(path);
      for (const imp of importsOf(path, content)) {
        for (const candidate of resolveImport(path, imp.spec, input.exists)) {
          if (known.has(candidate) || covered.has(candidate)) continue;
          known.add(candidate);
          next.push(candidate);
        }
      }
    }
    frontier = next;
  }
  const uncovered = judged.filter((p) => !covered.has(p)).sort();
  // A tagged test whose file is unknown may cover any of them: none is flagged.
  if (unresolved) return { paths: [], unjudged: [...unjudged, ...uncovered].sort() };
  return { paths: uncovered, unjudged };
};

/** One info-level, deferred finding per scope-creep path (`SCOPE_CREEP_RULE_ID`). */
export const scopeCreepFindings = (paths: readonly string[], traceability: string): ToolFinding[] =>
  paths.map((path) => ({
    tool: SCOPE_CREEP_TOOL,
    rule_id: SCOPE_CREEP_RULE_ID,
    category: "spec_mismatch",
    title: `Changed file no requirement covers: ${path}`.slice(0, 200),
    message:
      "No test tagged with this run's requirements is in this file or reaches it through imports (§7.4 scope creep). Listed for Final Review; it does not block.",
    location: { path },
    evidence: { type: "command_output", ref: traceability },
    sarif_level: "none",
  }));
