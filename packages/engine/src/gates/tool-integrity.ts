/**
 * Check tools that install scripts cannot replace (H-14; spine §5 readings 80(c) and 238;
 * `GateSchema.tool`, `CheckTool`, `GateResult.tool`). Pure helpers over the file system; the Gate
 * Runner (`runner.ts`) decides when they run:
 *
 * - {@link scriptsFreeInstall}: an install-phase command in two passes, the first running no
 *   lifecycle script and the second running the scripts it skipped. Only forms checked against
 *   the real package manager (`tool-tamper.live.test.ts`): `npm ci` (`--ignore-scripts`, then
 *   `npm ci` again: an `npm install` of an installed tree runs no dependency's script),
 *   `pnpm install` (`--ignore-scripts`, then `pnpm rebuild --recursive --pending` with the
 *   install's `-C`/`--dir`: a second `pnpm install` leaves the pending builds unbuilt, and a
 *   non-recursive rebuild builds a workspace's root project only; an install with `--filter` has
 *   no two passes) and `bun install` (`--ignore-scripts`, then `bun install --force`: a
 *   second plain `bun install` of a workspace skips its packages' dependency scripts); `go mod download` and `cargo fetch` run no project code as they are. Any other
 *   install (Yarn, `npm install`, `uv sync`, a custom script) has no scripts-free form here.
 * - {@link hashTool}: the hash of a `project` tool's files, one line per file (its checkout-relative
 *   path and the SHA-256 of its bytes, or `link:<target>` for a symbolic link, which is never
 *   followed), sorted by path. A glob's literal base directory is followed when it is a link
 *   (pnpm's `node_modules/<name>` points into `node_modules/.pnpm`) and the link itself is a line;
 *   nothing outside the checkout is ever read (a path that leads out is the line
 *   `outside-checkout`). A Node package's dependency closure and a Python virtual environment
 *   script's distribution closure are hashed with it.
 * - {@link changedToolFiles}: the files the install phase changed, added or removed.
 * - {@link deriveProjectTool}: a `project` tool from a gate command: the executable it resolves to
 *   inside the checkout (unwrapping `pnpm exec`, `npx`, `npm exec`, `yarn`, `bunx`, `uv run`,
 *   `poetry run`, and a package script's body) and the package that executable belongs to. A
 *   command whose executable is outside the checkout has no project tool: install-phase code
 *   cannot write there (the gate sandbox confines writes to the checkout and private temp
 *   directories).
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
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

/** A tool with more files or bytes than its limits; `path` is the file that crossed them. */
export class ToolHashLimitError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolHashLimitError";
  }
}

/** The line of a path that leads out of the checkout: it is never followed or read. */
const OUTSIDE = "outside-checkout";
/** The line of a file that was replaced between its listing and its read. */
const RACED = "changed-while-hashing";
const NOFOLLOW: number = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The SHA-256 of a file, read in chunks rather than whole. */
export const sha256File = (abs: string): string => {
  const fd = openSync(abs, constants.O_RDONLY);
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
};

const command = (argv0: string): string =>
  basename(argv0)
    .replace(/\.(cmd|exe|bat|ps1)$/i, "")
    .toLowerCase();

const IGNORE_SCRIPTS = "--ignore-scripts";

/**
 * pnpm's second pass: every workspace project's pending builds and its own install scripts (a
 * plain `pnpm rebuild --pending` at a workspace root builds the root project only).
 */
const PNPM_BUILD = ["rebuild", "--recursive", "--pending"] as const;
const PNPM_DIR_FLAGS = ["-C", "--dir"];
/** Flags that pick which workspace projects an install covers: no rebuild picks the same ones. */
const PNPM_SELECT = ["--filter", "-F", "--filter-prod"];

/**
 * A `pnpm install` (or `pnpm i`) and the flags that set the directory it runs in (`-C`, `--dir`),
 * which its second pass keeps; `null` for any other pnpm command, and for an install that picks
 * workspace projects (`--filter`), which then has no scripts-free form.
 */
