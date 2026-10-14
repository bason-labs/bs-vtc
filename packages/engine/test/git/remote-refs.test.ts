/**
 * `git.createRemoteRefs` (AD-13 rule 4, AD-27 rule 1): the fetch and commit-message reading the
 * upstream module needs besides the frozen `GitPlumbing` (its `RemoteRefs`), so it builds on the
 * remote's truth for the shared branches (`vtc/auto/*`, `vtc-evidence`) and recognises another
 * installation's commits by their trailer. Against temp repos and a local bare remote; no network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { autoBranchName, EVIDENCE_BRANCH } from "@vtc/shared";
import { createRemoteRefs } from "../../src/git/index.js";
import { addBareRemote, cleanupDirs, git, initRepo, tempDir } from "../helpers/repo.js";

afterEach(cleanupDirs);

const BRANCH = autoBranchName("defect", "0123456789abcdef");
const AUTO_ALL = "+refs/heads/vtc/auto/*:refs/remotes/origin/vtc/auto/*";

/** A repo and a second clone of its remote that pushes the shared branches. */
const setup = () => {
  const repo = initRepo();
  const remote = addBareRemote(repo);
  const other = tempDir("vtc-other-");
  git(other, "clone", "--quiet", remote, ".");
  git(other, "config", "user.email", "other@example.com");
  git(other, "config", "user.name", "Other");
  git(other, "commit", "--quiet", "--allow-empty", "-m", "fix it\n\nGenerated-by: VTC 0.4.0");
  git(other, "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
  git(other, "push", "--quiet", "origin", `HEAD:refs/heads/${EVIDENCE_BRANCH}`);
  return { repo, remote, other, head: git(other, "rev-parse", "HEAD") };
};

const refs = (repo: string): string[] =>
  git(repo, "for-each-ref", "--format=%(refname)")
    .split("\n")
    .filter((r) => r !== "");

describe("git.createRemoteRefs", () => {
  it("fetches the automatic branches and the evidence branch into remote-tracking refs only", async () => {
    const { repo, head } = setup();
    const before = git(repo, "rev-parse", "HEAD");
    const remoteRefs = createRemoteRefs({ repoRoot: repo });
    await remoteRefs.fetch("origin", [AUTO_ALL]);
    expect(git(repo, "rev-parse", `refs/remotes/origin/${BRANCH}`)).toBe(head);
    await remoteRefs.fetch("origin", [
      `+refs/heads/${EVIDENCE_BRANCH}:refs/remotes/origin/${EVIDENCE_BRANCH}`,
    ]);
    expect(git(repo, "rev-parse", `refs/remotes/origin/${EVIDENCE_BRANCH}`)).toBe(head);
    // no local branch, no tag, and the checkout as it was
    expect(refs(repo).filter((r) => r.startsWith("refs/heads/"))).toEqual(["refs/heads/main"]);
    expect(refs(repo).filter((r) => r.startsWith("refs/tags/"))).toEqual([]);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("prunes an automatic branch the remote no longer has", async () => {
    const { repo, other } = setup();
    const remoteRefs = createRemoteRefs({ repoRoot: repo });
    await remoteRefs.fetch("origin", [AUTO_ALL]);
    git(other, "push", "--quiet", "origin", `:refs/heads/${BRANCH}`);
    await remoteRefs.fetch("origin", [AUTO_ALL]);
    expect(refs(repo)).not.toContain(`refs/remotes/origin/${BRANCH}`);
  });

  it("refuses any other refspec, an unknown remote and an option, before git runs", async () => {
    const { repo } = setup();
    const remoteRefs = createRemoteRefs({ repoRoot: repo });
    for (const refspec of [
      "+refs/heads/main:refs/remotes/origin/main",
      `+refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
      `refs/heads/${BRANCH}:refs/remotes/upstream/${BRANCH}`,
      "+refs/heads/vtc/auto/*:refs/remotes/origin/elsewhere/*",
      "--upload-pack=touch /tmp/x",
      `refs/heads/${BRANCH}`,
    ])
      await expect(remoteRefs.fetch("origin", [refspec]), refspec).rejects.toThrow(/refspec/);
    await expect(remoteRefs.fetch("nope", [AUTO_ALL])).rejects.toThrow(/not a remote/);
    await expect(remoteRefs.fetch("--all", [AUTO_ALL])).rejects.toThrow(/not a remote/);
    await expect(remoteRefs.fetch("origin", [])).rejects.toThrow(/no refspec/);
  });

  it("reads a local commit's full message, or null", async () => {
    const { repo, head } = setup();
    const remoteRefs = createRemoteRefs({ repoRoot: repo });
    expect(await remoteRefs.message(head)).toBeNull();
    await remoteRefs.fetch("origin", [AUTO_ALL]);
    expect(await remoteRefs.message(head)).toBe("fix it\n\nGenerated-by: VTC 0.4.0\n");
    expect(await remoteRefs.message("f".repeat(40))).toBeNull();
    expect(await remoteRefs.message("--all")).toBeNull();
  });
});
