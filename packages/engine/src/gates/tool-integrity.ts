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
 * - {@link workspaceTree}, {@link compareInstall} and {@link compareGate} (spine §5 reading 252):
 *   the check every verify gate depends on. Every file and link of the checkout is hashed, the
 *   dependency trees (`node_modules`, `.yarn`, `.pnp.*`, `__pypackages__`, every Python virtual
 *   environment) and the checkout's own files alike, without parsing any gate command or choosing
 *   which files matter; what the install phase's scripts changed and what changed before each
 *   verify gate is diffed against it.
 * - {@link hashTool}: the hash of the tool a gate's command names, one line per file (its
 *   checkout-relative path and the SHA-256 of its bytes, or `link:<target>` for a symbolic link,
 *   which is never followed), sorted by path: display detail in `ToolIntegrity.sha256`. A glob's
 *   literal base directory is followed when it is a link (pnpm's `node_modules/<name>` points
 *   into `node_modules/.pnpm`) and the link itself is a line; nothing outside the checkout is ever
 *   read (a path that leads out is the line `outside-checkout`).
 * - {@link changedToolFiles}: the paths whose line differs between two snapshots.
 * - {@link deriveProjectTool}: a `project` tool from a gate command (display detail, and what
 *   `vtc calibrate` records): the executable it resolves to
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

/** Counts what one snapshot read against its limits, and throws past them. */
interface Budget {
  readonly limits: ToolHashLimits;
  files: number;
  bytes: number;
  /** What the error names: "tool" for {@link hashTool}, "checkout" for {@link workspaceTree}. */
  readonly what: string;
}

const tooMany = (budget: Budget, rel: string): ToolHashLimitError =>
  new ToolHashLimitError(
    rel,
    `the ${budget.what} has more than ${String(budget.limits.maxFiles)} files, more than the gate runner hashes`,
  );

const tooBig = (budget: Budget, rel: string): ToolHashLimitError =>
  new ToolHashLimitError(
    rel,
    `the ${budget.what} has more than ${String(budget.limits.maxBytes)} bytes, more than the gate runner hashes`,
  );

/** Counts one more line against the file limit. */
const countLine = (budget: Budget, rel: string): void => {
  if (budget.files >= budget.limits.maxFiles) throw tooMany(budget, rel);
  budget.files += 1;
};

/** The one read buffer every file is hashed through (hashing is synchronous). */
const CHUNK = Buffer.allocUnsafe(1024 * 1024);

/**
 * The line of one regular file (`stat` from its listing): the SHA-256 of its bytes, read through a
 * descriptor that never follows a link, or `changed-while-hashing` when it was replaced since the
 * listing. Its size is checked against the byte limit before it is read.
 */
