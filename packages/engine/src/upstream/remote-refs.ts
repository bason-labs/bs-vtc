/**
 * Fresh remote truth for the two shared branches VTC pushes without force: the `vtc-evidence`
 * branch and `vtc/auto/<kind>/<fp8>`. Every VTC installation reporting to bs-vtc pushes to them,
 * so a checkout must fetch right before it builds a commit on them, or its push is a
 * non-fast-forward. Contracts 5.4.0 adds `fetch` and `message` to `GitPlumbing` (optional); the
 * module uses the plumbing's own when it has both, and the daemon's `UpstreamDeps.remoteRefs`
 * (engine git, the user's own git and credentials) until engine core's plumbing implements them,
 * when this seam goes.
 */
import type { GitSha } from "@vtc/shared";

/** `GitPlumbing.fetch` / `message` as one seam (the plumbing's own, or the daemon's fallback). */
export interface RemoteRefs {
  /**
   * `git fetch --no-tags --prune <remote> <refspecs…>` in the repo: updates only the
   * remote-tracking refs the refspecs name (and prunes those the remote no longer has), never a
   * local branch, the index or the work tree. Rejects when git fails (e.g. a refspec whose source
   * the remote lacks), which callers treat as "nothing new".
   */
  fetch(remote: string, refspecs: readonly string[]): Promise<void>;
  /** The full message of a commit present locally, or `null`. */
  message(sha: GitSha): Promise<string | null>;
}

/** Every automatic branch, so a branch another installation pushed (or a human left) is seen. */
export const AUTO_BRANCHES_REFSPEC = "+refs/heads/vtc/auto/*:refs/remotes/origin/vtc/auto/*";

/** Pure: the refspec that refreshes `refs/remotes/<remote>/<branch>` from the remote's branch. */
export const trackingRefspec = (remote: string, branch: string): string =>
  `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;

/**
 * Fetches `refspecs` when the seam is wired. A failed fetch is not an error here: the push that
 * follows is the remote truth, and it is refused (never forced) when the refs were stale.
 */
export const refreshRemote = async (
  refs: RemoteRefs | undefined,
  remote: string,
  refspecs: readonly string[],
): Promise<void> => {
  if (refs === undefined) return;
  try {
    await refs.fetch(remote, refspecs);
  } catch {
    // Nothing new; the non-forced push decides.
  }
};

/** The trailer every commit VTC builds on an automatic branch carries (any installation). */
const VTC_TRAILER = /^Generated-by: VTC(?: \S+)?$/m;

/** Pure: whether a commit message carries VTC's `Generated-by: VTC <version>` trailer. */
export const hasVtcTrailer = (message: string): boolean => VTC_TRAILER.test(message);

/**
 * Whether `sha` is a commit some VTC installation built (its trailer); `false` when the seam is
 * not wired or the commit is not present locally.
 */
export const vtcAuthored = async (refs: RemoteRefs | undefined, sha: GitSha): Promise<boolean> => {
  if (refs === undefined) return false;
  const message = await refs.message(sha).catch(() => null);
  return message !== null && hasVtcTrailer(message);
};
