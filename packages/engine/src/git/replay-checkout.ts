/**
 * Clean checkouts for Lookback replay trials (AD-21 rule 6, spine §5 reading 176): a standalone
 * repository at the recorded dispatch's base commit, with no refs past it. It is not a worktree of
 * the user's repo (a worktree shares every ref and object, so git in the checkout would list the
 * work that came after its base): the objects reachable from the base are fetched by SHA into a
 * fresh repository whose git directory lives in the engine's private directory, and no ref is
 * ever made in the user's repo. Every engine git call names that directory and the checkout
 * explicitly and, like every engine git call, runs no hook.
 *
 * The checkout's work tree is a fresh private directory (0700) under the OS temp directory
 * ({@link newReplayTree}), outside the user's repo ({@link createReplayCheckout} refuses one
 * inside it): no relative path from the trial reaches the user's current files or their `.git`,
 * and its `.git` file names only the private git directory under the VTC home. Limits, kept
 * honest: the host sandboxes deny no reads, so a trial that knows the repo's absolute path can
 * still read it (an in-session trial runs as a subagent of the Lead's session, whose project is
 * the user's repo); the private git directory and the out-of-repo tree keep git and the paths a
 * role sees from handing it the later work.
 *
 * The `.git` file names that directory, so a role that can write there could plant a config key,
 * an attributes file or a hook that the engine's own `git add` would run: its control files are
 * fingerprinted when the checkout is made ({@link replayGitDirFingerprint}) and checked before
 * every later engine git call on it; a change throws {@link ReplayCheckoutTamperedError} and
 * nothing runs.
 *
 * The trial's work is committed in the checkout (its head); before the Gate Runner grades
 * `base..head` with the user's repo, the head's objects are fetched there by SHA
 * ({@link exposeReplayHead}: objects only, no ref, so git's own gc prunes them once they are old).
 * The grade runs in a clean verification checkout of that head, never in the trial's tree (what a
 * trial leaves ignored there feeds no gate). Then both directories are removed.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { gitText, runGit, withRepoLock } from "./exec.js";

const SHA = /^([a-f0-9]{40}|[a-f0-9]{64})$/;

/** The identity of the engine's trial commits (never the user's). */
const TRIAL_IDENTITY = {
  GIT_AUTHOR_NAME: "VTC Engine",
  GIT_AUTHOR_EMAIL: "vtc@localhost",
  GIT_COMMITTER_NAME: "VTC Engine",
  GIT_COMMITTER_EMAIL: "vtc@localhost",
} as const;

/**
 * A fetch by SHA and nothing else: protocol v2 (whose server hands out any object it holds by
 * SHA, so no ref is needed), no tags, no submodules, no FETCH_HEAD, no maintenance after it.
 */
const FETCH_BY_SHA = [
  "-c",
  "protocol.version=2",
  "fetch",
  "--quiet",
  "--no-tags",
  "--no-recurse-submodules",
  "--no-write-fetch-head",
  "--no-auto-maintenance",
] as const;

export interface ReplayCheckout {
  /** The checkout's work tree: absolute, outside the user's repo ({@link newReplayTree}). */
  readonly tree: string;
  /** The checkout's git directory (absolute, in the engine's private directory). */
  readonly gitDir: string;
  /** The commit it starts from. */
  readonly base: string;
}

/** A replay checkout's git directory changed after the engine made it (see the module doc). */
export class ReplayCheckoutTamperedError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `refusing to run git in the replay checkout: ${paths.length === 0 ? "the fingerprint of its git directory is missing" : `${paths.join(", ")} changed in its git directory`}`.slice(
        0,
        500,
      ),
    );
    this.name = "ReplayCheckoutTamperedError";
  }
}

const args = (checkout: ReplayCheckout): string[] => [
  `--git-dir=${checkout.gitDir}`,
  `--work-tree=${checkout.tree}`,
  // no gc after a commit: it would write under `objects/info` mid-trial
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/** Where the fingerprint taken at creation is kept: beside the git directory, private too. */
const fingerprintFile = (checkout: ReplayCheckout): string => `${checkout.gitDir}.fingerprint`;

/**
 * Entries of a git directory that the engine's own git calls write (objects, refs, the index,
 * logs) and that make git run nothing. Every other entry is fingerprinted: `config`, `hooks/`,
 * `info/`, `commondir`, anything a role adds, and the {@link ALTERNATES} inside `objects/`.
 */
const DATA_ENTRIES = new Set([
  "HEAD",
  "ORIG_HEAD",
  "FETCH_HEAD",
  "COMMIT_EDITMSG",
  "index",
  "packed-refs",
  "logs",
  "refs",
  "gc.pid",
  "gc.log",
]);

/** The files under `objects/` that point git at other object stores. */
const ALTERNATES = ["objects/info/alternates", "objects/info/http-alternates"] as const;

const lstatExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const isData = (rel: string): boolean =>
  rel.endsWith(".lock") || DATA_ENTRIES.has(rel) || rel === "objects";

const digestOf = (path: string): string => {
  const stat = lstatSync(path);
  const hash = createHash("sha256");
  if (stat.isSymbolicLink()) hash.update(`link\0${readlinkSync(path)}`);
  else if (stat.isFile()) hash.update("file\0").update(readFileSync(path));
  else hash.update(`other\0${String(stat.mode)}`);
  return hash.digest("hex");
};

/**
 * The control files of a replay checkout's git directory, path → digest of their type and bytes
 * (a symlink by its target, a directory by its presence): what can make git run code or read
 * elsewhere.
 */
export const replayGitDirFingerprint = (gitDir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(rel === "" ? gitDir : join(gitDir, rel));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const child = rel === "" ? name : `${rel}/${name}`;
      if (isData(child)) continue;
      const path = join(gitDir, child);
      if (lstatSync(path).isDirectory()) {
        out[`${child}/`] = "dir";
        walk(child);
      } else out[child] = digestOf(path);
    }
  };
  walk("");
  for (const rel of ALTERNATES) {
    const path = join(gitDir, rel);
    if (lstatExists(path)) out[rel] = digestOf(path);
  }
  return out;
};