const fileLine = (budget: Budget, rel: string, abs: string, stat: Stats): string => {
  if (budget.bytes + stat.size > budget.limits.maxBytes) throw tooBig(budget, rel);
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
    return RACED;
  }
  try {
    const now = fstatSync(fd);
    if (!now.isFile() || now.ino !== stat.ino || now.dev !== stat.dev) return RACED;
    const hash = createHash("sha256");
    for (;;) {
      const read = readSync(fd, CHUNK, 0, CHUNK.length, null);
      if (read === 0) break;
      budget.bytes += read;
      if (budget.bytes > budget.limits.maxBytes) throw tooBig(budget, rel);
      hash.update(CHUNK.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
};

/** A snapshot of `files` (any order): sorted by path, with the hash of its lines. */
const snapshotOf = (files: ReadonlyMap<string, string>): ToolSnapshot => {
  const sorted = new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const lines = [...sorted].map(([path, hash]) => `${path}\u0000${hash}\n`).join("");
  return { sha256: sha256(lines), files: sorted };
};

/**
 * Hashes the files under `globs` in `root` (see the module doc): the `sha256` a gate result shows
 * for the tool its command names (display detail since spine §5 reading 252; the check is
 * {@link workspaceTree}). Throws a {@link ToolHashLimitError} when there are more files or bytes
 * than `limits` allow. A glob's literal base that is a link (pnpm's `node_modules/<name>`) is a
 * line, and the directory it points to is walked when it is inside the checkout.
 *
 * No process of the checkout runs while it hashes (the runner's reaper stopped them).
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
  const budget: Budget = { limits, files: 0, bytes: 0, what: "tool" };
  const add = (rel: string, hash: string): void => {
    if (files.has(rel)) return;
    countLine(budget, rel);
    files.set(rel, hash);
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
    } else if (keep(rel) && !files.has(rel)) {
      add(rel, stat.isFile() ? fileLine(budget, rel, abs, stat) : `special:${String(stat.mode)}`);
    }
  };
  const all = (): boolean => true;
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
      continue;
    }
    entry(base, abs, keep);
  }
  return snapshotOf(files);
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

/**
 * Whether any of a tool's `paths` names something in the checkout (its literal base exists, not
 * followed when it is a link): a recorded tool none of whose paths does is stale (reading 249).
 */
export const toolPathsExist = (rootIn: string, paths: readonly string[]): boolean =>
  paths.some((glob) => lstatOrNull(join(rootIn, literalBase(glob).base)) !== null);

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

/** Interpreters a pnpm or cmd-shim shell shim runs from its own directory when present. */
const SHIM_INTERPRETERS = new Set(["node", "node.exe", "bun", "bun.exe"]);

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
    // `"$basedir/node"` is the interpreter the shim prefers when one sits beside it, never the
    // tool: a planted one would otherwise shrink the tool to the shim (reading 249)
    if (SHIM_INTERPRETERS.has(basename(match[1] ?? "").toLowerCase())) continue;
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

/** ESLint plugins, shareable configs, parsers and resolvers, and ESLint's own config packages. */
const ESLINT_EXTENSION =
  /^(eslint-(plugin|config|import-resolver)-[\w.-]+|@[\w.-]+\/eslint-(plugin|config)(-[\w.-]+)?|typescript-eslint|@typescript-eslint\/[\w.-]+|@eslint\/[\w.-]+)$/;

/** The lint configuration files whose imports ESLint loads. */
const LINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc.js",
  ".eslintrc.cjs",
];

/** The package a bare import specifier names (`@scope/name/sub` is `@scope/name`), or `null`. */
const importedPackage = (specifier: string): string | null => {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:"))
    return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  return NODE_NAME.test(name) ? name : null;
};

/** The packages a lint config imports or requires by a literal bare specifier. */
const configImports = (text: string): string[] => {
  const names = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+[^'"]*?\s+from\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = importedPackage(match[1] ?? "");
      if (name !== null) names.add(name);
    }
  }
  return [...names];
};

/**
 * The `node_modules/<name>/**` path of each package a lint gate's ESLint loads through its config
 * rather than as its dependencies (H-14; reading 249): the plugins, shareable configs, parsers and
 * resolvers that the package.json in `cwd` (and the checkout root's) lists in `dependencies` or
 * `devDependencies`, and every package the lint config in those directories imports or requires
 * (`@eslint/js`, `globals`, a prettier plugin), each when installed beside that package.json.
 * `vtc calibrate` records them in a lint gate's tool, which a gate result shows as detail; no
 * check depends on them (spine §5 reading 252: the whole checkout is diffed).
 */
