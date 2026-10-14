/**
 * Evaluates compiled AD Checks (`checks.ts`) on a diff's changed files (§8.5, §7.2 L6). Pure:
 * the caller reads each changed file at the head and the base commit. Only new violations count
 * (§7.1): a violation the same file already had at the base is baseline.
 */
import { posix } from "node:path";
import { matchesAny } from "../globs.js";
import type { AdCheckSpec } from "./checks.js";

export interface ArchFile {
  readonly path: string;
  readonly head: string;
  /** The file at the base (its old path for a rename); absent when it is new. */
  readonly base?: string | undefined;
}

export interface ArchViolation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly detail: string;
  /** Identity for the baseline comparison (no line number: lines move). */
  readonly key: string;
}

const JS = /\.(m|c)?(j|t)sx?$|\.(vue|svelte|astro)$/i;
const PY = /\.py$/i;
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];

/** Import specifiers per line: JS/TS `import`/`export … from`/`require()`/`import()`, Python `import`/`from`. */
export const importsOf = (
  path: string,
  content: string,
): { line: number; spec: string; text: string }[] => {
  const out: { line: number; spec: string; text: string }[] = [];
  content.split("\n").forEach((text, i) => {
    const add = (spec: string | undefined): void => {
      if (spec !== undefined && spec !== "") out.push({ line: i + 1, spec, text: text.trim() });
    };
    if (JS.test(path)) {
      for (const m of text.matchAll(/\bfrom\s+["']([^"']+)["']/g)) add(m[1]);
      for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']/g)) add(m[1]);
      for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g))
        add(m[1]);
    } else if (PY.test(path)) {
      const from = /^\s*from\s+(\.*[\w.]*)\s+import\b/.exec(text);
      if (from !== null) add(from[1]);
      const imp = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(text);
      if (imp?.[1] !== undefined) for (const name of imp[1].split(",")) add(name.trim());
    }
  });
  return out;
};

