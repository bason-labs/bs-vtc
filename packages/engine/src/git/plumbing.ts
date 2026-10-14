/**
 * Local git plumbing for automatic issues and PRs (`GitPlumbing`, AD-13 rule 4, AD-27 rule 1;
 * contracts 5.0.0). The upstream module writes the orphan evidence branch and the automatic
 * branches through it, so git code stays in `git/`:
 * - objects and refs only: a commit is built in a temporary index (`GIT_INDEX_FILE` in a private
 *   temp directory), never in the repo's index or work tree, so the user's uncommitted and staged
 *   work is untouched;
 * - the user's own git, identity, credentials and signing configuration (no `commit.gpgsign`
 *   override, `GitRunOptions.userSigning`), in the engine's clean git environment, with the
 *   user's pre-push hook;
 * - refs: only the automatic branches and the evidence branch (`autoPushRefAllowed`), locally and
 *   on the remote; a local update names the value it expects; a push is never forced (no `+`, no
 *   `--force`) and is refused when its destination is the remote's default branch, or when the
 *   remote names none (the first branch pushed to an empty repo would become its default).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoPushRefAllowed,
  GitShaSchema,
  RelPathSchema,
  type CreateGitPlumbing,
  type GitPlumbing,
  type GitSha,
  type PlumbingChange,
} from "@vtc/shared";
import { gitText, runGit, type GitRunOptions } from "./exec.js";

/** Why a plumbing call was refused before git ran. */
export class GitPlumbingRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitPlumbingRefusedError";
  }
}

const refuse = (message: string): never => {
  throw new GitPlumbingRefusedError(message);
};

const sha = (value: string, what: string): GitSha => {
  const parsed = GitShaSchema.safeParse(value);
  return parsed.success ? parsed.data : refuse(`${what} is not a full git object id`);
};

/** A tree path of a change: repo-relative, no empty, `.` or `..` segment, nothing under `.git`. */
const treePath = (path: string): string => {
  if (!RelPathSchema.safeParse(path).success) refuse(`${JSON.stringify(path)} is not a tree path`);
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s.toLowerCase() === ".git"))
    refuse(`${JSON.stringify(path)} is not a tree path`);
  return path;
};

/** A local or remote ref the plumbing may write: an automatic branch or the evidence branch. */
const writableRef = (ref: string, verb: string): string =>
  autoPushRefAllowed(ref)
    ? ref
    : refuse(
        `the automation plumbing may not ${verb} ${JSON.stringify(ref)}: only refs/heads/vtc/auto/<kind>/<fp8> and refs/heads/vtc-evidence`,
      );

const USER = { userSigning: true } as const satisfies GitRunOptions;