export const lintPluginPaths = (repoRootIn: string, cwd: string): string[] => {
  let repoRoot: string;
  try {
    repoRoot = realpathSync(repoRootIn);
  } catch {
    return [];
  }
  const paths = new Set<string>();
  for (const dir of [...new Set([cwd, ""])]) {
    const names = new Set<string>();
    const manifest = readSmall(repoRoot, join(repoRoot, dir, "package.json"));
    if (manifest !== null) {
      let json: unknown = null;
      try {
        json = JSON.parse(manifest);
      } catch {
        // not a manifest: nothing listed
      }
      for (const field of ["dependencies", "devDependencies"]) {
        const deps =
          json !== null && typeof json === "object"
            ? (json as Record<string, unknown>)[field]
            : null;
        if (deps === null || typeof deps !== "object") continue;
        for (const name of Object.keys(deps)) if (ESLINT_EXTENSION.test(name)) names.add(name);
      }
    }
    for (const file of LINT_CONFIGS) {
      const text = readSmall(repoRoot, join(repoRoot, dir, file));
      if (text !== null) for (const name of configImports(text)) names.add(name);
    }
    for (const name of [...names].sort()) {
      const rel = [dir, "node_modules", name].filter((p) => p !== "").join("/");
      if (lstatOrNull(join(repoRoot, rel)) !== null) paths.add(`${rel}/**`);
    }
  }
  return [...paths];
};

/**
 * The directory of the installed package that holds `relPath` (checkout-relative, real): the path
 * up to and including the package name after its last `node_modules` segment (`@scope/name` for a
 * scoped one), or `null` when the path is not inside an installed package.
 */
const installedPackageOf = (relPath: string): string | null => {
  const parts = relPath.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return null;
  const first = parts[at + 1];
  if (first === undefined || first.startsWith(".")) return null;
  const end = first.startsWith("@") ? at + 3 : at + 2;
  if (parts.length < end) return null;
  return parts.slice(0, end).join("/");
};

// ------------------------------------------------- the dependency-tree diff (spine §5 reading 252)

/**
 * How much of the checkout {@link workspaceTree} hashes: every file of it, the dependency trees
 * included. Past them no verify gate runs (`infra`), never half-hashed.
 */
export const WORKSPACE_HASH_LIMITS = {
  maxFiles: 500_000,
  maxBytes: 8 * 1024 * 1024 * 1024,
} as const;

/** How many directories of the checkout the walk visits before it gives up. */
const WORKSPACE_MAX_DIRS = 200_000;

/** The lifecycle scripts the package managers run when they install a dependency. */
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;
/** A workspace package (the checkout's own) also has its `prepare` scripts run on install. */
const OWN_INSTALL_SCRIPTS = [...INSTALL_SCRIPTS, "preprepare", "prepare", "postprepare"] as const;

/** A directory holding a package.json. */
export interface PackageInfo {
  /** Installed (below a `node_modules`), rather than one of the checkout's own packages. */
  readonly installed: boolean;
  /**
   * The install scripts it declares (`binding.gyp` for an installed package with one: npm and
   * pnpm then run `node-gyp rebuild` as its install script).
   */
  readonly scripts: readonly string[];
}

/** One snapshot of the whole checkout (H-14, spine §5 reading 252; {@link workspaceTree}). */
export interface WorkspaceTree {
  /**
   * Every file and symbolic link of the checkout, `.git` left out, one line each: the SHA-256 of
   * a file's bytes, `link:<target>` for a link (never followed), `special:<mode>` for anything
   * else. Directories are walked, never lines.
   */
  readonly snapshot: ToolSnapshot;
  /** Each regular file's size, times and inode when it was hashed (the fast path's key). */
  readonly stats: ReadonlyMap<string, string>;
  /** Every directory holding a package.json, by checkout-relative path (`""`: the root). */
  readonly packages: ReadonlyMap<string, PackageInfo>;
  /** Every Python virtual environment (a directory holding `pyvenv.cfg`), checkout-relative. */
  readonly venvs: readonly string[];
  /** Each `node_modules/.bin` entry: the installed package directory it starts, or `null`. */
  readonly binOwners: ReadonlyMap<string, string | null>;
}

/** Path segments that start a dependency tree (Node, Yarn's cache and unplugged, PEP 582). */
const DEPENDENCY_SEGMENTS = new Set(["node_modules", ".yarn", "__pypackages__"]);

/**
 * Whether a checkout-relative path is in a dependency tree: below a `node_modules`, `.yarn` or
 * `__pypackages__`, one of Yarn PnP's `.pnp.*` files, or inside a virtual environment of `venvs`.
 * Everything else is the checkout's own.
 */
