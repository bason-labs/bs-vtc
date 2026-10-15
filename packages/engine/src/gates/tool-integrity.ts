/**
 * Check tools that install scripts cannot replace (H-14; spine §5 readings 80(c) and 238;
 * `GateSchema.tool`, `CheckTool`, `GateResult.tool`). Pure helpers over the file system; the Gate
 * Runner (`runner.ts`) decides when they run:
 *
 * - {@link scriptsFreeInstall}: the form of an install-phase command that runs no lifecycle
 *   script (npm, pnpm, Bun and Yarn Classic `--ignore-scripts`, Yarn Berry `--mode=skip-build`;
 *   `go mod download` and `cargo fetch` run no project code as they are). The runner runs it
 *   first, hashes the tools, then runs the command as configured, which runs the scripts.
 * - {@link hashTool}: the hash of a `project` tool's files, one line per file (its checkout-relative
 *   path and the SHA-256 of its bytes, or `link:<target>` for a symbolic link, which is never
 *   followed), sorted by path. A glob's literal base directory is followed when it is a link
 *   (pnpm's `node_modules/<name>` points into `node_modules/.pnpm`), and the link itself is a line.
 * - {@link changedToolFiles}: the files the install phase changed, added or removed.
 * - {@link deriveProjectTool}: a `project` tool from a gate command whose `tool` is absent: the
 *   executable it resolves to inside the checkout (unwrapping `pnpm exec`, `npx`, `npm exec`,
 *   `yarn`, `bunx`, `uv run`, `poetry run`) and the package that executable belongs to. A command
 *   whose executable is outside the checkout has no project tool: install-phase code cannot write
 *   there (the gate sandbox confines writes to the checkout and private temp directories).
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { CheckTool } from "@vtc/shared";
import { globMatch } from "./globs.js";

/** How much of a tool is hashed; a bigger tool fails the gate as infrastructure, never half-hashed. */
export const TOOL_HASH_LIMITS = { maxFiles: 50_000, maxBytes: 1024 * 1024 * 1024 } as const;
export type ToolHashLimits = { readonly maxFiles: number; readonly maxBytes: number };

/** A tool's files as hashed: path to content hash (or `link:<target>`), sorted by path. */
export interface ToolSnapshot {
  /** SHA-256 of the lines `<path>\0<hash>\n`, sorted by path. */
  readonly sha256: string;
  readonly files: ReadonlyMap<string, string>;
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const command = (argv0: string): string =>
  basename(argv0)
    .replace(/\.(cmd|exe|bat|ps1)$/i, "")
    .toLowerCase();

const IGNORE_SCRIPTS = "--ignore-scripts";

/**
 * The scripts-free form of an install command: `rerun` when the command must then run as
 * configured to run the install-phase scripts. `null` when VTC knows no such form; the runner
 * then runs that command before it hashes the tools (and says so in evidence).
 */
export const scriptsFreeInstall = (
  argv: readonly string[],
): { readonly argv: string[]; readonly rerun: boolean } | null => {
  const [first, verb] = argv;
  if (first === undefined) return null;
  const name = command(first);
  const as = (extra: string | null): { argv: string[]; rerun: boolean } =>
    extra === null ? { argv: [...argv], rerun: false } : { argv: [...argv, extra], rerun: true };
  const ignoring = argv.includes(IGNORE_SCRIPTS);
  switch (name) {
    case "npm":
      if (!["ci", "install", "i", "clean-install", "install-clean"].includes(verb ?? ""))
        return null;
      return as(ignoring ? null : IGNORE_SCRIPTS);
    case "pnpm":
    case "bun":
      if (!["install", "i"].includes(verb ?? "")) return null;
      return as(ignoring ? null : IGNORE_SCRIPTS);
    case "yarn": {
      if (verb !== undefined && verb !== "install" && !verb.startsWith("-")) return null;
      const mode = argv.find((t) => t.startsWith("--mode"));
      const berry = argv.some((t) => /^--(immutable|immutable-cache|check-cache|mode)\b/.test(t));
      if (mode !== undefined) return mode === "--mode=skip-build" ? as(null) : null;
      if (berry) return as("--mode=skip-build");
      return as(ignoring ? null : IGNORE_SCRIPTS);
    }
    case "go":
      return verb === "mod" && argv[2] === "download" ? as(null) : null;
    case "cargo":
      return verb === "fetch" ? as(null) : null;
    default:
      return null;
  }
};

const GLOB_CHARS = /[*?{}[\]]/;

/** The segments of a glob before its first segment with a glob character. */
const literalBase = (glob: string): { base: string; whole: boolean } => {
  const segments = glob.split("/");
  const at = segments.findIndex((s) => GLOB_CHARS.test(s));
  return at < 0
    ? { base: glob, whole: true }
    : { base: segments.slice(0, at).join("/"), whole: false };
};

/**
 * Hashes the files under `globs` in `root` (see the module doc). Throws when there are more files
 * or bytes than `limits` allow.
 */
export const hashTool = (
  root: string,
  globs: readonly string[],
  limits: ToolHashLimits = TOOL_HASH_LIMITS,
): ToolSnapshot => {
  const files = new Map<string, string>();
  let bytes = 0;
  const add = (rel: string, hash: string): void => {
    if (files.has(rel)) return;
    if (files.size >= limits.maxFiles) {
      throw new Error(
        `the tool has more than ${String(limits.maxFiles)} files, more than the gate runner hashes`,
      );
    }
    files.set(rel, hash);
  };
  const hashFile = (rel: string, abs: string): void => {
    if (files.has(rel)) return;
    const content = readFileSync(abs);
    bytes += content.length;
    if (bytes > limits.maxBytes) {
      throw new Error(
        `the tool has more than ${String(limits.maxBytes)} bytes, more than the gate runner hashes`,
      );
    }
    add(rel, sha256(content));
  };
  /** One entry, never followed: a link is its target, a directory is walked. */
  const entry = (rel: string, abs: string, keep: (rel: string) => boolean): void => {
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      if (keep(rel)) add(rel, `link:${readlinkSync(abs)}`);
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(abs).sort()) entry(`${rel}/${name}`, join(abs, name), keep);
    } else if (keep(rel)) {
      if (stat.isFile()) hashFile(rel, abs);
      else add(rel, `special:${String(stat.mode)}`);
    }
  };
  for (const glob of globs) {
    const { base, whole } = literalBase(glob);
    const keep = whole ? (): boolean => true : (rel: string): boolean => globMatch(glob, rel);
    if (base === "") {
      for (const name of readdirSync(root).sort()) {
        if (name !== ".git") entry(name, join(root, name), keep);
      }
      continue;
    }
    const abs = join(root, base);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() && !whole) {
      // pnpm's `node_modules/<name>`: the link is a line, and the package it points to is walked.
      add(base, `link:${readlinkSync(abs)}`);
      let real: string;
      try {
        real = realpathSync(abs);
        if (!lstatSync(real).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const name of readdirSync(real).sort()) entry(`${base}/${name}`, join(real, name), keep);
      continue;
    }
    entry(base, abs, keep);
  }
  const sorted = new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const lines = [...sorted].map(([path, hash]) => `${path}\u0000${hash}\n`).join("");
  return { sha256: sha256(lines), files: sorted };
};

