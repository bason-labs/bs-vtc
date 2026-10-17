/**
 * `vtc update`: replaces this `vtc` with the newest release of the private product repo
 * (`RELEASE_REPO`). Everything goes through the owner's own `gh` login (`gh release list`,
 * `gh release download`, `gh release view`); no token is read. A release is used only when its
 * archive matches its `SHA256SUMS` line and its binary answers `vtc version` with the expected
 * version. Engines stop only once no role run (a child of the engine: `codex exec`, a headless
 * Claude run, a gate) is in flight, through the same stop as `vtc engine --stop`. The current
 * binary is kept as `<dir>/.vtc-<old>.bak`, the new one renamed over it (atomic on one file
 * system), and the host plugins already installed are installed again by the new binary: Claude
 * Code once for the user, Codex in every repo that has VTC's Codex skills (`PROJECTS_FILE`
 * remembers them, `vtc install codex` adds each one).
 *
 * Windows is not covered: a running `vtc.exe` cannot be replaced in place, so `vtc update` there
 * only reports the newest release.
 */
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ENGINE_INSTANCE, EngineDiscoverySchema, type EngineDiscovery } from "@vtc/shared";
import type { Exec } from "./process.js";

/** Where VTC's releases are published (H-16: the private repository's GitHub Releases only). */
export const RELEASE_REPO = "bason-labs/bs-vtc";
/** The daily update check's cache, under the VTC home. */
export const UPDATE_CHECK_FILE = "update-check.json";
/** Repos with a project-scope Codex install, under the VTC home. */
export const PROJECTS_FILE = "projects.json";
/** How often `vtc doctor` asks GitHub for a newer release. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60_000;
/** The file `vtc install codex` puts in every skill it places (the Codex install marker). */
const CODEX_SKILL_MARK = join(".agents", "skills", "vtc-lead", ".vtc-generated");

// ------------------------------------------------------------------------------- versions

type Triple = readonly [number, number, number];

/** `v0.2.4` or `0.2.4` as numbers; `null` for anything else (a prerelease suffix, a typo). */
export const parseVersion = (text: string): Triple | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export const compareVersions = (a: Triple, b: Triple): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const show = (v: Triple): string => v.join(".");

/** The release archive's platform part (`release.yml`), or `null` where VTC ships no binary. */
export const releaseTarget = (platform: NodeJS.Platform, arch: string): string | null => {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (os === null || cpu === null || (os === "windows" && cpu !== "x64")) return null;
  return `${os}-${cpu}`;
};

/** `vtc-<version>-<target>.tar.gz` (`.zip` on Windows), as `release.yml` names it. */
export const archiveName = (version: string, target: string): string =>
  `vtc-${version}-${target}${target.startsWith("windows") ? ".zip" : ".tar.gz"}`;

// -------------------------------------------------------------------------------- releases

export interface Release {
  readonly tag: string;
  readonly version: Triple;
}

const ghFailure = (what: string, result: Awaited<ReturnType<Exec>>): Error =>
  new Error(
    `${what} failed: ${(result.stderr.trim() || result.error) ?? `exit ${String(result.code)}`}${result.error === "ENOENT" ? " (is the GitHub CLI gh installed?)" : ""}`,
  );

/**
 * Every published release (drafts left out, prereleases kept: VTC's releases are prereleases),
 * newest first by version.
 */
export const listReleases = async (exec: Exec, timeoutMs = 30_000): Promise<Release[]> => {
  const result = await exec(
    "gh",
    [
      "release",
      "list",
      "--repo",
      RELEASE_REPO,
      "--exclude-drafts",
      "--limit",
      "100",
      "--json",
      "tagName",
    ],
    { timeoutMs },
  );
  if (result.code !== 0) throw ghFailure("gh release list", result);
  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    throw new Error("gh release list did not answer JSON");
  }
  if (!Array.isArray(rows)) throw new Error("gh release list did not answer a list");
  const releases: Release[] = [];
  for (const row of rows) {
    const tag = (row as { tagName?: unknown } | null)?.tagName;
    if (typeof tag !== "string") continue;
    const version = parseVersion(tag);
    if (version !== null) releases.push({ tag, version });
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version));
};

/** A release's notes (its CHANGELOG section, H-16); `null` when gh cannot give them. */
export const releaseNotes = async (exec: Exec, tag: string): Promise<string | null> => {
  const result = await exec(
    "gh",
    ["release", "view", tag, "--repo", RELEASE_REPO, "--json", "body", "--jq", ".body"],
    { timeoutMs: 30_000 },
  );
  return result.code === 0 ? result.stdout.trim() : null;
};

