/**
 * The feature's draft PR (§6.7 Level 2), behind an interface so engine core and its tests never
 * need the network. The default implementation drives the user's own `gh` CLI with the user's
 * existing auth (AD-9, §15); VTC never handles a token.
 */
import { spawn } from "node:child_process";
import type { PullRequestCi, PullRequestRef } from "@vtc/shared";

export interface PullRequestRequest {
  /** The integration branch, `vtc/F-n`. */
  readonly branch: string;
  /** The branch the PR targets (the repo's default branch). */
  readonly base: string;
  readonly title: string;
  /** The PR description (the evidence bundle summary at release). */
  readonly body: string;
}

export interface PullRequestService {
  /** Opens the draft PR for `branch`, or returns (and re-describes) the open one. */
  upsertDraft(request: PullRequestRequest): Promise<PullRequestRef>;
  /** Marks the PR ready for review (after Final Review passes). */
  markReady(branch: string): Promise<PullRequestRef>;
  /** The PR as it is now (state, head, CI), or `null` when there is none. */
  view(branch: string): Promise<PullRequestRef | null>;
}

interface GhPr {
  readonly url?: string;
  readonly isDraft?: boolean;
  readonly state?: string;
  readonly headRefOid?: string;
  readonly mergeCommit?: { readonly oid?: string } | null;
  readonly statusCheckRollup?: readonly {
    readonly conclusion?: string;
    readonly status?: string;
    readonly state?: string;
  }[];
}

/** A `gh` call that hangs (network) is killed, so the release job never stalls on it. */
export const GH_TIMEOUT_MS = 120_000;

const run = (
  cwd: string,
  command: string,
  args: readonly string[],
  timeoutMs = GH_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Settles at once on a timeout: a grandchild may hold the pipes open after the kill.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        code: -1,
        stdout: "",
        stderr: `${command} timed out after ${String(timeoutMs)} ms`,
      });
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/** CI on the PR head from `statusCheckRollup` (§6.7 Level-3 item 7). */
export const ciFromRollup = (rollup: GhPr["statusCheckRollup"]): PullRequestCi => {
  if (rollup === undefined || rollup.length === 0) return "unknown";
  const values = rollup.map((c) => (c.conclusion ?? c.state ?? c.status ?? "").toUpperCase());
  if (
    values.some((v) =>
      ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(v),
    )
  ) {
    return "red";
  }
  if (values.every((v) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v))) return "green";
  return "pending";
};

export const pullRequestFromGh = (pr: GhPr): PullRequestRef | null => {
  if (pr.url === undefined || pr.headRefOid === undefined) return null;
  const state = (pr.state ?? "OPEN").toUpperCase();
  const mergeCommit = state === "MERGED" ? pr.mergeCommit?.oid : undefined;
  const merged = mergeCommit !== undefined;
  return {
    url: pr.url,
    draft: pr.isDraft ?? true,
    state: merged ? "merged" : state === "CLOSED" ? "closed" : "open",
    head_sha: pr.headRefOid,
    ci: ciFromRollup(pr.statusCheckRollup),
    ...(mergeCommit === undefined ? {} : { merge_commit: mergeCommit }),
  };
};

const FIELDS = "url,isDraft,state,headRefOid,mergeCommit,statusCheckRollup";

/** `gh`-backed PRs in `repoRoot`. `command` is injectable so tests can use a stand-in. */
export const createGhPullRequests = (
  repoRoot: string,
  command = "gh",
  timeoutMs = GH_TIMEOUT_MS,
): PullRequestService => {
  const view = async (branch: string): Promise<PullRequestRef | null> => {
    const result = await run(
      repoRoot,
      command,
      ["pr", "view", branch, "--json", FIELDS],
      timeoutMs,
    );
    if (result.code !== 0) return null;
    return pullRequestFromGh(JSON.parse(result.stdout) as GhPr);
  };
  const must = async (branch: string): Promise<PullRequestRef> => {
    const pr = await view(branch);
    if (pr === null) throw new Error(`no pull request for ${branch}`);
    return pr;
  };
  const checked = async (args: readonly string[]): Promise<void> => {
    const result = await run(repoRoot, command, args, timeoutMs);
    if (result.code !== 0)
      throw new Error(
        `${command} ${args[0] ?? ""} ${args[1] ?? ""} failed: ${result.stderr.trim().slice(0, 300)}`,
      );
  };
  return {
    view,
    upsertDraft: async (request) => {
      const existing = await view(request.branch);
      if (existing === null) {
        await checked([
          "pr",
          "create",
          "--draft",
          "--base",
          request.base,
          "--head",
          request.branch,
          "--title",
          request.title,
          "--body",
          request.body,
        ]);
      } else if (existing.state === "open") {
        await checked(["pr", "edit", request.branch, "--body", request.body]);
      }
      return must(request.branch);
    },
    markReady: async (branch) => {
      await checked(["pr", "ready", branch]);
      return must(branch);
    },
  };
};
