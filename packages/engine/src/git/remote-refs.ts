/**
 * The upstream module's `RemoteRefs` seam (AD-13 rule 4, AD-27 rule 1), kept while the module
 * still takes `UpstreamDeps.remoteRefs`: since contracts 5.4.0 `GitPlumbing.fetch` and
 * `GitPlumbing.message` (`createGitPlumbing`) do the work, with the same checks (only the shared
 * automation branches, only into the remote's remote-tracking refs; a commit's message from the
 * object). Remove it once the upstream module reads both from `GitPlumbing`.
 */
import type { GitSha } from "@vtc/shared";
import { createGitPlumbing } from "./plumbing.js";

/** What the upstream module needs besides `GitPlumbing` (`upstream/remote-refs.ts`). */
export interface RemoteRefs {
  /** `git fetch --no-tags --prune <remote> <refspecs…>` into remote-tracking refs only. */
  fetch(remote: string, refspecs: readonly string[]): Promise<void>;
  /** The full message of a commit present locally, or `null`. */
  message(sha: GitSha): Promise<string | null>;
}

/** `git.createRemoteRefs`: {@link RemoteRefs} for one repo directory, over `createGitPlumbing`. */
export const createRemoteRefs = ({ repoRoot }: { readonly repoRoot: string }): RemoteRefs => {
  const plumbing = createGitPlumbing({ repoRoot });
  return {
    fetch: (remote, refspecs) =>
      plumbing.fetch?.(remote, refspecs) ??
      Promise.reject(new Error("createGitPlumbing has no fetch")),
    message: (sha) =>
      plumbing.message?.(sha) ?? Promise.reject(new Error("createGitPlumbing has no message")),
  };
};