export const inDependencyTree = (path: string, venvs: readonly string[]): boolean => {
  const parts = path.split("/");
  if (parts.some((part) => DEPENDENCY_SEGMENTS.has(part))) return true;
  if ((parts.at(-1) ?? "").startsWith(".pnp.")) return true;
  return venvs.some((venv) => path === venv || path.startsWith(`${venv}/`));
};

/**
 * The package manager's own state files, which its scripts pass rewrites (pnpm's rebuild clears
 * `pendingBuilds` in `.modules.yaml`): no check tool loads them.
 */
const MANAGER_STATE: readonly RegExp[] = [
  /(^|\/)node_modules\/\.modules\.yaml$/,
  /(^|\/)node_modules\/\.pnpm\/lock\.yaml$/,
  /(^|\/)node_modules\/\.pnpm-workspace-state(-v\d+)?\.json$/,
  /(^|\/)node_modules\/\.package-lock\.json$/,
  /(^|\/)node_modules\/\.yarn-state\.yml$/,
  /(^|\/)node_modules\/\.yarn-integrity$/,
  /(^|\/)\.yarn\/install-state\.gz$/,
];

/**
 * The caches check tools write as they run, which change between verify gates: Vite's and
 * Vitest's (`node_modules/.vite`, `.vitest`), the shared `node_modules/.cache`, and Python's
 * bytecode (`__pycache__`). Only {@link compareGate} lets them change; the install phase may not.
 */
const isVolatileCache = (path: string): boolean =>
  /(^|\/)node_modules\/\.(cache|vite|vitest)\//.test(path) ||
  path.split("/").includes("__pycache__");

/** Whether a path is an entry of a `node_modules/.bin` directory. */
const isBinEntry = (path: string): boolean => {
  const parts = path.split("/");
  return parts.length >= 3 && parts.at(-2) === ".bin" && parts.at(-3) === "node_modules";
};

/** The installed package a `.bin` entry starts (a link's target, a shim's script), or `null`. */
const binOwner = (root: string, abs: string): string | null => {
  const stat = lstatOrNull(abs);
  if (stat === null) return null;
  let target: string;
  try {
    target = stat.isSymbolicLink() ? realpathSync(abs) : realpathSync(shimTarget(abs) ?? abs);
  } catch {
    return null;
  }
  const rel = insideRoot(root, target);
  return rel === null ? null : installedPackageOf(rel);
};

/** What a package.json in `dir` declares (see {@link PackageInfo}). */
const packageInfo = (
  root: string,
  dir: string,
  rel: string,
  names: readonly string[],
): PackageInfo => {
  const installed = rel.split("/").includes("node_modules");
  const scripts: string[] = [];
  const text = readSmall(root, join(dir, "package.json"));
  if (text !== null) {
    try {
      const declared = (JSON.parse(text) as { scripts?: unknown }).scripts;
      if (declared !== null && typeof declared === "object") {
        const wanted: readonly string[] = installed ? INSTALL_SCRIPTS : OWN_INSTALL_SCRIPTS;
        for (const name of wanted) {
          if (typeof (declared as Record<string, unknown>)[name] === "string") scripts.push(name);
        }
      }
    } catch {
      // not a manifest: no scripts
    }
  }
  if (installed && names.includes("binding.gyp")) scripts.push("binding.gyp");
  return { installed, scripts };
};

/**
 * Every file and link of the checkout, hashed (H-14, spine §5 reading 252): each
 * `node_modules` (`.pnpm`, `.bin` and nested ones included), `.yarn` and Yarn's `.pnp.*` files,
 * each virtual environment whole (site-packages included), and the checkout's own files. Nothing
 * is chosen by what a gate command runs. `.git` is never walked and no link is followed.
 *
 * With `previous`, a regular file whose size, modification and change times and inode are what
 * `previous` recorded keeps its line without being read again (the fast path between verify
 * gates); the snapshots the install phase is compared with are taken without it, from content.
 * Throws a {@link ToolHashLimitError} past `limits` or {@link WORKSPACE_MAX_DIRS}.
 */