/** `git.createGitPlumbing`: the frozen `CreateGitPlumbing` seam for one repo directory. */
export const createGitPlumbing: CreateGitPlumbing = ({ repoRoot }): GitPlumbing => {
  const git = (args: readonly string[], options: GitRunOptions = {}) =>
    runGit(repoRoot, args, { ...USER, ...options });
  const text = (args: readonly string[], options: GitRunOptions = {}) =>
    gitText(repoRoot, args, { ...USER, ...options });

  const resolve = async (ref: string): Promise<GitSha | null> => {
    if (ref.startsWith("-") || ref.includes("\0")) return null;
    const result = await git(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      {
        allowFailure: true,
      },
    );
    if (result.code !== 0) return null;
    const out = result.stdout.toString("utf8").trim();
    return GitShaSchema.safeParse(out).success ? out : null;
  };

  const isCommit = async (value: GitSha): Promise<boolean> =>
    (await git(["cat-file", "-e", `${value}^{commit}`], { allowFailure: true })).code === 0;

  const commit: GitPlumbing["commit"] = async (request) => {
    const base = request.base === null ? null : sha(request.base, "base");
    const parents = request.parents.map((p) => sha(p, "a parent"));
    const changes: readonly PlumbingChange[] = request.changes.map((c) => ({
      path: treePath(c.path),
      bytes: c.bytes,
    }));
    const work = mkdtempSync(join(tmpdir(), "vtc-plumbing-"));
    try {
      const index = { env: { GIT_INDEX_FILE: join(work, "index") } };
      await git(base === null ? ["read-tree", "--empty"] : ["read-tree", base], index);
      const added: string[] = [];
      const removed: string[] = [];
      for (const [n, change] of changes.entries()) {
        if (change.bytes === null) {
          removed.push(change.path);
          continue;
        }
        const blobFile = join(work, `blob-${String(n)}`);
        writeFileSync(blobFile, change.bytes, { mode: 0o600 });
        // --no-filters: the bytes as given, never through a clean filter the config names
        const blob = await text(["hash-object", "-w", "--no-filters", "--", blobFile]);
        added.push("--cacheinfo", `100644,${sha(blob, "a blob")},${change.path}`);
      }
      if (removed.length > 0)
        await git(["update-index", "--force-remove", "--", ...removed], index);
      if (added.length > 0) await git(["update-index", "--add", "--replace", ...added], index);
      const tree = sha(await text(["write-tree"], index), "the tree");
      const messageFile = join(work, "message");
      writeFileSync(messageFile, request.message, { mode: 0o600 });
      // commit-tree, as plumbing, ignores commit.gpgsign: the user's own setting decides here
      const signed = await text([
        "config",
        "--type=bool",
        "--default=false",
        "--get",
        "commit.gpgsign",
      ]);
      const out = await text([
        "commit-tree",
        ...(signed === "true" ? ["-S"] : []),
        tree,
        ...parents.flatMap((p) => ["-p", p]),
        "-F",
        messageFile,
      ]);
      return sha(out, "the commit");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  const updateRef: GitPlumbing["updateRef"] = async (ref, value, expected) => {
    writableRef(ref, "update");
    const next = sha(value, "the new value");
    const old = expected === null ? "" : sha(expected, "the expected value");
    if (!(await isCommit(next))) refuse(`${next} is not a commit in this repo`);
    const current = await git(["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
    if (current.code === 0 && current.stdout.toString("utf8").trim() === ref)
      refuse(
        `${ref} is checked out here; the automation plumbing never moves a checked-out branch`,
      );
    // nor one a linked worktree of this repo has checked out (its index and files would lag)
    const worktrees = (await text(["worktree", "list", "--porcelain"])).split("\n");
    if (worktrees.includes(`branch ${ref}`))
      refuse(
        `${ref} is checked out in a worktree of this repo; the automation plumbing never moves a checked-out branch`,
      );
    await git(["update-ref", "-m", "vtc: automation", ref, next, old]);
  };

  /** The remote's default branch (`refs/heads/<name>`), or `null` when it names none. */
  const remoteDefault = async (remote: string): Promise<string | null> => {
    const out = await text(["ls-remote", "--symref", remote, "HEAD"]);
    const match = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(out);
    return match?.[1] ?? null;
  };

  const push: GitPlumbing["push"] = async (remote, value, dst) => {
    writableRef(dst, "push to");
    const remotes = (await text(["remote"])).split("\n").filter((r) => r !== "");
    if (!remotes.includes(remote)) refuse(`${JSON.stringify(remote)} is not a remote of this repo`);
    const next = sha(value, "the pushed commit");
    if (!(await isCommit(next))) refuse(`${next} is not a commit in this repo`);
    const main = await remoteDefault(remote);
    if (main === null)
      refuse(
        `${remote} names no default branch, so a push could make ${dst} its default branch; the automation never pushes there`,
      );
    if (main === dst)
      refuse(`${dst} is the default branch of ${remote}; the automation never pushes there`);
    // no `+`, no --force: a remote branch that moved past VTC's last push is never overwritten
    await git(["push", "--", remote, `${next}:${dst}`], { hooks: true });
  };

  return { resolve, commit, updateRef, push };
};