/** The sha-256 `SHA256SUMS` gives `name` (`<hex>  <name>` or `<hex> *<name>`), or `null`. */
export const expectedSum = (sums: string, name: string): string | null => {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m?.[2] === name) return (m[1] ?? "").toLowerCase();
  }
  return null;
};

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Downloads `release`'s archive for `target` and `SHA256SUMS` into `dir`, checks the archive
 * against its sum and unpacks it. Resolves the new binary's path; throws on any mismatch.
 */
export const fetchRelease = async (
  exec: Exec,
  release: Release,
  target: string,
  dir: string,
): Promise<string> => {
  const archive = archiveName(show(release.version), target);
  const download = await exec(
    "gh",
    [
      "release",
      "download",
      release.tag,
      "--repo",
      RELEASE_REPO,
      "--pattern",
      archive,
      "--pattern",
      "SHA256SUMS",
      "--dir",
      dir,
      "--clobber",
    ],
    { timeoutMs: 10 * 60_000 },
  );
  if (download.code !== 0) throw ghFailure("gh release download", download);
  const archivePath = join(dir, archive);
  const sumsPath = join(dir, "SHA256SUMS");
  if (!existsSync(archivePath) || !existsSync(sumsPath))
    throw new Error(`release ${release.tag} has no ${archive} or no SHA256SUMS`);
  const expected = expectedSum(readFileSync(sumsPath, "utf8"), archive);
  if (expected === null) throw new Error(`SHA256SUMS of ${release.tag} does not list ${archive}`);
  const actual = sha256File(archivePath);
  if (actual !== expected)
    throw new Error(
      `${archive} does not match SHA256SUMS (expected ${expected}, got ${actual}); nothing was changed`,
    );
  const unpacked = join(dir, "unpacked");
  mkdirSync(unpacked);
  const tar = await exec("tar", ["-xzf", archivePath, "-C", unpacked], { timeoutMs: 120_000 });
  if (tar.code !== 0) throw ghFailure(`unpacking ${archive}`, tar);
  const binary = join(unpacked, "vtc");
  if (!existsSync(binary)) throw new Error(`${archive} holds no vtc binary`);
  chmodSync(binary, 0o755);
  return binary;
};

/** Runs the new binary's `vtc version`; throws unless it names `version`. */
export const checkNewBinary = async (
  exec: Exec,
  binary: string,
  version: string,
): Promise<string> => {
  const result = await exec(binary, ["version"], { timeoutMs: 30_000 });
  const line = result.stdout.trim().split("\n")[0] ?? "";
  if (result.code !== 0 || !line.startsWith(`vtc ${version} `))
    throw new Error(
      `the downloaded vtc does not run as vtc ${version} (${line || result.stderr.trim() || result.error || `exit ${String(result.code)}`}); nothing was changed`,
    );
  return line;
};

// --------------------------------------------------------------------------------- engines