/** Paths whose hash differs between two snapshots (changed, added or removed), sorted. */
export const changedToolFiles = (before: ToolSnapshot, after: ToolSnapshot): string[] => {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...paths].filter((p) => before.files.get(p) !== after.files.get(p)).sort();
};

// ------------------------------------------------------------------ derivation

/** Runners whose first non-flag argument (after these sub-commands) names the tool. */
const RUNNERS: Readonly<
  Record<string, { readonly skip: readonly string[]; readonly kind: "node" | "python" }>
> = {
  pnpm: { skip: ["exec"], kind: "node" },
  npx: { skip: [], kind: "node" },
  npm: { skip: ["exec", "x"], kind: "node" },
  yarn: { skip: ["exec"], kind: "node" },
  bunx: { skip: [], kind: "node" },
  bun: { skip: ["x"], kind: "node" },
  uv: { skip: ["run"], kind: "python" },
  poetry: { skip: ["run"], kind: "python" },
};

/** Sub-commands that run a script, never a tool: what follows is not an executable's name. */
const SCRIPT_VERBS: ReadonlySet<string> = new Set(["run", "run-script", "test", "start"]);

const insideRoot = (root: string, abs: string): string | null => {
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
};

const realInside = (root: string, abs: string): string | null => {
  try {
    return insideRoot(root, realpathSync(abs));
  } catch {
    return null;
  }
};

const isFile = (abs: string): boolean => {
  try {
    return lstatSync(abs).isFile() || lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The tool's name after a runner and its sub-commands, or `null` (a script, not a tool). */
const unwrap = (argv: readonly string[]): { name: string; kind: "node" | "python" } | null => {
  const runner = RUNNERS[command(argv[0] ?? "")];
  if (runner === undefined) return null;
  let i = 1;
  if (argv[0] !== undefined && command(argv[0]) === "npm" && !runner.skip.includes(argv[1] ?? ""))
    return null;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    if (token === "--" || token.startsWith("-") || runner.skip.includes(token)) {
      i += 1;
      continue;
    }
    break;
  }
  const name = argv[i];
  if (name === undefined || SCRIPT_VERBS.has(name)) return null;
  return { name, kind: runner.kind };
};

/** The directories from `cwd` up to `root`, nearest first. */
const upFrom = (root: string, cwd: string): string[] => {
  const dirs: string[] = [];
  let dir = cwd;
  for (;;) {
    dirs.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir || (insideRoot(root, parent) === null && parent !== root)) break;
    dir = parent;
  }
  return dirs;
};

