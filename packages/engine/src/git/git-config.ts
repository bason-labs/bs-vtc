/**
 * The git configuration as an agent could change it (AD-7 rule 7, AD-8 rule 3; spine §5
 * readings 22 and 23). `git status` never shows `.git/`, yet a write there changes what the
 * engine's own git calls do: a hook, a `filter.<x>.clean` or `merge.<x>.driver` named from
 * `info/attributes` or a worktree's `.gitattributes`, `gpg.program`, `core.sshCommand`, an
 * `include` of a file the agent writes. The engine fingerprints what can make git run code (the
 * held set) while any role is in flight, and refuses to run git on a changed one.
 *
 * Held: every hook, `info/attributes`, and every config key except a small allow-list of keys
 * that cannot run code ({@link ALLOWED_CONFIG_KEYS}: `user.name`, `color.*`, `pull.rebase`, …),
 * which may change without pausing the run (e.g. a human's `git config user.email`). Unknown
 * keys are held. Config files are the repo's (`config`, `config.worktree`, each linked
 * worktree's), the user's global config, and every file an `include.path` or `includeIf.*.path`
 * names. They are read with git's own parser (`git config --file … --list`, which runs nothing),
 * cached on each file's stat, since the check runs before every engine git call.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gitEnv } from "./env.js";

/** The held git configuration changed while a role was in flight. */
export class GitConfigChangedError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `refusing to run git: ${paths.join(", ")} changed while a role was in flight`.slice(0, 500),
    );
    this.name = "GitConfigChangedError";
  }
}

/**
 * Config keys that cannot make git run code: they may change during a run (spine §5 reading
 * 23). `section[.<subsection>].name`, lower-cased section and name; `<sub>` is any subsection.
 * Everything else, unknown keys included, is held.
 */
export const ALLOWED_CONFIG_KEYS: readonly string[] = [
  "user.name",
  "user.email",
  "color.*",
  "color.<sub>.*",
  "init.defaultbranch",
  "pull.rebase",
  "pull.ff",
  "push.default",
  "push.autosetupremote",
  "branch.<sub>.merge",
  "branch.<sub>.remote",
  "branch.<sub>.rebase",
  "branch.<sub>.description",
  // the `gh` CLI records which remote it resolved (a name, never a command)
  "remote.<sub>.gh-resolved",
];

/** True when a config key (as `git config --list` prints it) may change during a run. */
export const isAllowedConfigKey = (key: string): boolean => {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0) return false;
  const section = key.slice(0, first).toLowerCase();
  const name = key.slice(last + 1).toLowerCase();
  const hasSub = last > first;
  return ALLOWED_CONFIG_KEYS.some((pattern) => {
    const parts = pattern.split(".");
    if (parts[0] !== section) return false;
    if (hasSub !== (parts.length === 3)) return false;
    const want = parts.at(-1);
    return want === "*" || want === name;
  });
};

/** The repo's common git dir, found without running git; `null` when there is none. */
export const gitDirOf = (repoRoot: string): string | null => {
  const dotGit = join(repoRoot, ".git");
  try {
    const stat = lstatSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    const pointer = match?.[1]?.trim();
    if (pointer === undefined || pointer === "") return null;
    const dir = resolve(repoRoot, pointer);
    const common = join(dir, "commondir");
    return existsSync(common) ? resolve(dir, readFileSync(common, "utf8").trim()) : dir;
  } catch {
    return null;
  }
};

const sha = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Git's racy-clean rule: a file changed within this long of when it was read may be rewritten with
 * the same size in the same timestamp tick (1–2 s on HFS+, FAT and some network or overlay file
 * systems), leaving its stat unchanged, so a cached read of it is never trusted.
 */
const RACY_MS = 2_000;

interface FileStamp {
  readonly stamp: string;
  /** The file had not changed for {@link RACY_MS} when it was read: its stamp can be trusted. */
  readonly settled: boolean;
}

const fileStamp = (stat: Stats, readAt: number): FileStamp => ({
  stamp: `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`,
  settled: Math.max(stat.mtimeMs, stat.ctimeMs) < readAt - RACY_MS,
});

/** The cached read is still the file's: same stamp, and that stamp was not racy when read. */
const fresh = (hit: FileStamp, now: FileStamp): boolean => hit.settled && hit.stamp === now.stamp;

/**
 * File hashes, cached on the file's inode, size, mtime and ctime (a write always moves ctime, which
 * no user can set back), except while the file is racily new ({@link RACY_MS}): the fingerprint
 * runs before every engine git call while a role is in flight, so an unchanged hook is not read
 * and hashed again each time (D-cz).
 */
const hashCache = new Map<string, FileStamp & { readonly hash: string }>();

