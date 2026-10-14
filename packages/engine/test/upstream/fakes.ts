/**
 * In-memory fakes for the upstream tests (D-cc): GitHub (issues and PRs), git plumbing, the
 * evidence recorder and the asset bundle. Nothing here runs `gh`, `git push` or a browser. The
 * plumbing keeps a fake remote that refuses non-fast-forward pushes, and the fake GitHub can read
 * PR heads from it, so a PR's head is what was last pushed to its branch.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_COMMENT_MARKER,
  parseAutoMarker,
  type AssetBundle,
  type AssetNamespace,
  type AutoIssueRef,
  type AutoIssueRequest,
  type AutoPrRef,
  type AutoPullRequestService,
  type EvidenceCaptureRequest,
  type EvidenceCaptureResult,
  type EvidenceRecorder,
  type GitPlumbing,
  type IssueService,
  type PlumbingChange,
} from "@vtc/shared";
import {
  QUIET_CLOSE_MARKER,
  type RemoteIssueRef,
  type RemoteRefs,
} from "../../src/upstream/index.js";

const TEMPLATES = join(import.meta.dirname, "fixtures", "templates");

/** A bundle with the test templates under `plugin:claude-code` and `files` in `dashboard`. */
export const fakeAssets = (
  dashboard: Record<string, string> = { "index.html": "<html>dashboard</html>" },
): AssetBundle => {
  const plugin: Record<string, Uint8Array> = {};
  for (const name of ["auto-issue", "auto-pr", "changelog-entry"]) {
    plugin[`vtc/templates/${name}.md`] = readFileSync(join(TEMPLATES, `${name}.md`));
  }
  const dash = Object.fromEntries(
    Object.entries(dashboard).map(([k, v]) => [k, new TextEncoder().encode(v)]),
  );
  const ns = (namespace: AssetNamespace): Record<string, Uint8Array> =>
    namespace === "dashboard" ? dash : namespace === "plugin:claude-code" ? plugin : {};
  return {
    read: (namespace, path) => ns(namespace)[path],
    list: (namespace) => Object.keys(ns(namespace)).sort(),
  };
};

export interface MemoryIssue extends AutoIssueRef {
  readonly createdAt: string;
  readonly title: string;
  readonly body: string;
  readonly comments: readonly string[];
  readonly repo: string;
}

export interface MemoryPr extends AutoPrRef {
  readonly title: string;
  readonly body: string;
  readonly base: string;
  readonly repo: string;
  readonly attached: readonly string[];
  readonly comments: readonly string[];
  readonly branchDeleted: boolean;
}

export interface MemoryGitHub {
  readonly issues: IssueService;
  readonly pullRequests: AutoPullRequestService;
  readonly state: { issues: MemoryIssue[]; prs: MemoryPr[]; log: string[] };
  /** A human closes `number` with `reason`, or labels it. */
  human(
    number: number,
    change: { close?: "completed" | "not_planned"; label?: string; comment?: string },
  ): void;
}

const read = (request: AutoIssueRequest): string =>
  readFileSync(join(request.stagingDir, request.bodyFile), "utf8");

/** What the gh-backed listing adds: VTC's quiet close is its last comment's marker. */
const remoteFacts = (issue: MemoryIssue): RemoteIssueRef => ({
  ...issue,
  closedQuietByVtc:
    issue.state === "closed" &&
    issue.stateReason === "not_planned" &&
    issue.comments.at(-1)?.includes(QUIET_CLOSE_MARKER) === true,
});