/** The repo paths a relative import may name (with and without extensions and index files). */
const candidates = (importer: string, spec: string): string[] => {
  if (PY.test(importer)) {
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
    return [base, `${base}.py`, `${base}/__init__.py`];
  }
  if (!spec.startsWith(".") && !spec.startsWith("/")) return [];
  const base = posix.normalize(posix.join(posix.dirname(importer), spec)).replace(/^\/+/, "");
  if (base.startsWith("..")) return [];
  return [
    base,
    ...JS_EXTENSIONS.map((e) => `${base}${e}`),
    ...JS_EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
};

const packageMatches = (spec: string, pkg: string, python: boolean): boolean => {
  const name = python ? spec.replace(/^\.+/, "") : spec;
  const sep = python ? "." : "/";
  return name === pkg || name.startsWith(`${pkg}${sep}`);
};

/** Dependencies a manifest declares, with the line each one is on. */
export const dependenciesOf = (path: string, content: string): { name: string; line: number }[] => {
  const file = posix.basename(path);
  const lines = content.split("\n");
  const lineOf = (needle: string): number => {
    const i = lines.findIndex((l) => l.includes(needle));
    return i < 0 ? 1 : i + 1;
  };
  const normalizePy = (n: string): string => n.toLowerCase().replace(/[-_.]+/g, "-");
  if (file === "package.json") {
    try {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const names = new Set<string>();
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const deps = pkg[field];
        if (typeof deps === "object" && deps !== null)
          for (const n of Object.keys(deps)) names.add(n);
      }
      return [...names].map((name) => ({ name, line: lineOf(`"${name}"`) }));
    } catch {
      return [];
    }
  }
  if (/^requirements.*\.(txt|in)$/i.test(file)) {
    return lines.flatMap((l, i) => {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l.replace(/#.*/, ""));
      return m?.[1] === undefined || l.trim().startsWith("-")
        ? []
        : [{ name: normalizePy(m[1]), line: i + 1 }];
    });
  }
  if (file === "pyproject.toml") {
    const out: { name: string; line: number }[] = [];
    let inArray = false;
    let inTable = false;
    lines.forEach((l, i) => {
      if (/^\s*\[/.test(l)) {
        inTable =
          /^\s*\[tool\.poetry\.(dev-)?dependencies\]/.test(l) ||
          /^\s*\[tool\.poetry\.group\.[^\]]+\.dependencies\]/.test(l);
        inArray = false;
        return;
      }
      if (/^\s*(dependencies|[\w-]+)\s*=\s*\[/.test(l) && /dependencies|optional|dev|test/.test(l))
        inArray = true;
      if (inArray) {
        for (const m of l.matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
          if (m[1] !== undefined) out.push({ name: normalizePy(m[1]), line: i + 1 });
        }
        if (l.includes("]")) inArray = false;
        return;
      }
      if (inTable) {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(l);
        if (m?.[1] !== undefined && m[1] !== "python")
          out.push({ name: normalizePy(m[1]), line: i + 1 });
      }
    });
    return out;
  }
  if (file === "go.mod") {
    const out: { name: string; line: number }[] = [];
    let block = false;
    lines.forEach((l, i) => {
      if (/^\s*require\s*\(/.test(l)) block = true;
      else if (block && /^\s*\)/.test(l)) block = false;
      else {
        const m = block ? /^\s*(\S+)\s+v/.exec(l) : /^\s*require\s+(\S+)\s+v/.exec(l);
        if (m?.[1] !== undefined) out.push({ name: m[1], line: i + 1 });
      }
    });
    return out;
  }
  return [];
};

const norm = (text: string): string => text.trim().replace(/\s+/g, " ");

/** Every violation of one Check in one file's content. */
export const violationsOf = (spec: AdCheckSpec, path: string, content: string): ArchViolation[] => {
  if (spec.kind === "import-boundary") {
    if (!matchesAny(spec.from, path) || matchesAny(spec.except, path)) return [];
    const python = PY.test(path);
    const out: ArchViolation[] = [];
    for (const imp of importsOf(path, content)) {
      const target = candidates(path, imp.spec).find((c) => matchesAny(spec.forbid, c));
      const pkg = spec.forbid_packages.find((p) => packageMatches(imp.spec, p, python));
      if (target === undefined && pkg === undefined) continue;
      const what = target ?? pkg ?? imp.spec;
      out.push({
        path,
        line: imp.line,
        text: imp.text,
        detail: `imports ${imp.spec}${target !== undefined && target !== imp.spec ? ` (${what})` : ""}`,
        key: `import\u0000${imp.spec}\u0000${norm(imp.text)}`,
      });
    }
    return out;
  }
  if (spec.kind === "forbidden-dependency") {
    const wanted = new Set(spec.packages.map((p) => p.toLowerCase()));
    return dependenciesOf(path, content)
      .filter((d) => wanted.has(d.name.toLowerCase()))
      .map((d) => ({
        path,
        line: d.line,
        text: (content.split("\n")[d.line - 1] ?? d.name).trim(),
        detail: `depends on ${d.name}`,
        key: `dependency\u0000${d.name.toLowerCase()}`,
      }));
  }
  if (!matchesAny(spec.paths, path) || matchesAny(spec.except, path)) return [];
  const re = new RegExp(spec.pattern);
  return content.split("\n").flatMap((text, i) =>
    re.test(text)
      ? [
          {
            path,
            line: i + 1,
            text: text.trim(),
            detail: `matches /${spec.pattern}/`,
            key: `pattern\u0000${norm(text)}`,
          },
        ]
      : [],
  );
};

/** New and baseline violations of one Check over the changed files. */
export const evaluateAdCheck = (
  spec: AdCheckSpec,
  files: readonly ArchFile[],
): { readonly fresh: ArchViolation[]; readonly baseline: number } => {
  const fresh: ArchViolation[] = [];
  let baseline = 0;
  for (const file of files) {
    const before = new Map<string, number>();
    for (const v of file.base === undefined ? [] : violationsOf(spec, file.path, file.base)) {
      before.set(v.key, (before.get(v.key) ?? 0) + 1);
    }
    for (const v of violationsOf(spec, file.path, file.head)) {
      const left = before.get(v.key) ?? 0;
      if (left > 0) {
        before.set(v.key, left - 1);
        baseline += 1;
      } else fresh.push(v);
    }
  }
  return { fresh, baseline };
};