/** The file a pnpm or cmd-shim shell script starts (`"$basedir/../pkg/bin.js"`), if any. */
const shimTarget = (bin: string): string | null => {
  let text: string;
  try {
    const stat = lstatSync(bin);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    text = readFileSync(bin, "utf8");
  } catch {
    return null;
  }
  for (const match of text.matchAll(/"\$basedir\/([^"$]+)"/g)) {
    const target = join(dirname(bin), match[1] ?? "");
    try {
      if (lstatSync(realpathSync(target)).isFile()) return target;
    } catch {
      // not this one
    }
  }
  return null;
};

/** The nearest directory at or above `file` (real) holding a package.json, below a node_modules. */
const packageDirOf = (root: string, file: string): string | null => {
  let dir = dirname(file);
  while (insideRoot(root, dir) !== null) {
    if (basename(dir) === "node_modules") return null;
    if (isFile(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return null;
};

const packageName = (dir: string): string | null => {
  try {
    const name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown })
      .name;
    return typeof name === "string" && /^(@[\w.-]+\/)?[\w.-]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
};

/**
 * The `paths` of a Node bin (`<dir>/node_modules/.bin/<name>`, inside `root`): the bin and its
 * package, by the package's name under the same `node_modules` when that resolves to the same
 * directory (stable across pnpm store versions), else by its real path.
 */
const nodeToolPaths = (root: string, bin: string): string[] | null => {
  const binRel = insideRoot(root, bin);
  if (binRel === null || realInside(root, bin) === null) return null;
  let realBin: string;
  try {
    realBin = realpathSync(bin);
  } catch {
    return null;
  }
  const target = lstatSync(bin).isSymbolicLink() ? realBin : (shimTarget(bin) ?? realBin);
  const realTarget = (() => {
    try {
      return realpathSync(target);
    } catch {
      return null;
    }
  })();
  if (realTarget === null || insideRoot(root, realTarget) === null) return null;
  const pkg = packageDirOf(root, realTarget);
  if (pkg === null) return [binRel];
  const modules = dirname(dirname(bin)); // <dir>/node_modules
  const name = packageName(pkg);
  if (name !== null) {
    const logical = join(modules, ...name.split("/"));
    try {
      if (realpathSync(logical) === realpathSync(pkg)) {
        const rel = insideRoot(root, logical);
        if (rel !== null) return [binRel, `${rel}/**`];
      }
    } catch {
      // not linked by name: fall back to the real path
    }
  }
  const rel = insideRoot(root, pkg);
  return rel === null ? [binRel] : [binRel, `${rel}/**`];
};

/**
 * A `project` tool from a gate's command (GateSchema.tool absent, H-14): see the module doc.
 * `root` is the checkout, `cwd` the gate's working directory relative to it. `null` when the
 * executable is not inside the checkout.
 */
export const deriveProjectTool = (
  rootIn: string,
  cwd: string,
  argv: readonly string[],
): Extract<CheckTool, { source: "project" }> | null => {
  let root: string;
  try {
    root = realpathSync(rootIn);
  } catch {
    return null;
  }
  const start = join(root, cwd);
  const tool = (paths: string[] | null): Extract<CheckTool, { source: "project" }> | null =>
    paths === null || paths.length === 0 ? null : { source: "project", paths };
  const first = argv[0];
  if (first === undefined) return null;
  if (first.includes("/") || first.includes("\\")) {
    const abs = isAbsolute(first) ? first : join(start, first);
    if (!isFile(abs) || insideRoot(root, abs) === null || realInside(root, abs) === null)
      return null;
    if (basename(dirname(abs)) === ".bin" && basename(dirname(dirname(abs))) === "node_modules")
      return tool(nodeToolPaths(root, abs));
    return tool([insideRoot(root, abs) ?? ""]);
  }
  const unwrapped = unwrap(argv);
  if (unwrapped === null || unwrapped.name.includes("/")) return null;
  for (const dir of upFrom(root, start)) {
    if (unwrapped.kind === "node") {
      const bin = join(dir, "node_modules", ".bin", unwrapped.name);
      if (isFile(bin)) return tool(nodeToolPaths(root, bin));
    } else {
      for (const venv of [".venv", "venv"]) {
        const bin = join(dir, venv, "bin", unwrapped.name);
        if (isFile(bin) && realInside(root, bin) !== null) {
          return tool([insideRoot(root, bin) ?? ""]);
        }
      }
    }
  }
  return null;
};