const fingerprintOf = (abs: string): string | undefined => {
  try {
    const readAt = Date.now();
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(abs)}`;
    if (stat.isDirectory()) return undefined;
    const stamp = fileStamp(stat, readAt);
    const hit = hashCache.get(abs);
    if (hit !== undefined && fresh(hit, stamp)) return hit.hash;
    const hash = sha(readFileSync(abs));
    hashCache.set(abs, { ...stamp, hash });
    return hash;
  } catch {
    return undefined;
  }
};

const namesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const filesUnder = (dir: string, depth: number): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const abs = join(dir, name);
    try {
      const stat = lstatSync(abs);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        return depth > 0 ? filesUnder(abs, depth - 1).map((f) => `${name}/${f}`) : [];
    } catch {
      return [];
    }
    return [name];
  });
};

interface ConfigRead extends FileStamp {
  /** `key → values`, in file order; `null` when git could not parse the file. */
  readonly entries: ReadonlyMap<string, readonly string[]> | null;
  readonly raw: string;
}

const configCache = new Map<string, ConfigRead>();

const stampOf = (abs: string): FileStamp | null => {
  try {
    const readAt = Date.now();
    return fileStamp(statSync(abs), readAt);
  } catch {
    return null;
  }
};

/**
 * The entries of one config file (git's parser, no includes), cached on the file's stat; while the
 * file is racily new ({@link RACY_MS}) its bytes are read again and git parses it again only when
 * they changed.
 */
const readConfig = (abs: string): ConfigRead | null => {
  const stamp = stampOf(abs);
  if (stamp === null) return null;
  const hit = configCache.get(abs);
  if (hit !== undefined && fresh(hit, stamp)) return hit;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  if (hit?.raw === raw) {
    const reread: ConfigRead = { ...stamp, entries: hit.entries, raw };
    configCache.set(abs, reread);
    return reread;
  }
  const out = spawnSync("git", ["config", "--file", abs, "--no-includes", "--list", "-z"], {
    env: gitEnv(),
    encoding: "buffer",
    timeout: 10_000,
  });
  let entries: Map<string, string[]> | null = null;
  if (out.status === 0) {
    entries = new Map();
    for (const record of out.stdout.toString("utf8").split("\0")) {
      if (record === "") continue;
      const at = record.indexOf("\n");
      const key = at < 0 ? record : record.slice(0, at);
      const value = at < 0 ? "" : record.slice(at + 1);
      const list = entries.get(key) ?? [];
      list.push(value);
      entries.set(key, list);
    }
  }
  const read: ConfigRead = { ...stamp, entries, raw };
  configCache.set(abs, read);
  return read;
};

/** A path for logs: the home directory as `~` (the log is committed to git). */
const display = (abs: string): string =>
  abs.startsWith(`${homedir()}/`) ? `~${abs.slice(homedir().length)}` : abs;

const expandPath = (value: string, base: string): string =>
  value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : isAbsolute(value)
      ? value
      : resolve(base, value);

/** Held entries of one config file, its includes followed (depth-limited), into `out`. */
const fingerprintConfig = (
  abs: string,
  label: string,
  out: Record<string, string>,
  depth = 0,
): void => {
  const read = readConfig(abs);
  if (read === null) return;
  if (read.entries === null) {
    // git cannot parse it: the whole file is held
    out[label] = sha(read.raw);
    return;
  }
  for (const [key, values] of read.entries) {
    if (isAllowedConfigKey(key)) continue;
    out[`${label}: ${key}`] = sha(values.join("\0"));
    const lower = key.toLowerCase();
    if (depth < 4 && (lower === "include.path" || /^includeif\..+\.path$/.test(lower))) {
      for (const value of values) {
        const target = expandPath(value, dirname(abs));
        out[`${label}: include ${display(target)}`] = fingerprintOf(target) ?? "missing";
        fingerprintConfig(target, `include ${display(target)}`, out, depth + 1);
      }
    }
  }
};

/** The user's global config files git reads (the engine runs git with the user's setup, AD-9). */
export const globalConfigFiles = (): string[] => {
  const explicit = process.env.GIT_CONFIG_GLOBAL;
  if (explicit !== undefined && explicit !== "") return [explicit];
  const xdg = process.env.XDG_CONFIG_HOME;
  return [
    join(xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config"), "git", "config"),
    join(homedir(), ".gitconfig"),
  ];
};

/**
 * Hashes of the held git state (see the module doc), keyed by where it is: `.git/hooks/<f>`,
 * `.git/info/attributes`, `.git/config: <key>`, `~/.gitconfig: <key>`. A missing file has no
 * key; an allow-listed config key never has one.
 */
export const gitConfigFingerprint = (repoRoot: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const dir = gitDirOf(repoRoot);
  if (dir !== null) {
    for (const rel of [
      "info/attributes",
      ...filesUnder(join(dir, "hooks"), 2).map((f) => `hooks/${f}`),
    ].sort()) {
      const hash = fingerprintOf(join(dir, rel));
      if (hash !== undefined) out[`.git/${rel}`] = hash;
    }
    for (const rel of [
      "config",
      "config.worktree",
      ...namesIn(join(dir, "worktrees")).map((name) => `worktrees/${name}/config.worktree`),
    ]) {
      const abs = join(dir, rel);
      try {
        if (lstatSync(abs).isSymbolicLink()) {
          out[`.git/${rel}`] = `symlink:${readlinkSync(abs)}`;
          continue;
        }
      } catch {
        continue;
      }
      fingerprintConfig(abs, `.git/${rel}`, out);
    }
  }
  for (const file of globalConfigFiles()) fingerprintConfig(file, display(file), out);
  return out;
};

/** Keys whose hash differs between two fingerprints (added, removed or changed). */
export const fingerprintChanges = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => before[k] !== after[k])
    .sort();