const pnpmInstall = (argv: readonly string[]): { dirFlags: string[] } | null => {
  const dirFlags: string[] = [];
  let verb: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? "";
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq < 0 ? token : token.slice(0, eq);
    if (PNPM_SELECT.includes(flag)) return null;
    if (PNPM_DIR_FLAGS.includes(flag)) {
      const value = eq >= 0 ? token.slice(eq + 1) : argv[i + 1];
      if (value === undefined) return null;
      dirFlags.push(flag, value);
      if (eq < 0) i++;
      continue;
    }
    if (verb === null && !token.startsWith("-")) verb = token;
  }
  return verb === "install" || verb === "i" ? { dirFlags } : null;
};

/** An install in two passes (H-14): see {@link scriptsFreeInstall}. */
export interface InstallPasses {
  /** The install that runs no lifecycle script. */
  readonly free: string[];
  /** What then runs the scripts the first pass skipped; `null` when it skipped none. */
  readonly build: string[] | null;
}

/**
 * The two passes of an install command (see the module doc), or `null` when VTC knows no
 * scripts-free form of it; the runner then runs it as configured (and says so in evidence). A
 * command that already runs no script is its own first pass, with no second.
 */
export const scriptsFreeInstall = (argv: readonly string[]): InstallPasses | null => {
  const [first, verb] = argv;
  if (first === undefined) return null;
  const name = command(first);
  const ignoring = argv.includes(IGNORE_SCRIPTS);
  const twice = (build: string[]): InstallPasses =>
    ignoring ? { free: [...argv], build: null } : { free: [...argv, IGNORE_SCRIPTS], build };
  const install = ["install", "i"].includes(verb ?? "");
  switch (name) {
    case "npm":
      if (["ci", "clean-install", "install-clean"].includes(verb ?? "")) return twice([...argv]);
      // `npm install` of a tree it just installed runs no dependency's script: no second pass.
      return install && ignoring ? { free: [...argv], build: null } : null;
    case "pnpm": {
      const pnpm = pnpmInstall(argv);
      return pnpm === null ? null : twice([first, ...pnpm.dirFlags, ...PNPM_BUILD]);
    }
    case "bun":
      // A second plain `bun install` of a workspace skips its packages' dependency scripts.
      return install ? twice(argv.includes("--force") ? [...argv] : [...argv, "--force"]) : null;
    case "go":
      return verb === "mod" && argv[2] === "download" ? { free: [...argv], build: null } : null;
    case "cargo":
      return verb === "fetch" ? { free: [...argv], build: null } : null;
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

/** Where `abs` really is: `missing`, `outside` the checkout, or its real path inside it. */
const whereIs = (root: string, abs: string): { real: string } | "missing" | "outside" => {
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return "missing";
  }
  return real === root || insideRoot(root, real) !== null ? { real } : "outside";
};

const lstatOrNull = (abs: string): Stats | null => {
  try {
    return lstatSync(abs);
  } catch {
    return null;
  }
};

/** A small regular file inside the checkout (never through a link), or `null`. */
const readSmall = (root: string, abs: string, max = 1024 * 1024): string | null => {
  const stat = lstatOrNull(abs);
  if (stat === null || !stat.isFile() || stat.size > max) return null;
  if (realInside(root, abs) === null) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

const NODE_NAME = /^(@[\w.-]+\/)?[\w.-]+$/;

/** The dependencies a Node package's package.json names (`dependencies`, optional and peer). */
const nodeDependencies = (root: string, pkg: string): string[] => {
  const text = readSmall(root, join(pkg, "package.json"));
  if (text === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (json === null || typeof json !== "object") return [];
  const names = new Set<string>();
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = (json as Record<string, unknown>)[field];
    if (deps === null || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) if (NODE_NAME.test(name)) names.add(name);
  }
  return [...names].sort();
};

const normalizePy = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

/** Whether a dist-info's entry_points.txt names console (or GUI) script `wanted`. */
const providesScript = (text: string, wanted: string): boolean => {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) section = line;
    else if (section === "[console_scripts]" || section === "[gui_scripts]") {
      const eq = line.indexOf("=");
      if (eq > 0 && normalizePy(line.slice(0, eq).trim()) === wanted) return true;
    }
  }
  return false;
};