/**
 * Checks the checkout's git directory against the fingerprint taken when it was made; throws
 * {@link ReplayCheckoutTamperedError} naming what changed (or saying the fingerprint is missing).
 */
export const assertReplayCheckoutIntact = (checkout: ReplayCheckout): void => {
  let kept: Record<string, string>;
  try {
    kept = JSON.parse(readFileSync(fingerprintFile(checkout), "utf8")) as Record<string, string>;
  } catch {
    throw new ReplayCheckoutTamperedError([]);
  }
  const now = replayGitDirFingerprint(checkout.gitDir);
  const changed = [...new Set([...Object.keys(kept), ...Object.keys(now)])]
    .filter((path) => kept[path] !== now[path])
    .sort();
  if (changed.length > 0) throw new ReplayCheckoutTamperedError(changed.slice(0, 20));
};

/**
 * A fresh, empty private directory (0700, its name random) under the OS temp directory, for a
 * trial's work tree: outside every user's repo, and never a path another user could have made
 * first. Returned with symlinks resolved, as the role and the write-scope hook see it.
 */
export const newReplayTree = (): string => realpathSync(mkdtempSync(join(tmpdir(), "vtc-replay-")));

/** True when `path` is `root` or lies under it. */
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Creates the checkout at `base` in its work tree, which must be an empty directory outside the
 * user's repo ({@link newReplayTree}); a leftover git directory at the same path is replaced. The
 * base must be a commit of the user's repo; it is fetched by SHA, so the user's repo gets no ref.
 */
export const createReplayCheckout = async (
  repoRoot: string,
  checkout: ReplayCheckout,
): Promise<void> => {
  if (!SHA.test(checkout.base))
    throw new TypeError(`expected a full git sha, got ${checkout.base}`);
  const { tree } = checkout;
  if (!isAbsolute(tree)) throw new TypeError(`expected an absolute work tree, got ${tree}`);
  if (within(realpathSync(repoRoot), realpathSync(tree)) || within(repoRoot, tree))
    throw new TypeError(`a replay checkout never sits in the user's repo: ${tree}`);
  if (!lstatSync(tree).isDirectory() || readdirSync(tree).length > 0)
    throw new TypeError(`a replay checkout needs an empty directory of its own: ${tree}`);
  rmSync(checkout.gitDir, { recursive: true, force: true });
  rmSync(fingerprintFile(checkout), { force: true });
  mkdirSync(dirname(checkout.gitDir), { recursive: true, mode: 0o700 });
  await runGit(tree, ["init", "--quiet", `--separate-git-dir=${checkout.gitDir}`, tree]);
  await runGit(tree, [...args(checkout), ...FETCH_BY_SHA, repoRoot, checkout.base], {
    timeoutMs: 600_000,
  });
  await runGit(tree, [...args(checkout), "checkout", "--quiet", "--detach", checkout.base]);
  writeFileSync(
    fingerprintFile(checkout),
    `${JSON.stringify(replayGitDirFingerprint(checkout.gitDir))}\n`,
    { mode: 0o600 },
  );
};

/** Commits what the trial left in the checkout; its head (the base when it changed nothing). */
export const snapshotReplayCheckout = async (
  checkout: ReplayCheckout,
  message: string,
): Promise<string> => {
  const { tree } = checkout;
  const git = args(checkout);
  // `add` runs the clean filters the git directory names: never one a role planted there
  assertReplayCheckoutIntact(checkout);
  await runGit(tree, [...git, "add", "--all"]);
  const staged = await runGit(tree, [...git, "diff", "--cached", "--quiet"], {
    allowFailure: true,
  });
  if (staged.code !== 0)
    await runGit(
      tree,
      [...git, "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", message],
      {
        env: TRIAL_IDENTITY,
      },
    );
  return gitText(tree, [...git, "rev-parse", "HEAD"]);
};

/**
 * Makes a trial's head readable to git in the user's repo, so the Gate Runner (whose `GitOps`
 * reads the user's repo) can diff `base..head` and check the head out: its objects are fetched by
 * SHA from the checkout's git directory, with no ref. A head that is the base needs nothing.
 */
export const exposeReplayHead = async (
  repoRoot: string,
  checkout: ReplayCheckout,
  head: string,
): Promise<void> => {
  if (!SHA.test(head)) throw new TypeError(`expected a full git sha, got ${head}`);
  if (head === checkout.base) return;
  // the fetch runs git's upload-pack in the checkout's git directory
  assertReplayCheckoutIntact(checkout);
  await withRepoLock(repoRoot, () =>
    runGit(repoRoot, [...FETCH_BY_SHA, checkout.gitDir, head], { timeoutMs: 600_000 }),
  );
  const type = await gitText(repoRoot, ["cat-file", "-t", head]);
  if (type !== "commit") throw new Error(`the trial head ${head.slice(0, 12)} is not a commit`);
};

/** Removes the checkout and its git directory (best effort; a missing one is fine). */
export const removeReplayCheckout = (checkout: ReplayCheckout): void => {
  const { tree } = checkout;
  if (existsSync(tree)) rmSync(tree, { recursive: true, force: true });
  if (existsSync(checkout.gitDir)) rmSync(checkout.gitDir, { recursive: true, force: true });
  rmSync(fingerprintFile(checkout), { force: true });
};