export const workspaceTree = (
  rootIn: string,
  options: { readonly limits?: ToolHashLimits; readonly previous?: WorkspaceTree } = {},
): WorkspaceTree => {
  let root = rootIn;
  try {
    root = realpathSync(rootIn);
  } catch {
    // a missing checkout hashes nothing
  }
  const budget: Budget = {
    limits: options.limits ?? WORKSPACE_HASH_LIMITS,
    files: 0,
    bytes: 0,
    what: "checkout",
  };
  const previous = options.previous;
  const files = new Map<string, string>();
  const stats = new Map<string, string>();
  const packages = new Map<string, PackageInfo>();
  const venvs: string[] = [];
  const binOwners = new Map<string, string | null>();
  const queue: string[] = [""];
  for (let at = 0; at < queue.length; at++) {
    const rel = queue[at] ?? "";
    if (at >= WORKSPACE_MAX_DIRS) {
      throw new ToolHashLimitError(
        rel,
        `the checkout has more than ${String(WORKSPACE_MAX_DIRS)} directories, more than the gate runner walks`,
      );
    }
    const abs = rel === "" ? root : join(root, rel);
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      continue;
    }
    if (rel !== "" && names.includes("pyvenv.cfg")) venvs.push(rel);
    if (names.includes("package.json")) packages.set(rel, packageInfo(root, abs, rel, names));
    const binDir = isBinEntry(`${rel}/x`);
    for (const name of names) {
      if (name === ".git") continue;
      const child = rel === "" ? name : `${rel}/${name}`;
      const childAbs = join(abs, name);
      const stat = lstatOrNull(childAbs);
      if (stat === null) continue;
      if (stat.isDirectory()) {
        queue.push(child);
        continue;
      }
      countLine(budget, child);
      if (stat.isSymbolicLink()) {
        files.set(child, `link:${readlinkSync(childAbs)}`);
      } else if (stat.isFile()) {
        const key = `${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}:${String(stat.ino)}:${String(stat.dev)}`;
        const kept =
          previous !== undefined && previous.stats.get(child) === key
            ? previous.snapshot.files.get(child)
            : undefined;
        files.set(child, kept ?? fileLine(budget, child, childAbs, stat));
        stats.set(child, key);
      } else {
        files.set(child, `special:${String(stat.mode)}`);
      }
      if (binDir) binOwners.set(child, binOwner(root, childAbs));
    }
  }
  return { snapshot: snapshotOf(files), stats, packages, venvs, binOwners };
};

/** The files a package's own install script changed or added in its own directory. */
export interface SelfRebuilt {
  /** The package's directory, checkout-relative (`.` for the checkout's root package). */
  readonly package: string;
  readonly files: readonly string[];
}

/** What the install phase's scripts did to the checkout ({@link compareInstall}). */
export interface InstallComparison {
  /** Every path changed, removed or added that no rule allows: each fails every verify gate. */
  readonly tampered: readonly string[];
  /** Packages that rebuilt themselves (esbuild's native binary): allowed, shown as a warning. */
  readonly selfRebuilt: readonly SelfRebuilt[];
  /** The package manager's own state files its scripts pass rewrote: allowed. */
  readonly managerState: readonly string[];
}