/**
 * Hashes the files under `globs` in `root` (see the module doc). Throws a
 * {@link ToolHashLimitError} when there are more files or bytes than `limits` allow.
 *
 * Beside the globs' own files:
 * - a glob's base that is a Node package (a directory with a package.json below a
 *   `node_modules`) adds its dependency closure: each `dependencies`, `optionalDependencies` and
 *   `peerDependencies` name resolved the way Node does (`node_modules` up from the package, in the
 *   checkout only), every file of each package found keyed by its real checkout-relative path,
 *   and each link on the way as its own line;
 * - a glob that names a virtual environment's script (`<venv>/bin/<name>`, beside a
 *   `pyvenv.cfg`) adds the files of the distribution whose console script it is and of every
 *   distribution it requires (by `Requires-Dist`, extras left out), each by the top-level names
 *   its `RECORD` lists, and the site-packages startup files (`*.pth`, `sitecustomize.py`,
 *   `usercustomize.py`).
 *
 * No process of the checkout runs while it hashes (the runner's reaper stopped them). A file's
 * size is checked against the limits before it is read, it is read through a descriptor that
 * never follows a link, and one replaced between its listing and its read is the line
 * `changed-while-hashing`.
 */
export const hashTool = (
  rootIn: string,
  globs: readonly string[],
  limits: ToolHashLimits = TOOL_HASH_LIMITS,
): ToolSnapshot => {
  let root = rootIn;
  try {
    root = realpathSync(rootIn);
  } catch {
    // a missing checkout hashes nothing
  }
  const files = new Map<string, string>();
  let bytes = 0;
  const tooMany = (rel: string): ToolHashLimitError =>
    new ToolHashLimitError(
      rel,
      `the tool has more than ${String(limits.maxFiles)} files, more than the gate runner hashes`,
    );
  const tooBig = (rel: string): ToolHashLimitError =>
    new ToolHashLimitError(
      rel,
      `the tool has more than ${String(limits.maxBytes)} bytes, more than the gate runner hashes`,
    );
  const add = (rel: string, hash: string): void => {
    if (files.has(rel)) return;
    if (files.size >= limits.maxFiles) throw tooMany(rel);
    files.set(rel, hash);
  };
  const hashFile = (rel: string, abs: string, stat: Stats): void => {
    if (files.has(rel)) return;
    if (files.size >= limits.maxFiles) throw tooMany(rel);
    if (bytes + stat.size > limits.maxBytes) throw tooBig(rel);
    let fd: number;
    try {
      fd = openSync(abs, constants.O_RDONLY | NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
      add(rel, RACED);
      return;
    }
    try {
      const now = fstatSync(fd);
      if (!now.isFile() || now.ino !== stat.ino || now.dev !== stat.dev) {
        add(rel, RACED);
        return;
      }
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(Math.max(1, Math.min(1024 * 1024, stat.size)));
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) break;
        bytes += read;
        if (bytes > limits.maxBytes) throw tooBig(rel);
        hash.update(chunk.subarray(0, read));
      }
      add(rel, hash.digest("hex"));
    } finally {
      closeSync(fd);
    }
  };
  /** One entry, never followed: a link is its target, a directory is walked (in the checkout). */
  const entry = (rel: string, abs: string, keep: (rel: string) => boolean): void => {
    const stat = lstatOrNull(abs);
    if (stat === null) return;
    if (stat.isSymbolicLink()) {
      if (keep(rel)) add(rel, `link:${readlinkSync(abs)}`);
    } else if (stat.isDirectory()) {
      const where = whereIs(root, abs);
      if (where === "outside") add(rel, OUTSIDE);
      if (typeof where !== "object") return;
      for (const name of readdirSync(where.real).sort()) {
        entry(`${rel}/${name}`, join(where.real, name), keep);
      }
    } else if (keep(rel)) {
      if (stat.isFile()) hashFile(rel, abs, stat);
      else add(rel, `special:${String(stat.mode)}`);
    }
  };
  const all = (): boolean => true;
  const isPackageDir = (real: string): boolean =>
    lstatOrNull(join(real, "package.json"))?.isFile() === true &&
    (insideRoot(root, real) ?? "").split("/").includes("node_modules");

  /** Node's resolution of `name` from the package at `pkg` (real), in the checkout only. */
  const resolveNode = (pkg: string, name: string): string | null => {
    let dir = pkg;
    for (;;) {
      const candidate = join(dir, "node_modules", ...name.split("/"));
      const stat = basename(dir) === "node_modules" ? null : lstatOrNull(candidate);
      if (stat !== null) {
        const rel = insideRoot(root, candidate);
        if (rel === null) return null;
        if (whereIs(root, dirname(candidate)) === "outside") {
          add(rel, OUTSIDE);
          return null;
        }
        if (stat.isSymbolicLink()) add(rel, `link:${readlinkSync(candidate)}`);
        const where = whereIs(root, candidate);
        if (where === "outside") add(rel, OUTSIDE);
        return typeof where === "object" && lstatOrNull(where.real)?.isDirectory() === true
          ? where.real
          : null;
      }
      if (dir === root) return null;
      const up = dirname(dir);
      if (up === dir || (up !== root && insideRoot(root, up) === null)) return null;
      dir = up;
    }
  };
  const nodeClosure = (start: string): void => {
    const seen = new Set([start]);
    const queue = [start];
    for (let pkg = queue.shift(); pkg !== undefined; pkg = queue.shift()) {
      for (const name of nodeDependencies(root, pkg)) {
        const dep = resolveNode(pkg, name);
        if (dep === null || seen.has(dep)) continue;
        seen.add(dep);
        const rel = insideRoot(root, dep);
        if (rel === null) continue;
        entry(rel, dep, all);
        queue.push(dep);
      }
    }
  };

  /** The distribution closure of a virtual environment's script (see the doc above). */
  const pythonClosure = (script: string): void => {
    const bin = dirname(script);
    const venv = dirname(bin);
    if (!["bin", "Scripts"].includes(basename(bin))) return;
    if (lstatOrNull(join(venv, "pyvenv.cfg"))?.isFile() !== true) return;
    const sites: string[] = [join(venv, "Lib", "site-packages")];
    const lib = whereIs(root, join(venv, "lib"));
    if (typeof lib === "object" && lstatOrNull(lib.real)?.isDirectory() === true) {
      for (const name of readdirSync(lib.real).sort()) {
        if (name.startsWith("python")) sites.push(join(lib.real, name, "site-packages"));
      }
    }
    const wanted = normalizePy(basename(script).replace(/\.exe$/i, ""));
    for (const candidate of sites) {
      const where = whereIs(root, candidate);
      if (typeof where !== "object" || lstatOrNull(where.real)?.isDirectory() !== true) continue;
      const site = where.real;
      const siteRel = insideRoot(root, site);
      if (siteRel === null) continue;
      const names = readdirSync(site).sort();
      for (const name of names) {
        if (name.endsWith(".pth") || ["sitecustomize.py", "usercustomize.py"].includes(name))
          entry(`${siteRel}/${name}`, join(site, name), all);
      }
      const dists = new Map<string, string>();
      for (const name of names) {
        if (!name.endsWith(".dist-info")) continue;
        const stem = name.slice(0, -".dist-info".length);
        const at = stem.lastIndexOf("-");
        dists.set(normalizePy(at > 0 ? stem.slice(0, at) : stem), name);
      }
      const owner = [...dists.values()].find((dist) =>
        providesScript(readSmall(root, join(site, dist, "entry_points.txt")) ?? "", wanted),
      );
      if (owner === undefined) continue;
      const seen = new Set([owner]);
      const queue = [owner];
      for (let dist = queue.shift(); dist !== undefined; dist = queue.shift()) {
        const record = readSmall(root, join(site, dist, "RECORD"), 16 * 1024 * 1024) ?? "";
        const tops = new Set<string>([dist]);
        for (const line of record.split(/\r?\n/)) {
          const path = line.split(",")[0] ?? "";
          const top = path.split("/")[0] ?? "";
          if (["", ".", ".."].includes(top) || isAbsolute(path) || top.includes("\\")) continue;
          tops.add(top);
        }
        for (const top of [...tops].sort()) entry(`${siteRel}/${top}`, join(site, top), all);
        const metadata = readSmall(root, join(site, dist, "METADATA")) ?? "";
        for (const line of metadata.split(/\r?\n/)) {
          const match = /^Requires-Dist:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
          if (match?.[1] === undefined || /\bextra\s*==/.test(line)) continue;
          const dep = dists.get(normalizePy(match[1]));
          if (dep !== undefined && !seen.has(dep)) {
            seen.add(dep);
            queue.push(dep);
          }
        }
      }
    }
  };

  for (const glob of globs) {
    const { base, whole } = literalBase(glob);
    const keep = whole ? all : (rel: string): boolean => globMatch(glob, rel);
    if (base === "") {
      for (const name of readdirSync(root).sort()) {
        if (name !== ".git") entry(name, join(root, name), keep);
      }
      continue;
    }
    // Nothing is read through a link on the way to the base.
    const parent = whereIs(root, dirname(join(root, base)));
    if (parent === "outside") add(base, OUTSIDE);
    if (typeof parent !== "object") continue;
    const abs = join(parent.real, basename(base));
    const stat = lstatOrNull(abs);
    if (stat === null) continue;
    if (stat.isSymbolicLink() && !whole) {
      // pnpm's `node_modules/<name>`: the link is a line, and the package it points to is walked.
      add(base, `link:${readlinkSync(abs)}`);
      const where = whereIs(root, abs);
      if (typeof where !== "object" || lstatOrNull(where.real)?.isDirectory() !== true) continue;
      for (const name of readdirSync(where.real).sort()) {
        entry(`${base}/${name}`, join(where.real, name), keep);
      }
      if (isPackageDir(where.real)) nodeClosure(where.real);
      continue;
    }
    entry(base, abs, keep);
    if (stat.isDirectory() && !whole) {
      const where = whereIs(root, abs);
      if (typeof where === "object" && isPackageDir(where.real)) nodeClosure(where.real);
    } else if (whole && !stat.isDirectory()) {
      pythonClosure(abs);
    }
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

/**
 * Whether a tool's configured `paths` cover one path {@link deriveProjectTool} found: the same
 * glob, or a glob that matches it (for a package's `<dir>/**`, its `<dir>/package.json`).
 */
export const toolPathsCover = (paths: readonly string[], derived: string): boolean => {
  const probe = derived.endsWith("/**") ? `${derived.slice(0, -3)}/package.json` : derived;
  return paths.some((glob) => glob === derived || globMatch(glob, probe));
};

// ------------------------------------------------------------------ derivation

interface Runner {
  readonly kind: "node" | "python";
  /** Sub-commands whose next word is an executable. */
  readonly exec: readonly string[];
  /** Sub-commands whose next word is a package script (`either`: a script, else an executable). */
  readonly run: readonly string[];
  readonly runFinds: "script" | "either";
  /** Sub-commands that are themselves the name of a package script. */
  readonly scripts: readonly string[];
  /** What a first word that is none of the above names (`none`: a command of the runner's own). */
  readonly bare: "bin" | "either" | "none";
  /** Flags whose value is a directory the command runs in. */
  readonly dirFlags: readonly string[];
  /** Flags and words that pick other packages to run in: nothing is resolved from here. */
  readonly select: readonly string[];
  /** Other flags that take a value. */
  readonly valueFlags: readonly string[];
}

const RUNNERS: Readonly<Record<string, Runner>> = {
  pnpm: {
    kind: "node",
    exec: ["exec"],
    run: ["run", "run-script"],
    runFinds: "script",
    scripts: ["test", "t", "start"],
    bare: "either",
    dirFlags: ["-C", "--dir"],
    select: ["--filter", "-F", "--filter-prod", "--recursive", "-r"],
    valueFlags: ["--reporter", "--loglevel", "--workspace-concurrency"],
  },
  npm: {
    kind: "node",
    exec: ["exec", "x"],
    run: ["run", "run-script", "rum", "urn"],
    runFinds: "script",
    scripts: ["test", "t", "tst", "start"],
    bare: "none",
    dirFlags: ["--prefix", "-C"],
    select: ["--workspace", "-w", "--workspaces", "-ws"],
    valueFlags: ["--package", "-p", "--loglevel"],
  },
  npx: {
    kind: "node",
    exec: [],
    run: [],
    runFinds: "script",
    scripts: [],
    bare: "bin",
    dirFlags: [],
    select: ["--workspace", "-w", "--package", "-p"],
    valueFlags: [],
  },
  yarn: {
    kind: "node",
    exec: ["exec"],
    run: ["run"],
    runFinds: "either",
    scripts: ["test", "start"],
    bare: "either",
    dirFlags: ["--cwd"],
    select: ["workspace", "workspaces"],
    valueFlags: [],
  },
  bunx: {
    kind: "node",
    exec: [],
    run: [],
    runFinds: "script",
    scripts: [],
    bare: "bin",
    dirFlags: [],
    select: ["--package", "-p"],
    valueFlags: [],
  },
  bun: {
    kind: "node",
    exec: ["x"],
    run: ["run"],
    runFinds: "either",
    scripts: [],
    bare: "none",
    dirFlags: ["--cwd"],
    select: ["--filter", "-F"],
    valueFlags: [],
  },
  uv: {
    kind: "python",
    exec: ["run"],
    run: [],
    runFinds: "script",
    scripts: [],
    bare: "none",
    dirFlags: ["--directory", "--project"],
    select: ["--with", "--with-requirements", "--with-editable", "--package"],
    valueFlags: ["--python", "-p", "--extra", "--group", "--env-file", "--index"],
  },
  poetry: {
    kind: "python",
    exec: ["run"],
    run: [],
    runFinds: "script",
    scripts: [],
    bare: "none",
    dirFlags: ["-C", "--directory", "-P", "--project"],
    select: [],
    valueFlags: [],
  },
};

/** What a runner command runs: executable or package script `name`, from directory `dir`. */
interface Unwrapped {
  readonly name: string;
  readonly kind: "node" | "python";
  readonly finds: "bin" | "script" | "either";
  /** Relative to the command's working directory (a `-C`/`--dir`/`--cwd` flag's value). */
  readonly dir: string;
}

/** The executable or script a runner command names, or `null` (unknown, or not resolvable). */
const unwrap = (argv: readonly string[]): Unwrapped | null => {
  const runner = RUNNERS[command(argv[0] ?? "")];
  if (runner === undefined) return null;
  let dir = "";
  let finds: Unwrapped["finds"] | null = null;
  let i = 1;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq < 0 ? token : token.slice(0, eq);
    const takesValue = runner.dirFlags.includes(flag) || runner.valueFlags.includes(flag);
    const value = eq >= 0 ? token.slice(eq + 1) : takesValue ? argv[i + 1] : undefined;
    i += takesValue && eq < 0 ? 2 : 1;
    if (runner.select.includes(flag)) return null;
    if (runner.dirFlags.includes(flag)) {
      if (value === undefined || isAbsolute(value)) return null;
      dir = join(dir, value);
      continue;
    }
    if (takesValue || token === "--" || token.startsWith("-")) continue;
    if (finds === null) {
      if (runner.exec.includes(token)) {
        finds = "bin";
        continue;
      }
      if (runner.run.includes(token)) {
        finds = runner.runFinds;
        continue;
      }
      if (runner.scripts.includes(token)) {
        const name = token === "t" || token === "tst" ? "test" : token;
        return { name, kind: runner.kind, finds: "script", dir };
      }
      if (runner.bare === "none") return null;
      finds = runner.bare;
    }
    return { name: token, kind: runner.kind, finds, dir };
  }
  return null;
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

const isFile = (abs: string): boolean => {
  const stat = lstatOrNull(abs);
  return stat !== null && (stat.isFile() || stat.isSymbolicLink());
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
    return typeof name === "string" && NODE_NAME.test(name) ? name : null;
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

/** The tool paths of the executable `name` resolves to from `start` up to `root`. */
const binPaths = (
  root: string,
  start: string,
  name: string,
  kind: "node" | "python",
): string[] | null => {
  if (name.includes("/") || name.includes("\\")) return null;
  for (const dir of upFrom(root, start)) {
    if (kind === "node") {
      const bin = join(dir, "node_modules", ".bin", name);
      if (isFile(bin)) return nodeToolPaths(root, bin);
    } else {
      for (const venv of [".venv", "venv"]) {
        const bin = join(dir, venv, "bin", name);
        if (isFile(bin) && realInside(root, bin) !== null) return [insideRoot(root, bin) ?? ""];
      }
    }
  }
  return null;
};

/** The body of package script `name` in the package.json nearest `start`, and its directory. */
const packageScript = (
  root: string,
  start: string,
  name: string,
): { body: string; dir: string } | null => {
  for (const dir of upFrom(root, start)) {
    const text = readSmall(root, join(dir, "package.json"));
    if (text === null) continue;
    try {
      const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts;
      const body = scripts?.[name];
      return typeof body === "string" ? { body, dir } : null;
    } catch {
      return null;
    }
  }
  return null;
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_SCRIPT_DEPTH = 3;

/**
 * The tool paths of a package script's body: each of its commands (split at `&&`, `||`, `;` and
 * `|`; leading `NAME=value` words and `cross-env` left out) resolved like a gate command from the
 * script's package directory, where a bare name is a bin of `node_modules/.bin`. A command that
 * names no tool in the checkout adds nothing.
 */
const scriptPaths = (root: string, body: string, dir: string, depth: number): string[] => {
  const paths: string[] = [];
  for (const part of body.split(/&&|\|\||;|\|/)) {
    const tokens = part
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^["']|["']$/g, ""))
      .filter((t) => t !== "");
    while (
      tokens.length > 0 &&
      (ENV_ASSIGNMENT.test(tokens[0] ?? "") || tokens[0] === "cross-env")
    ) {
      tokens.shift();
    }
    const found = tokens.length === 0 ? null : derivePaths(root, dir, tokens, depth + 1);
    if (found !== null) paths.push(...found);
  }
  return paths;
};

const derivePaths = (
  root: string,
  start: string,
  argv: readonly string[],
  depth: number,
): string[] | null => {
  const first = argv[0];
  if (first === undefined || depth > MAX_SCRIPT_DEPTH) return null;
  if (first.includes("/") || first.includes("\\")) {
    const abs = isAbsolute(first) ? first : join(start, first);
    if (!isFile(abs) || insideRoot(root, abs) === null || realInside(root, abs) === null)
      return null;
    if (basename(dirname(abs)) === ".bin" && basename(dirname(dirname(abs))) === "node_modules")
      return nodeToolPaths(root, abs);
    return [insideRoot(root, abs) ?? ""];
  }
  const unwrapped = unwrap(argv);
  if (unwrapped === null) {
    // In a package script a bare name is one of the package's bins (they are on its PATH).
    if (depth === 0 || RUNNERS[command(first)] !== undefined) return null;
    return binPaths(root, start, first, "node");
  }
  const from = join(start, unwrapped.dir);
  if (from !== root && insideRoot(root, from) === null) return null;
  if (unwrapped.kind === "node" && unwrapped.finds !== "bin") {
    const script = packageScript(root, from, unwrapped.name);
    if (script !== null) {
      const paths = scriptPaths(root, script.body, script.dir, depth);
      return paths.length === 0 ? null : paths;
    }
    if (unwrapped.finds === "script") return null;
  }
  return binPaths(root, from, unwrapped.name, unwrapped.kind);
};

/**
 * A `project` tool from a gate's command (H-14): see the module doc. `root` is the checkout,
 * `cwd` the gate's working directory relative to it. `null` when no executable it runs is inside
 * the checkout, or when the command picks other packages to run in (`pnpm --filter`,
 * `npm --workspace`), which the runner then lists as unverified.
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
  const found = derivePaths(root, join(root, cwd), argv, 0) ?? [];
  const paths = [...new Set(found)].filter((p) => p !== "").slice(0, 50);
  return paths.length === 0 ? null : { source: "project", paths };
};
