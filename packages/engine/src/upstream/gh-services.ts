/**
 * The default `IssueService` and `AutoPullRequestService` (`@vtc/shared`, AD-27 rule 1): the
 * user's own `gh`, modelled on engine git's `createGhPullRequests`, with the command injectable so
 * tests use a stub binary (D-cc). Every call goes through the repo's serial queue; every write is
 * paced; bodies and comments go through `--body-file` from a staging directory; `-R owner/name` is
 * always explicit. In `attach` hosting a partial upload failure (non-zero exit, URL still printed)
 * is repaired: the body is re-read, unresolved relative references are stripped, and the item is
 * labelled `evidence: partial` (the label is created first if the repo lacks it, and the references
 * are stripped even if labelling fails). Issue listings also read `createdAt`, `closedAt` and the
 * comment times, so the daily cap and VTC's quiet close are known from the remote
 * (`RemoteIssueFacts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_COMMENT_MARKER,
  AUTO_LABELS,
  autoBranchName,
  autoPushRefAllowed,
  parseAutoMarker,
  type AutoIssueRef,
  type AutoIssueRequest,
  type AutoPrRef,
  type AutoPrRequest,
  type AutoPullRequestService,
  type GitHubRepo,
  type IssueService,
} from "@vtc/shared";
import { isQuietCloseByVtc, type RemoteIssueRef } from "./decisions.js";
import { createGhCommand, type GhCommand, type GhResult } from "./gh.js";
import { createRepoQueue, type RepoQueue } from "./queue.js";
import { isAutomationSkip } from "./skip.js";
import { createStaging } from "./staging.js";

export interface GhServicesDeps {
  /** The guarded `gh` command; default the spawn-backed one with `command`. */
  readonly run?: GhCommand;
  readonly command?: string;
  readonly queue?: RepoQueue;
  /** Root of the per-action staging directories (`<guard dir>/upstream/staging`). */
  readonly stagingRoot: string;
  /** The default queue's shared write log (VTC's home), so pacing holds across daemons. */
  readonly pacing?: { readonly root: string; readonly dir: string };
}

export interface GhServices {
  readonly issues: IssueService;
  readonly pullRequests: AutoPullRequestService;
  /** `gh repo view --json defaultBranchRef`. */
  readonly defaultBranch: (repo: GitHubRepo) => Promise<string>;
}

interface GhLabel {
  readonly name?: string;
}
interface GhIssue {
  readonly number?: number;
  readonly url?: string;
  readonly state?: string;
  readonly stateReason?: string | null;
  readonly labels?: readonly GhLabel[];
  readonly body?: string;
  readonly updatedAt?: string;
  readonly createdAt?: string;
  readonly closedAt?: string | null;
  readonly comments?: readonly { readonly body?: string; readonly createdAt?: string }[];
}
interface GhPr {
  readonly number?: number;
  readonly url?: string;
  readonly headRefName?: string;
  readonly headRefOid?: string;
  readonly isDraft?: boolean;
  readonly state?: string;
  readonly labels?: readonly GhLabel[];
  readonly body?: string;
}

const ISSUE_FIELDS =
  "number,url,state,stateReason,labels,body,updatedAt,createdAt,closedAt,comments";
const PR_FIELDS = "number,url,headRefName,headRefOid,isDraft,state,labels,body";
const LIST_LIMIT = "1000";

/** Colors of the labels VTC creates (D-bx). */
const LABEL_COLORS: Readonly<Record<string, string>> = {
  [AUTO_LABELS.auto]: "5319e7",
  [AUTO_LABELS.regression]: "d93f0b",
  [AUTO_LABELS.muted]: "cccccc",
  [AUTO_LABELS.keep]: "0e8a16",
  [AUTO_LABELS.security]: "b60205",
  [AUTO_LABELS.evidencePartial]: "fbca04",
  [AUTO_LABELS.needsEval]: "f9d0c4",
  [AUTO_LABELS.test]: "ededed",
};

const labelNames = (labels: readonly GhLabel[] | undefined): string[] =>
  (labels ?? []).flatMap((l) => (l.name === undefined ? [] : [l.name]));

const stateReasonOf = (value: string | null | undefined): AutoIssueRef["stateReason"] => {
  switch ((value ?? "").toUpperCase()) {
    case "COMPLETED":
      return "completed";
    case "NOT_PLANNED":
      return "not_planned";
    case "REOPENED":
      return "reopened";
    default:
      return null;
  }
};