/** Every engine discovery record under the VTC home (live or stale; the stop probes each). */
export const engineRecords = (vtcHome: string): EngineDiscovery[] => {
  const dir = join(vtcHome, ENGINE_INSTANCE.discoveryDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const records: EngineDiscovery[] = [];
  for (const name of names) {
    try {
      const parsed = EngineDiscoverySchema.safeParse(
        JSON.parse(readFileSync(join(dir, name), "utf8")),
      );
      if (parsed.success) records.push(parsed.data);
    } catch {
      // a record being rewritten or removed: skipped
    }
  }
  return records;
};

export interface ChildProcessInfo {
  readonly pid: number;
  readonly command: string;
}

/**
 * The processes below `rootPid` (`ps -A -o pid=,ppid=,command=`): an engine's role runs, gates
 * and scans. `null` when `ps` cannot tell (then nobody can say the engine is idle).
 */
export const descendantsOf = async (
  exec: Exec,
  rootPid: number,
): Promise<ChildProcessInfo[] | null> => {
  const result = await exec("ps", ["-A", "-o", "pid=,ppid=,command="], { timeoutMs: 15_000 });
  if (result.code !== 0) return null;
  const children = new Map<number, { pid: number; command: string }[]>();
  for (const line of result.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid) ?? [];
    list.push({ pid, command: (m[3] ?? "").trim() });
    children.set(ppid, list);
  }
  const found: ChildProcessInfo[] = [];
  const queue = [rootPid];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const next = queue.shift() ?? rootPid;
    for (const child of children.get(next) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
};

/**
 * The host a role run below an engine belongs to (`codex exec …`, `claude -p …`), or `null` for
 * anything else an engine keeps running (Codex's `app-server` for usage readings, a gate).
 */
export const roleRunHost = (command: string): "codex" | "claude-code" | null => {
  if (/(^|\/)codex(\.js)?\s+exec(\s|$)/.test(command)) return "codex";
  if (/(^|\/)claude(\.js)?\s(.*\s)?(-p|--print)(\s|$)/.test(command)) return "claude-code";
  return null;
};

/** The role runs below `rootPid`: {@link descendantsOf} narrowed to {@link roleRunHost}. */
export const roleRunsUnder = async (
  exec: Exec,
  rootPid: number,
): Promise<ChildProcessInfo[] | null> => {
  const all = await descendantsOf(exec, rootPid);
  return all === null ? null : all.filter((c) => roleRunHost(c.command) !== null);
};

// ------------------------------------------------------------------------- installed hosts

/** True when `vtc install claude-code` placed its marketplace under the VTC home. */
export const claudeCodeInstalled = (vtcHome: string): boolean =>
  existsSync(join(vtcHome, "claude-marketplace"));

/** True when `repoRoot` has VTC's project-scope Codex skills. */
export const codexInstalledIn = (repoRoot: string): boolean =>
  existsSync(join(repoRoot, CODEX_SKILL_MARK));

/** The repos `vtc install codex` recorded (missing or unreadable file: none). */
export const readProjects = (vtcHome: string): string[] => {
  try {
    const raw = JSON.parse(readFileSync(join(vtcHome, PROJECTS_FILE), "utf8")) as {
      codex?: unknown;
    };
    return Array.isArray(raw.codex)
      ? raw.codex.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
};

/** Records `repoRoot` as a repo with a Codex install, so `vtc update` refreshes it. */
export const rememberCodexProject = (vtcHome: string, repoRoot: string): void => {
  const known = readProjects(vtcHome);
  if (known.includes(repoRoot)) return;
  mkdirSync(vtcHome, { recursive: true });
  writeFileSync(
    join(vtcHome, PROJECTS_FILE),
    `${JSON.stringify({ v: 1, codex: [...known, repoRoot].sort() }, null, 2)}\n`,
    { mode: 0o600 },
  );
};

// ------------------------------------------------------------------------------ the binary

/** Why `execPath` cannot be replaced in place, or `null` when it can. */
export const replaceProblem = (execPath: string): string | null => {
  try {
    accessSync(dirname(execPath), constants.W_OK);
    accessSync(execPath, constants.W_OK);
    return null;
  } catch {
    return `${execPath} (or its folder) is not writable by you`;
  }
};

/**
 * Keeps the current binary as `<dir>/.vtc-<old>.bak` and renames the new one over it (staged in
 * the same folder first, so the rename never crosses file systems). Resolves the backup's path.
 */
export const replaceBinary = (execPath: string, newBinary: string, oldVersion: string): string => {
  const dir = dirname(execPath);
  const backup = join(dir, `.vtc-${oldVersion}.bak`);
  copyFileSync(execPath, backup);
  chmodSync(backup, 0o755);
  const staged = join(dir, `.vtc-update-${String(process.pid)}`);
  copyFileSync(newBinary, staged);
  chmodSync(staged, 0o755);
  renameSync(staged, execPath);
  return backup;
};

// ---------------------------------------------------------------------- the daily check

interface CachedCheck {
  readonly checked_at: string;
  readonly latest: string | null;
}

const readCache = (vtcHome: string): CachedCheck | null => {
  try {
    const raw = JSON.parse(readFileSync(join(vtcHome, UPDATE_CHECK_FILE), "utf8")) as {
      checked_at?: unknown;
      latest?: unknown;
    };
    if (typeof raw.checked_at !== "string") return null;
    return {
      checked_at: raw.checked_at,
      latest: typeof raw.latest === "string" ? raw.latest : null,
    };
  } catch {
    return null;
  }
};

/**
 * For `vtc doctor`: the newest release when it is newer than `current`, else `null`. Asks GitHub
 * at most once a day (cached in {@link UPDATE_CHECK_FILE}); offline, without `gh` or on any
 * error it answers `null`, so doctor never fails for it.
 */
export const availableUpdate = async (options: {
  readonly exec: Exec;
  readonly vtcHome: string;
  readonly current: string;
  readonly now: () => Date;
}): Promise<string | null> => {
  const current = parseVersion(options.current);
  if (current === null) return null;
  let latest: string | null;
  const cached = readCache(options.vtcHome);
  const age = cached === null ? Infinity : options.now().getTime() - Date.parse(cached.checked_at);
  if (cached !== null && age >= 0 && age < UPDATE_CHECK_TTL_MS) latest = cached.latest;
  else {
    try {
      const newest = (await listReleases(options.exec, 8_000))[0];
      latest = newest === undefined ? null : show(newest.version);
    } catch {
      return null;
    }
    try {
      mkdirSync(options.vtcHome, { recursive: true });
      writeFileSync(
        join(options.vtcHome, UPDATE_CHECK_FILE),
        `${JSON.stringify({ checked_at: options.now().toISOString(), latest })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // the next doctor asks again
    }
  }
  const parsed = latest === null ? null : parseVersion(latest);
  return parsed !== null && compareVersions(parsed, current) > 0 ? show(parsed) : null;
};
