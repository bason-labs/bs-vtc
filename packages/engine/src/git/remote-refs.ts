/**
 * Fresh remote truth for the automation's shared branches (AD-13 rule 4, AD-27 rule 1): the
 * upstream module's `RemoteRefs`, the fetch and commit-message reading the frozen `GitPlumbing`
 * lacks. Every VTC installation reporting to one repo pushes `vtc/auto/<kind>/<fp8>` and
 * `vtc-evidence` without force, so the module fetches them right before it builds on them and
 * recognises another installation's head by its `Generated-by: VTC` trailer. The daemon injects
 * it (`UpstreamDeps.remoteRefs`).
 * - fetch: only those branches, only into the remote's own remote-tracking refs
 *   (`refs/remotes/<remote>/…`), never a local branch, a tag, the index or the work tree; the
 *   user's own git and credentials, no prompt;
 * - message: a commit's full message from the object itself, or `null` when the repo lacks it.
 */
import { GitShaSchema, type GitSha } from "@vtc/shared";
import { gitText, runGit } from "./exec.js";

/** What the upstream module needs besides `GitPlumbing` (`upstream/remote-refs.ts`). */
export interface RemoteRefs {
  /** `git fetch --no-tags --prune <remote> <refspecs…>` into remote-tracking refs only. */
  fetch(remote: string, refspecs: readonly string[]): Promise<void>;
  /** The full message of a commit present locally, or `null`. */
  message(sha: GitSha): Promise<string | null>;
}

/** The shared branches a refspec may name: every automatic branch, one of them, the evidence branch. */
const SHARED_SOURCE = /^refs\/heads\/(vtc\/auto\/\*|vtc\/auto\/[a-z_]+\/[a-f0-9]{8}|vtc-evidence)$/;

/** `[+]refs/heads/<shared>:refs/remotes/<remote>/<same>`, or why not. */
const checkRefspec = (remote: string, refspec: string): string | null => {
  const [src, dst, ...rest] = refspec.replace(/^\+/, "").split(":");
  const branch = SHARED_SOURCE.exec(src ?? "")?.[1];
  if (rest.length > 0 || branch === undefined || dst !== `refs/remotes/${remote}/${branch}`)
    return `the refspec ${JSON.stringify(refspec)} is not a shared automation branch into refs/remotes/${remote}/`;
  return null;
};

/** `git.createRemoteRefs`: {@link RemoteRefs} for one repo directory. */
export const createRemoteRefs = ({ repoRoot }: { readonly repoRoot: string }): RemoteRefs => ({
  fetch: async (remote, refspecs) => {
    const remotes = (await gitText(repoRoot, ["remote"])).split("\n").filter((r) => r !== "");
    if (!remotes.includes(remote)) throw new Error(`${JSON.stringify(remote)} is not a remote`);
    if (refspecs.length === 0) throw new Error("no refspec to fetch");
    for (const refspec of refspecs) {
      const why = checkRefspec(remote, refspec);
      if (why !== null) throw new Error(why);
    }
    await runGit(repoRoot, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--prune",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "--end-of-options",
      remote,
      ...refspecs,
    ]);
  },
  message: async (sha) => {
    if (!GitShaSchema.safeParse(sha).success) return null;
    const result = await runGit(repoRoot, ["cat-file", "commit", sha], { allowFailure: true });
    if (result.code !== 0) return null;
    // the raw object: headers, a blank line, then the message as written
    const raw = result.stdout.toString("utf8");
    const at = raw.indexOf("\n\n");
    return at < 0 ? "" : raw.slice(at + 2);
  },
});