/** Pure: an issue from `gh issue list|view --json`, or `null` when it lacks its identity. */
export const issueFromGh = (issue: GhIssue): RemoteIssueRef | null => {
  if (issue.number === undefined || issue.url === undefined) return null;
  const state = (issue.state ?? "").toUpperCase() === "CLOSED" ? "closed" : "open";
  const stateReason = stateReasonOf(issue.stateReason);
  const comments = (issue.comments ?? []).map((c) => ({
    body: c.body ?? "",
    createdAt: c.createdAt,
  }));
  return {
    number: issue.number,
    url: issue.url,
    state,
    stateReason,
    labels: labelNames(issue.labels),
    marker: parseAutoMarker(issue.body ?? ""),
    updatedAt: issue.updatedAt ?? new Date(0).toISOString(),
    humanActivity: comments.some((c) => !c.body.includes(AUTO_COMMENT_MARKER)),
    ...(issue.createdAt === undefined ? {} : { createdAt: issue.createdAt }),
    closedQuietByVtc:
      state === "closed" && isQuietCloseByVtc({ stateReason, closedAt: issue.closedAt, comments }),
  };
};

/** Pure: a PR from `gh pr list|view --json`, or `null` when it lacks its identity. */
export const pullRequestFromGh = (pr: GhPr): AutoPrRef | null => {
  if (pr.number === undefined || pr.url === undefined) return null;
  const state = (pr.state ?? "OPEN").toUpperCase();
  return {
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName ?? "",
    headSha: pr.headRefOid ?? "",
    isDraft: pr.isDraft ?? true,
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
    labels: labelNames(pr.labels),
    marker: parseAutoMarker(pr.body ?? ""),
  };
};

/** A relative evidence reference (`![alt](01-x.png)` or `[alt](01-x.webm)`) that gh did not upload. */
const UNRESOLVED_REFERENCE = /!?\[[^\]\n]{0,200}\]\(\d{2}-[a-z0-9-]{1,60}\.(?:png|gif|webm|mp4)\)/g;

/** Pure: `body` without the relative evidence references `gh --attach` left unresolved. */
export const stripUnresolvedReferences = (body: string): string =>
  body.replace(UNRESOLVED_REFERENCE, "").replace(/\n{3,}/g, "\n\n");