export const memoryGitHub = (
  options: {
    /** The fake remote's refs (`refs/heads/<branch>` → sha): PR heads are read from it. */
    remote?: Map<string, string>;
    /** The clock `createdAt` is stamped with. */
    now?: () => Date;
  } = {},
): MemoryGitHub => {
  const state = { issues: [] as MemoryIssue[], prs: [] as MemoryPr[], log: [] as string[] };
  let next = 1;
  const now = (): string => (options.now?.() ?? new Date()).toISOString();
  const head = (pr: MemoryPr): MemoryPr => {
    const sha = options.remote?.get(`refs/heads/${pr.headRefName}`);
    return sha === undefined ? pr : { ...pr, headSha: sha };
  };
  const findIssue = (repo: string, number: number): MemoryIssue => {
    const issue = state.issues.find((i) => i.repo === repo && i.number === number);
    if (issue === undefined) throw new Error(`no issue ${String(number)}`);
    return issue;
  };
  const replaceIssue = (issue: MemoryIssue, change: Partial<MemoryIssue>): MemoryIssue => {
    const updated = { ...issue, ...change, updatedAt: now() };
    state.issues = state.issues.map((i) => (i === issue ? updated : i));
    return updated;
  };
  const findPr = (repo: string, number: number): MemoryPr => {
    const pr = state.prs.find((p) => p.repo === repo && p.number === number);
    if (pr === undefined) throw new Error(`no pr ${String(number)}`);
    return pr;
  };
  const replacePr = (pr: MemoryPr, change: Partial<MemoryPr>): MemoryPr => {
    const updated = { ...pr, ...change };
    state.prs = state.prs.map((p) => (p === pr ? updated : p));
    return updated;
  };
  const issues: IssueService = {
    ensureLabels: (repo, labels) => {
      state.log.push(`labels ${repo} ${labels.join(",")}`);
      return Promise.resolve();
    },
    listAutomatic: (repo) =>
      Promise.resolve(
        state.issues
          .filter((i) => i.repo === repo && i.labels.includes("vtc:auto"))
          .map(remoteFacts),
      ),
    create: (repo, request) => {
      const body = read(request);
      const issue: MemoryIssue = {
        repo,
        number: next++,
        url: `https://github.com/${repo}/issues/${String(next - 1)}`,
        state: "open",
        stateReason: null,
        labels: [...request.labels],
        marker: parseAutoMarker(body),
        updatedAt: now(),
        createdAt: now(),
        humanActivity: false,
        title: request.title,
        body,
        comments: [],
      };
      state.issues.push(issue);
      state.log.push(`issue create ${String(issue.number)}`);
      return Promise.resolve(issue);
    },
    editBody: (repo, number, request) => {
      replaceIssue(findIssue(repo, number), { body: read(request) });
      state.log.push(`issue edit ${String(number)}`);
      return Promise.resolve();
    },
    comment: (repo, number, request) => {
      const issue = findIssue(repo, number);
      const text = read(request);
      replaceIssue(issue, { comments: [...issue.comments, text] });
      state.log.push(`issue comment ${String(number)}`);
      return Promise.resolve();
    },
    reopen: (repo, number, comment) => {
      const issue = findIssue(repo, number);
      replaceIssue(issue, {
        state: "open",
        stateReason: "reopened",
        comments: [...issue.comments, `${AUTO_COMMENT_MARKER}\n${comment}`],
      });
      state.log.push(`issue reopen ${String(number)}`);
      return Promise.resolve();
    },
    close: (repo, number, reason, comment) => {
      const issue = findIssue(repo, number);
      replaceIssue(issue, {
        state: "closed",
        stateReason: reason,
        comments: [...issue.comments, `${AUTO_COMMENT_MARKER}\n${comment}`],
      });
      state.log.push(`issue close ${String(number)} ${reason}`);
      return Promise.resolve();
    },
  };
  const pullRequests: AutoPullRequestService = {
    listOpenAutomatic: (repo) =>
      Promise.resolve(state.prs.filter((p) => p.repo === repo && p.state === "open").map(head)),
    openDraft: (repo, request) => {
      const body = read(request);
      const pr: MemoryPr = {
        repo,
        number: next++,
        url: `https://github.com/${repo}/pull/${String(next - 1)}`,
        headRefName: request.branch,
        headSha: options.remote?.get(`refs/heads/${request.branch}`) ?? "f".repeat(40),
        isDraft: true,
        state: "open",
        labels: [...request.labels],
        marker: parseAutoMarker(body),
        title: request.title,
        body,
        base: request.base,
        attached: (request.attach ?? []).map((a) => a.name),
        comments: [],
        branchDeleted: false,
      };
      state.prs.push(pr);
      state.log.push(`pr create ${String(pr.number)}`);
      return Promise.resolve(pr);
    },
    editBody: (repo, number, request) => {
      const pr = replacePr(findPr(repo, number), { body: read(request) });
      state.log.push(`pr edit ${String(number)}`);
      return Promise.resolve(head(pr));
    },
    markReady: (repo, number) => {
      const pr = replacePr(findPr(repo, number), { isDraft: false });
      state.log.push(`pr ready ${String(number)}`);
      return Promise.resolve(head(pr));
    },
    close: (repo, number, comment, deleteIfHead) => {
      const pr = findPr(repo, number);
      const deleted = deleteIfHead !== undefined && deleteIfHead === head(pr).headSha;
      if (deleted) options.remote?.delete(`refs/heads/${pr.headRefName}`);
      replacePr(pr, {
        state: "closed",
        comments: [...pr.comments, comment],
        branchDeleted: deleted,
      });
      state.log.push(`pr close ${String(number)}`);
      return Promise.resolve();
    },
  };
  return {
    issues,
    pullRequests,
    state,
    human: (number, change) => {
      const issue = state.issues.find((i) => i.number === number);
      if (issue === undefined) throw new Error("no issue");
      replaceIssue(issue, {
        ...(change.close === undefined ? {} : { state: "closed", stateReason: change.close }),
        ...(change.label === undefined ? {} : { labels: [...issue.labels, change.label] }),
        ...(change.comment === undefined
          ? {}
          : { comments: [...issue.comments, change.comment], humanActivity: true }),
      });
    },
  };
};

export interface FakePlumbing extends GitPlumbing {
  /** The fake `origin`: `refs/heads/<branch>` → sha. */
  readonly remote: Map<string, string>;
  readonly commits: {
    sha: string;
    base: string | null;
    parents: readonly string[];
    changes: readonly PlumbingChange[];
    message: string;
  }[];
  readonly refs: Map<string, string>;
  readonly pushes: { remote: string; sha: string; dst: string }[];
}