/** The nearest directory at or above `path`'s holding one of the checkout's own packages. */
const ownPackageOf = (path: string, tree: WorkspaceTree): string | null => {
  let dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  for (;;) {
    const info = tree.packages.get(dir);
    if (info !== undefined) return info.installed ? null : dir;
    if (dir === "") return null;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
};

/**
 * The install phase's scripts against the snapshot taken before them (H-14, spine §5 reading
 * 252), both from content. Every path whose line differs is tampering, except:
 * - inside the directory of an installed package that declared an install script (or a
 *   `binding.gyp`) before the scripts ran, a change or an addition: that package rebuilt itself;
 *   a `.bin` entry that started that package before and still does may change with it (pnpm
 *   relinks the bin of a package it rebuilt);
 * - a file added in the directory of one of the checkout's own packages that declares an install
 *   or `prepare` script (never in a nested package or dependency tree of it, never a file that
 *   `isProtected` names, such as a check or gate-command config);
 * - the package manager's own state files ({@link MANAGER_STATE}).
 * Anything else changed, removed or added (another package's files, a new `.bin` entry or
 * directory, a config file of the checkout, a virtual environment's file) is tampering.
 */
export const compareInstall = (
  before: WorkspaceTree,
  after: WorkspaceTree,
  isProtected: (path: string) => boolean = () => false,
): InstallComparison => {
  const venvs = [...new Set([...before.venvs, ...after.venvs])];
  const tampered: string[] = [];
  const managerState: string[] = [];
  const rebuilt = new Map<string, string[]>();
  const rebuilds = (pkg: string | null | undefined): pkg is string => {
    if (pkg === null || pkg === undefined) return false;
    const info = before.packages.get(pkg);
    return info !== undefined && info.installed && info.scripts.length > 0;
  };
  const allow = (pkg: string, path: string): void => {
    const list = rebuilt.get(pkg) ?? [];
    list.push(path);
    rebuilt.set(pkg, list);
  };
  for (const path of changedToolFiles(before.snapshot, after.snapshot)) {
    if (MANAGER_STATE.some((state) => state.test(path))) {
      managerState.push(path);
      continue;
    }
    if (inDependencyTree(path, venvs)) {
      if (isBinEntry(path)) {
        const was = before.binOwners.get(path);
        if (after.snapshot.files.has(path) && was === after.binOwners.get(path) && rebuilds(was)) {
          allow(was, path);
        } else {
          tampered.push(path);
        }
        continue;
      }
      const pkg = installedPackageOf(path);
      if (pkg !== null && path.startsWith(`${pkg}/`) && rebuilds(pkg)) allow(pkg, path);
      else tampered.push(path);
      continue;
    }
    if (before.snapshot.files.has(path) || isProtected(path)) {
      tampered.push(path);
      continue;
    }
    const own = ownPackageOf(path, before);
    const info = own === null ? undefined : before.packages.get(own);
    if (own !== null && info !== undefined && info.scripts.length > 0) {
      allow(own === "" ? "." : own, path);
    } else {
      tampered.push(path);
    }
  }
  return {
    tampered,
    selfRebuilt: [...rebuilt]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([pkg, list]) => ({ package: pkg, files: list })),
    managerState,
  };
};

/**
 * The checkout just before a verify gate against the snapshot taken when the install phase
 * ended (H-14, spine §5 reading 252): every path whose line differs is tampering, except
 * - a check tool's own cache ({@link isVolatileCache}) and what `ignore` names (the runner's
 *   hidden acceptance tests);
 * - a file of the checkout's own added since (build outputs, reports, coverage), unless
 *   `isProtected` names it (a check or gate-command config that would change what a gate runs);
 * - a file of the checkout's own in `mayChange` (what a package's install script built, which a
 *   build gate rebuilds).
 * Any change in a dependency tree, and any change or removal of the checkout's own files, fails.
 */
export const compareGate = (
  afterInstall: WorkspaceTree,
  now: WorkspaceTree,
  options: {
    readonly isProtected?: (path: string) => boolean;
    readonly ignore?: (path: string) => boolean;
    readonly mayChange?: ReadonlySet<string>;
  } = {},
): string[] => {
  const venvs = [...new Set([...afterInstall.venvs, ...now.venvs])];
  const tampered: string[] = [];
  for (const path of changedToolFiles(afterInstall.snapshot, now.snapshot)) {
    if (options.ignore?.(path) === true || isVolatileCache(path)) continue;
    if (inDependencyTree(path, venvs)) tampered.push(path);
    else if (afterInstall.snapshot.files.has(path)) {
      if (options.mayChange?.has(path) !== true) tampered.push(path);
    } else if (options.isProtected?.(path) === true) tampered.push(path);
  }
  return tampered;
};