const numberFromUrl = (stdout: string, kind: "issues" | "pull"): number | null => {
  const match = new RegExp(`/${kind}/(\\d+)\\s*$`).exec(stdout.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
};

const fail = (args: readonly string[], result: GhResult): Error =>
  new Error(
    `gh ${args[0] ?? ""} ${args[1] ?? ""} failed (${String(result.code)}): ${result.stderr.trim().slice(0, 300)}`,
  );

const attachArgs = (request: AutoIssueRequest): string[] =>
  (request.attach ?? []).flatMap((a) => ["--attach", a.name]);

const labelArgs = (labels: readonly string[]): string[] => labels.flatMap((l) => ["--label", l]);

export const createGhServices = (deps: GhServicesDeps): GhServices => {
  const run =
    deps.run ?? createGhCommand(deps.command === undefined ? {} : { command: deps.command });
  const queue =
    deps.queue ?? createRepoQueue(deps.pacing === undefined ? {} : { pacing: deps.pacing });

  const read = async (repo: GitHubRepo, args: readonly string[], cwd: string): Promise<string> => {
    const result = await queue.read(repo, () => run(args, cwd));
    if (result.code !== 0) throw fail(args, result);
    return result.stdout;
  };
  const write = (repo: GitHubRepo, args: readonly string[], cwd: string): Promise<GhResult> =>
    queue.write(repo, () => run(args, cwd));
  const mustWrite = async (
    repo: GitHubRepo,
    args: readonly string[],
    cwd: string,
  ): Promise<void> => {
    const result = await write(repo, args, cwd);
    if (result.code !== 0) throw fail(args, result);
  };
  /** Runs `body` with a fresh staging directory holding `comment.md` (marker included). */
  const withComment = async (
    text: string,
    body: (cwd: string, file: string) => Promise<void>,
  ): Promise<void> => {
    const staging = createStaging(deps.stagingRoot);
    try {
      const file = staging.write("comment.md", withCommentMarker(text));
      await body(staging.dir, file);
    } finally {
      staging.dispose();
    }
  };
  const tmpCwd = async <T>(body: (cwd: string) => Promise<T>): Promise<T> => {
    const staging = createStaging(deps.stagingRoot);
    try {
      return await body(staging.dir);
    } finally {
      staging.dispose();
    }
  };

  const viewIssue = (repo: GitHubRepo, number: number, cwd: string): Promise<AutoIssueRef> =>
    read(repo, ["issue", "view", String(number), "-R", repo, "--json", ISSUE_FIELDS], cwd).then(
      (stdout) => {
        const issue = issueFromGh(JSON.parse(stdout) as GhIssue);
        if (issue === null) throw new Error(`gh issue view ${String(number)}: no issue`);
        return issue;
      },
    );
  const viewPr = (repo: GitHubRepo, number: number, cwd: string): Promise<AutoPrRef> =>
    read(repo, ["pr", "view", String(number), "-R", repo, "--json", PR_FIELDS], cwd).then(
      (stdout) => {
        const pr = pullRequestFromGh(JSON.parse(stdout) as GhPr);
        if (pr === null) throw new Error(`gh pr view ${String(number)}: no pull request`);
        return pr;
      },
    );

  /**
   * After an `--attach` write exited non-zero but still printed the URL: re-read the body, strip
   * unresolved references and label the item `evidence: partial` (spine §5 reading 208). The label
   * is created first when the repo lacks it; if labelling still fails, the references are
   * stripped anyway.
   */
  const repairPartial = async (
    command: "issue" | "pr",
    repo: GitHubRepo,
    number: number,
    cwd: string,
  ): Promise<void> => {
    const stdout = await read(
      repo,
      [command, "view", String(number), "-R", repo, "--json", "body"],
      cwd,
    );
    const body = (JSON.parse(stdout) as { body?: string }).body ?? "";
    const staging = createStaging(deps.stagingRoot);
    try {
      const file = staging.write("body-resolved.md", stripUnresolvedReferences(body));
      const edit = [command, "edit", String(number), "-R", repo, "--body-file", file];
      let labelled = false;
      try {
        await ensureLabels(repo, [AUTO_LABELS.evidencePartial]);
        const result = await write(
          repo,
          [...edit, "--add-label", AUTO_LABELS.evidencePartial],
          staging.dir,
        );
        labelled = result.code === 0;
      } catch (error) {
        if (isAutomationSkip(error)) throw error;
      }
      if (!labelled) await mustWrite(repo, edit, staging.dir);
    } finally {
      staging.dispose();
    }
  };

  /** A create or edit that may carry attachments; returns the created number (create only). */
  const writeWithAttachments = async (
    command: "issue" | "pr",
    repo: GitHubRepo,
    args: readonly string[],
    request: AutoIssueRequest,
    existing: number | null,
  ): Promise<number> => {
    const result = await write(repo, args, request.stagingDir);
    const number =
      existing ?? numberFromUrl(result.stdout, command === "issue" ? "issues" : "pull");
    if (result.code === 0 && number !== null) return number;
    if (number !== null && (request.attach ?? []).length > 0) {
      await repairPartial(command, repo, number, request.stagingDir);
      return number;
    }
    throw fail(args, result);
  };

  const ensureLabels = async (repo: GitHubRepo, labels: readonly string[]): Promise<void> => {
    await tmpCwd(async (cwd) => {
      const stdout = await read(
        repo,
        ["label", "list", "-R", repo, "--json", "name", "--limit", LIST_LIMIT],
        cwd,
      );
      const existing = new Set(labelNames(JSON.parse(stdout) as GhLabel[]));
      for (const label of new Set(labels)) {
        if (existing.has(label)) continue;
        await mustWrite(
          repo,
          [
            "label",
            "create",
            label,
            "-R",
            repo,
            "--color",
            LABEL_COLORS[label] ?? "c5def5",
            "--description",
            "Raised automatically by VTC",
          ],
          cwd,
        );
      }
    });
  };

  const bodyOf = (request: AutoIssueRequest): string =>
    readFileSync(join(request.stagingDir, request.bodyFile), "utf8");

  const issues: IssueService = {
    ensureLabels,
    listAutomatic: (repo) =>
      tmpCwd(async (cwd) => {
        const stdout = await read(
          repo,
          [
            "issue",
            "list",
            "-R",
            repo,
            "--label",
            AUTO_LABELS.auto,
            "--state",
            "all",
            "--limit",
            LIST_LIMIT,
            "--json",
            ISSUE_FIELDS,
          ],
          cwd,
        );
        return (JSON.parse(stdout) as GhIssue[]).flatMap((i) => issueFromGh(i) ?? []);
      }),
    create: async (repo, request) => {
      if (parseAutoMarker(bodyOf(request)) === null) {
        throw new Error("an automatic issue body starts with its vtc:auto marker");
      }
      const args = [
        "issue",
        "create",
        "-R",
        repo,
        "--title",
        request.title,
        "--body-file",
        request.bodyFile,
        ...labelArgs(request.labels),
        ...attachArgs(request),
      ];
      const number = await writeWithAttachments("issue", repo, args, request, null);
      return viewIssue(repo, number, request.stagingDir);
    },
    editBody: async (repo, number, request) => {
      const args = [
        "issue",
        "edit",
        String(number),
        "-R",
        repo,
        "--body-file",
        request.bodyFile,
        ...attachArgs(request),
      ];
      await writeWithAttachments("issue", repo, args, request, number);
    },
    comment: async (repo, number, request) => {
      const text = bodyOf(request);
      await withComment(text, (cwd, file) =>
        mustWrite(repo, ["issue", "comment", String(number), "-R", repo, "--body-file", file], cwd),
      );
    },
    reopen: async (repo, number, comment) => {
      await withComment(comment, async (cwd, file) => {
        await mustWrite(repo, ["issue", "reopen", String(number), "-R", repo], cwd);
        await mustWrite(
          repo,
          ["issue", "comment", String(number), "-R", repo, "--body-file", file],
          cwd,
        );
      });
    },
    close: async (repo, number, reason, comment) => {
      await withComment(comment, async (cwd, file) => {
        await mustWrite(
          repo,
          ["issue", "comment", String(number), "-R", repo, "--body-file", file],
          cwd,
        );
        await mustWrite(
          repo,
          [
            "issue",
            "close",
            String(number),
            "-R",
            repo,
            "--reason",
            reason === "completed" ? "completed" : "not planned",
          ],
          cwd,
        );
      });
    },
  };

  const pullRequests: AutoPullRequestService = {
    listOpenAutomatic: (repo) =>
      tmpCwd(async (cwd) => {
        const stdout = await read(
          repo,
          [
            "pr",
            "list",
            "-R",
            repo,
            "--label",
            AUTO_LABELS.auto,
            "--state",
            "open",
            "--limit",
            LIST_LIMIT,
            "--json",
            PR_FIELDS,
          ],
          cwd,
        );
        return (JSON.parse(stdout) as GhPr[]).flatMap((p) => pullRequestFromGh(p) ?? []);
      }),
    openDraft: async (repo, request: AutoPrRequest) => {
      if (request.branch !== autoBranchName(request.kind, request.fingerprint)) {
        throw new Error("an automatic PR's head is autoBranchName(kind, fingerprint)");
      }
      if (!autoPushRefAllowed(`refs/heads/${request.branch}`) || request.base === request.branch) {
        throw new Error("an automatic PR never targets its own head");
      }
      if (parseAutoMarker(bodyOf(request)) === null) {
        throw new Error("an automatic PR body starts with its vtc:auto marker");
      }
      const args = [
        "pr",
        "create",
        "-R",
        repo,
        "--draft",
        "--base",
        request.base,
        "--head",
        request.branch,
        "--title",
        request.title,
        "--body-file",
        request.bodyFile,
        ...labelArgs(request.labels),
        ...attachArgs(request),
      ];
      const number = await writeWithAttachments("pr", repo, args, request, null);
      return viewPr(repo, number, request.stagingDir);
    },
    editBody: async (repo, number, request) => {
      const args = [
        "pr",
        "edit",
        String(number),
        "-R",
        repo,
        "--body-file",
        request.bodyFile,
        ...attachArgs(request),
      ];
      await writeWithAttachments("pr", repo, args, request, number);
      return viewPr(repo, number, request.stagingDir);
    },
    markReady: (repo, number) =>
      tmpCwd(async (cwd) => {
        await mustWrite(repo, ["pr", "ready", String(number), "-R", repo], cwd);
        return viewPr(repo, number, cwd);
      }),
    close: async (repo, number, comment, deleteIfHead) => {
      await withComment(comment, async (cwd, file) => {
        await mustWrite(
          repo,
          ["pr", "comment", String(number), "-R", repo, "--body-file", file],
          cwd,
        );
        // The head is read last, right before the close, so a push during the paced comment
        // write is seen; the remaining window is one read (a ref compare-and-delete is a contract
        // proposal).
        const deleteBranch =
          deleteIfHead !== undefined && (await viewPr(repo, number, cwd)).headSha === deleteIfHead;
        await mustWrite(
          repo,
          ["pr", "close", String(number), "-R", repo, ...(deleteBranch ? ["--delete-branch"] : [])],
          cwd,
        );
      });
    },
  };

  return {
    issues,
    pullRequests,
    defaultBranch: (repo) =>
      tmpCwd(async (cwd) => {
        const stdout = await read(repo, ["repo", "view", repo, "--json", "defaultBranchRef"], cwd);
        const name = (JSON.parse(stdout) as { defaultBranchRef?: { name?: string } })
          .defaultBranchRef?.name;
        if (name === undefined || name === "") throw new Error(`no default branch for ${repo}`);
        return name;
      }),
  };
};

/** Pure: `text` with {@link AUTO_COMMENT_MARKER} first (VTC posts as the user, so not by author). */
export const withCommentMarker = (text: string): string =>
  text.includes(AUTO_COMMENT_MARKER) ? text : `${AUTO_COMMENT_MARKER}\n${text}`;
