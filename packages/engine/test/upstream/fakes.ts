/**
 * In-memory fakes for the upstream tests (D-cc): GitHub (issues and PRs), git plumbing, the
 * evidence recorder and the asset bundle. Nothing here runs `gh`, `git push` or a browser.
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

export const memoryGitHub = (): MemoryGitHub => {
  const state = { issues: [] as MemoryIssue[], prs: [] as MemoryPr[], log: [] as string[] };
  let next = 1;
  const now = (): string => new Date().toISOString();
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
      Promise.resolve(state.issues.filter((i) => i.repo === repo && i.labels.includes("vtc:auto"))),
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
      Promise.resolve(state.prs.filter((p) => p.repo === repo && p.state === "open")),
    openDraft: (repo, request) => {
      const body = read(request);
      const pr: MemoryPr = {
        repo,
        number: next++,
        url: `https://github.com/${repo}/pull/${String(next - 1)}`,
        headRefName: request.branch,
        headSha: "f".repeat(40),
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
      return Promise.resolve(pr);
    },
    markReady: (repo, number) => {
      const pr = replacePr(findPr(repo, number), { isDraft: false });
      state.log.push(`pr ready ${String(number)}`);
      return Promise.resolve(pr);
    },
    close: (repo, number, comment, deleteIfHead) => {
      const pr = findPr(repo, number);
      replacePr(pr, {
        state: "closed",
        comments: [...pr.comments, comment],
        branchDeleted: deleteIfHead !== undefined && deleteIfHead === pr.headSha,
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

export const fakePlumbing = (refs: Record<string, string> = {}): FakePlumbing => {
  const map = new Map(Object.entries(refs));
  const commits: FakePlumbing["commits"] = [];
  const pushes: FakePlumbing["pushes"] = [];
  return {
    commits,
    refs: map,
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
    push: (remote, sha, dst) => {
      pushes.push({ remote, sha, dst });
      return Promise.resolve();
    },
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