/**
 * Plumbing over in-memory refs and a fake `origin`. A push updates the remote and the
 * remote-tracking ref (as git does) and is refused unless it fast-forwards the remote branch.
 * `sharing` gives another clone of the same remote: its own local refs, the same `origin` and
 * object store (another VTC installation reporting to the same repo).
 */
export const fakePlumbing = (
  refs: Record<string, string> = {},
  sharing?: FakePlumbing,
): FakePlumbing => {
  const map = new Map(Object.entries(refs));
  const remote = sharing?.remote ?? new Map<string, string>();
  const commits: FakePlumbing["commits"] = sharing?.commits ?? [];
  const pushes: FakePlumbing["pushes"] = [];
  const descends = (sha: string, ancestor: string): boolean => {
    if (sha === ancestor) return true;
    const commit = commits.find((c) => c.sha === sha);
    return commit?.parents.some((p) => descends(p, ancestor)) ?? false;
  };
  return {
    commits,
    refs: map,
    remote,
    pushes,
    resolve: (ref) => Promise.resolve(map.get(ref) ?? null),
    commit: (request) => {
      const sha = createHash("sha1")
        .update(`${String(commits.length)}${request.message}`)
        .digest("hex");
      commits.push({ sha, ...request });
      return Promise.resolve(sha);
    },
    updateRef: (ref, sha, expected) => {
      if ((map.get(ref) ?? null) !== expected) return Promise.reject(new Error("ref moved"));
      map.set(ref, sha);
      return Promise.resolve();
    },
    push: (name, sha, dst) => {
      const current = remote.get(dst);
      if (current !== undefined && !descends(sha, current)) {
        return Promise.reject(new Error(`! [rejected] ${dst} (non-fast-forward)`));
      }
      pushes.push({ remote: name, sha, dst });
      remote.set(dst, sha);
      map.set(dst.replace(/^refs\/heads\//, `refs/remotes/${name}/`), sha);
      return Promise.resolve();
    },
  };
};

export interface FakeRemoteRefs extends RemoteRefs {
  readonly fetches: { remote: string; refspecs: readonly string[] }[];
}

/**
 * `UpstreamDeps.remoteRefs` over a fake plumbing: a fetch copies `origin`'s branches into the
 * remote-tracking refs its refspecs name (a `*` refspec also prunes tracking refs the remote no
 * longer has; an exact one whose branch is missing rejects, as git does), and a message is read
 * from the shared object store.
 */
export const fakeRemoteRefs = (plumbing: FakePlumbing): FakeRemoteRefs => {
  const fetches: FakeRemoteRefs["fetches"] = [];
  return {
    fetches,
    fetch: (name, refspecs) => {
      fetches.push({ remote: name, refspecs });
      for (const spec of refspecs) {
        const [src = "", dst = ""] = spec.replace(/^\+/, "").split(":");
        if (!src.endsWith("*")) {
          const sha = plumbing.remote.get(src);
          if (sha === undefined) {
            return Promise.reject(new Error(`fatal: couldn't find remote ref ${src}`));
          }
          plumbing.refs.set(dst, sha);
          continue;
        }
        const from = src.slice(0, -1);
        const to = dst.slice(0, -1);
        for (const ref of [...plumbing.refs.keys()]) {
          if (ref.startsWith(to) && !plumbing.remote.has(from + ref.slice(to.length))) {
            plumbing.refs.delete(ref);
          }
        }
        for (const [ref, sha] of plumbing.remote) {
          if (ref.startsWith(from)) plumbing.refs.set(to + ref.slice(from.length), sha);
        }
      }
      return Promise.resolve();
    },
    message: (sha) => Promise.resolve(plumbing.commits.find((c) => c.sha === sha)?.message ?? null),
  };
};

export interface FakeRecorder extends EvidenceRecorder {
  readonly requests: EvidenceCaptureRequest[];
}

/**
 * A recorder that writes `bytes` per shot (or fails the shots `failing` returns true for on each
 * attempt), and renders a gate report to `gate-report.html`.
 */
export const fakeRecorder = (
  options: { bytes?: number; failing?: (attempt: number, name: string) => boolean } = {},
): FakeRecorder => {
  const requests: EvidenceCaptureRequest[] = [];
  return {
    requests,
    capture: (request): Promise<EvidenceCaptureResult> => {
      requests.push(request);
      const attempt = requests.length;
      const files: EvidenceCaptureResult["files"][number][] = [];
      const failed: EvidenceCaptureResult["failed"][number][] = [];
      for (const shot of request.shots) {
        if (options.failing?.(attempt, shot.name) === true) {
          failed.push({ name: shot.name, reason: "redaction scan hit" });
          continue;
        }
        const bytes = options.bytes ?? 1000;
        writeFileSync(join(request.outDir, shot.name), Buffer.alloc(bytes, 1));
        files.push({ name: shot.name, kind: shot.kind, bytes });
      }
      return Promise.resolve({ files, failed });
    },
    renderGateReport: ({ outDir }) => {
      writeFileSync(join(outDir, "gate-report.html"), "<html>gate</html>");
      return Promise.resolve({ html: "gate-report.html" });
    },
  };
};
