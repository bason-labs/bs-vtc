/**
 * The `gh`-backed `RemoteMergeService` (`@vtc/shared`, spine AD-23; owner: cli+binary team), which
 * the cli injects as `EngineDeps.remoteMerge`. It drives the user's own `gh` and `git` with the
 * user's existing auth (AD-9): it never reads a token, never changes a repository setting, never
 * pushes, and never passes `GH_FORBIDDEN_ARGS` (`--admin`): every argv goes through
 * {@link guardGhArgs} before it runs.
 *
 * - `remote`: the `origin` push URL is on github.com, and `gh auth status` exits 0.
 * - `policy`: the repository's merge settings (`gh api repos/{owner}/{repo}`), the active branch
 *   rules (`…/rules/branches/<base>`) and, where readable, classic branch protection
 *   (`…/branches/<base>/protection`). A setting the user cannot read stays unknown (`null`) or
 *   absent, so the preflight fails closed.
 * - `requiredChecks`: `gh pr checks <branch> --required`, only while the PR head is the gated SHA,
 *   plus every check the base's policy requires that has not reported yet, as `pending` (AD-23
 *   rule 2: VTC itself waits for every required check, not only GitHub).
 * - `enableAutoMerge`: `gh pr merge <n> --auto --match-head-commit <sha> --<method>`.
 * - `disableAutoMerge`: `gh pr merge <n> --disable-auto`, only on an open PR with auto-merge on.
 * - `baseRuns`: the check runs and commit statuses on the merge commit, each marked required when
 *   its name is one of the base's required checks (workflow-run names never match a required
 *   check's context, so the check runs are read rather than `gh run list`). Every list endpoint is
 *   read with `gh api --paginate --slurp`, so a run or a rule past the first page is not missed.
 * - `findReverts`: `git log <merge>..origin/<base>` for "This reverts commit <merge>" after a
 *   fetch of the base, and merged PRs titled "Revert…" that name `#<pr>`.
 */
import { git } from "@vtc/engine";
import {
  findForbiddenGhArgs,
  type BaseRun,
  type MergeMethod,
  type PullRequestRef,
  type RemoteMergePolicy,
  type RemoteMergeService,
  type RequiredCheck,
  type RevertRef,
} from "@vtc/shared";
import { exec, type Exec } from "./process.js";

export interface GhResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `gh <args>` in the repo. */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

/** A `gh` call that hangs (network) is killed. */
export const GH_TIMEOUT_MS = 120_000;

/** Throws when an argv would carry a `GH_FORBIDDEN_ARGS` flag (AD-23 rule 2). */
export const guardGhArgs = (args: readonly string[]): void => {
  const forbidden = findForbiddenGhArgs(args);
  if (forbidden.length > 0)
    throw new Error(
      `refusing to run gh with ${forbidden.join(", ")} (AD-23: never an admin bypass)`,
    );
};

/** The user's own `gh`, prompts off, in `repoRoot`. */
export const createGhRunner = (
  repoRoot: string,
  command = "gh",
  run: Exec = exec,
  timeoutMs = GH_TIMEOUT_MS,
): GhRunner => {
  return async (args) => {
    guardGhArgs(args);
    const result = await run(command, args, {
      cwd: repoRoot,
      timeoutMs,
      env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.error === undefined ? result.stderr : `${result.stderr}${result.error}`,
    };
  };
};

/** Runs a git command in the repo; resolves `null` on failure. */
export type GitReader = (args: readonly string[]) => Promise<string | null>;

const defaultGit =
  (repoRoot: string): GitReader =>
  async (args) => {
    const result = await git.runGit(repoRoot, args, {
      allowFailure: true,
      timeoutMs: GH_TIMEOUT_MS,
    });
    return result.code === 0 ? result.stdout.toString("utf8") : null;
  };

const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const branchArg = (branch: string): string => {
  if (!BRANCH.test(branch)) throw new Error(`not a branch name VTC passes to gh: ${branch}`);
  return branch;
};
const shaArg = (sha: string): string => {
  if (!SHA.test(sha)) throw new Error(`not a full commit SHA: ${sha}`);
  return sha;
};

/** `origin` is on github.com (https, scp-like or ssh URL). */
export const isGithubUrl = (url: string): boolean =>
  /^(https:\/\/([^@/]+@)?github\.com[/:]|(ssh:\/\/)?[^@/\s]+@github\.com[:/])/i.test(url.trim());

interface GhPrView {
  readonly url?: string;
  readonly number?: number;
  readonly isDraft?: boolean;
  readonly state?: string;
  readonly headRefOid?: string;
  readonly mergeCommit?: { readonly oid?: string } | null;
  readonly statusCheckRollup?: readonly {
    readonly conclusion?: string;
    readonly status?: string;
    readonly state?: string;
  }[];
  readonly autoMergeRequest?: unknown;
  readonly isInMergeQueue?: boolean;
  readonly mergeStateStatus?: string;
  readonly baseRefName?: string;
}

const PR_FIELDS =
  "url,number,isDraft,state,headRefOid,baseRefName,mergeCommit,statusCheckRollup,autoMergeRequest,isInMergeQueue,mergeStateStatus";

/** A `gh pr view --json` object as the engine's `PullRequestRef` with the 4.5.0 fields. */
export const pullRequestRefOf = (pr: GhPrView): PullRequestRef | null => {
  const base = git.pullRequestFromGh(pr);
  if (base === null) return null;
  const auto =
    base.state === "merged"
      ? "merged"
      : pr.isInMergeQueue === true
        ? "queued"
        : pr.autoMergeRequest !== null && pr.autoMergeRequest !== undefined
          ? "enabled"
          : "not_requested";
  return {
    ...base,
    ...(typeof pr.number === "number" && pr.number > 0 ? { number: pr.number } : {}),
    auto_merge: auto,
    ...(typeof pr.mergeStateStatus === "string" && /^[A-Z_]{1,32}$/.test(pr.mergeStateStatus)
      ? { merge_state_status: pr.mergeStateStatus }
      : {}),
  };
};

const BUCKETS: Readonly<Record<string, RequiredCheck["state"]>> = {
  pass: "success",
  fail: "failure",
  pending: "pending",
  skipping: "skipped",
  cancel: "cancelled",
};

const checkRunState = (status: string | undefined, conclusion: string | null | undefined) => {
  if (status !== undefined && status !== "completed") return "pending" as const;
  switch (conclusion) {
    case "success":
    case "neutral":
      return "success" as const;
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
    case "stale":
      return "failure" as const;
    case "cancelled":
      return "cancelled" as const;
    case "skipped":
      return "skipped" as const;
    default:
      return "unknown" as const;
  }
};

const statusState = (state: string | undefined): BaseRun["conclusion"] =>
  state === "success"
    ? "success"
    : state === "failure" || state === "error"
      ? "failure"
      : state === "pending"
        ? "pending"
        : "unknown";

const httpsUrl = (url: unknown): { url: string } | Record<string, never> =>
  typeof url === "string" && url.startsWith("https://") ? { url } : {};

const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`gh returned malformed JSON for ${what}`);
  }
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export interface GhRemoteMergeOptions {
  readonly repoRoot: string;
  /** The `gh` runner (default: the user's `gh` in `repoRoot`). */
  readonly gh?: GhRunner;
  /** The git reader (default: the engine's `runGit` in `repoRoot`). */
  readonly git?: GitReader;
  /** The remote VTC reads the base from. */
  readonly remote?: string;
}

export const createGhRemoteMerge = (options: GhRemoteMergeOptions): RemoteMergeService => {
  const gh = options.gh ?? createGhRunner(options.repoRoot);
  const readGit = options.git ?? defaultGit(options.repoRoot);
  const remoteName = options.remote ?? "origin";

  const call = async (args: readonly string[]): Promise<GhResult> => {
    guardGhArgs(args);
    return gh(args);
  };
  const checked = async (args: readonly string[]): Promise<string> => {
    const result = await call(args);
    if (result.code !== 0)
      throw new Error(
        `gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim().slice(0, 300)}`,
      );
    return result.stdout;
  };
  /** `gh api <path>`: the JSON, or `null` when the endpoint refuses (404, 403). */
  const api = async (path: string): Promise<unknown> => {
    const result = await call(["api", "-H", "Accept: application/vnd.github+json", path]);
    if (result.code !== 0) return null;
    return parseJson(result.stdout, path);
  };
  /** Every page of a list endpoint (`gh api --paginate --slurp`), or `null` when it refuses. */
  const apiPages = async (path: string): Promise<unknown[] | null> => {
    const result = await call([
      "api",
      "--paginate",
      "--slurp",
      "-H",
      "Accept: application/vnd.github+json",
      path,
    ]);
    if (result.code !== 0) return null;
    return list(parseJson(result.stdout, path));
  };

  const viewRaw = async (branch: string): Promise<GhPrView | null> => {
    const result = await call(["pr", "view", branchArg(branch), "--json", PR_FIELDS]);
    if (result.code !== 0) return null;
    return parseJson(result.stdout, "gh pr view") as GhPrView;
  };
  const view = async (branch: string): Promise<PullRequestRef | null> => {
    const raw = await viewRaw(branch);
    return raw === null ? null : pullRequestRefOf(raw);
  };
  const mustView = async (branch: string): Promise<PullRequestRef> => {
    const pr = await view(branch);
    if (pr === null) throw new Error(`no pull request for ${branch}`);
    return pr;
  };
  const numberOf = (pr: PullRequestRef, branch: string): string => {
    if (pr.number === undefined) throw new Error(`gh reported no number for the PR of ${branch}`);
    return String(pr.number);
  };

  const policy = async (base: string): Promise<RemoteMergePolicy> => {
    const b = branchArg(base);
    const repo = record(await api("repos/{owner}/{repo}"));
    const rules =
      (await apiPages(`repos/{owner}/{repo}/rules/branches/${b}?per_page=100`))?.flatMap(list) ??
      [];
    const classic = record(await api(`repos/{owner}/{repo}/branches/${b}/protection`));
    const required = new Set<string>();
    let mergeQueue = false;
    let requiresReview = false;
    let signatures = false;
    for (const raw of rules) {
      const rule = record(raw);
      const params = record(rule.parameters);
      switch (rule.type) {
        case "required_status_checks":
          for (const check of list(params.required_status_checks)) {
            const context = str(record(check).context);
            if (context !== undefined) required.add(context);
          }
          break;
        case "pull_request":
          if (Number(params.required_approving_review_count ?? 0) > 0) requiresReview = true;
          break;
        case "merge_queue":
          mergeQueue = true;
          break;
        case "required_signatures":
          signatures = true;
          break;
      }
    }
    const classicChecks = record(classic.required_status_checks);
    for (const context of list(classicChecks.contexts))
      if (typeof context === "string") required.add(context);
    for (const check of list(classicChecks.checks)) {
      const context = str(record(check).context);
      if (context !== undefined) required.add(context);
    }
    if (
      Number(record(classic.required_pull_request_reviews).required_approving_review_count ?? 0) > 0
    )
      requiresReview = true;
    if (record(classic.required_signatures).enabled === true) signatures = true;
    const methods: MergeMethod[] = [];
    if (repo.allow_merge_commit === true) methods.push("merge");
    if (repo.allow_squash_merge === true) methods.push("squash");
    if (repo.allow_rebase_merge === true) methods.push("rebase");
    return {
      base,
      auto_merge_allowed: typeof repo.allow_auto_merge === "boolean" ? repo.allow_auto_merge : null,
      required_checks: [...required].sort(),
      merge_methods: methods,
      merge_queue: mergeQueue,
      requires_review: requiresReview,
      signatures_required: signatures,
    };
  };

  return {
    remote: async () => {
      const url = await readGit(["remote", "get-url", "--push", remoteName]);
      const github = url !== null && isGithubUrl(url);
      const auth = github ? await call(["auth", "status"]) : null;
      return { github, ghAuthenticated: auth?.code === 0 };
    },

    policy,

    requiredChecks: async (branch, sha) => {
      const raw = await viewRaw(branch);
      const pr = raw === null ? null : pullRequestRefOf(raw);
      if (raw === null || pr === null) throw new Error(`no pull request for ${branch}`);
      if (pr.head_sha !== shaArg(sha))
        throw new Error(`the PR head of ${branch} is ${pr.head_sha}, not the gated ${sha}`);
      const base = str(raw.baseRefName);
      if (base === undefined || base === "")
        throw new Error(`gh reported no base branch for the PR of ${branch}`);
      const wanted = (await policy(base)).required_checks;
      const result = await call([
        "pr",
        "checks",
        branchArg(branch),
        "--required",
        "--json",
        "name,bucket",
      ]);
      // exit 8 = some checks pending; the JSON is printed either way
      let reported: RequiredCheck[] = [];
      if (result.stdout.trim() === "") {
        if (!/no required checks/i.test(result.stderr))
          throw new Error(`gh pr checks failed: ${result.stderr.trim().slice(0, 300)}`);
      } else {
        reported = list(parseJson(result.stdout, "gh pr checks")).flatMap((item) => {
          const check = record(item);
          const name = str(check.name);
          if (name === undefined || name === "") return [];
          return [
            { name: name.slice(0, 200), state: BUCKETS[str(check.bucket) ?? ""] ?? "unknown" },
          ];
        });
      }
      // a required check that has not reported on this head yet is pending, not absent
      const seen = new Set(reported.map((c) => c.name));
      return [
        ...reported,
        ...wanted
          .filter((name) => !seen.has(name.slice(0, 200)))
          .map((name) => ({ name: name.slice(0, 200), state: "pending" as const })),
      ];
    },

    enableAutoMerge: async ({ branch, headSha, method }) => {
      const pr = await mustView(branch);
      await checked([
        "pr",
        "merge",
        numberOf(pr, branch),
        "--auto",
        "--match-head-commit",
        shaArg(headSha),
        `--${method}`,
      ]);
      return mustView(branch);
    },

    disableAutoMerge: async (branch) => {
      const pr = await view(branch);
      if (pr === null) return null;
      if (pr.state !== "open" || pr.auto_merge === "not_requested") return pr;
      await checked(["pr", "merge", numberOf(pr, branch), "--disable-auto"]);
      return view(branch);
    },

    baseRuns: async (base, sha) => {
      const commit = shaArg(sha);
      const required = new Set((await policy(base)).required_checks);
      const runs = new Map<string, { id: number; run: BaseRun }>();
      const checkRuns = (
        (await apiPages(`repos/{owner}/{repo}/commits/${commit}/check-runs?per_page=100`)) ?? []
      ).flatMap((page) => list(record(page).check_runs));
      for (const raw of checkRuns) {
        const check = record(raw);
        const name = str(check.name);
        if (name === undefined || name === "") continue;
        const id = Number(check.id ?? 0);
        const previous = runs.get(name);
        // a re-run supersedes the earlier run of the same check
        if (previous !== undefined && previous.id >= id) continue;
        runs.set(name, {
          id,
          run: {
            name: name.slice(0, 200),
            conclusion: checkRunState(str(check.status), str(check.conclusion) ?? null),
            required: required.has(name),
            ...httpsUrl(check.html_url),
          },
        });
      }
      const statuses = (
        (await apiPages(`repos/{owner}/{repo}/commits/${commit}/status?per_page=100`)) ?? []
      ).flatMap((page) => list(record(page).statuses));
      for (const raw of statuses) {
        const status = record(raw);
        const name = str(status.context);
        if (name === undefined || name === "" || runs.has(name)) continue;
        runs.set(name, {
          id: 0,
          run: {
            name: name.slice(0, 200),
            conclusion: statusState(str(status.state)),
            required: required.has(name),
            ...httpsUrl(status.target_url),
          },
        });
      }
      return [...runs.values()].map((r) => r.run);
    },

    findReverts: async (base, mergeCommit, prNumber) => {
      const b = branchArg(base);
      const merge = shaArg(mergeCommit);
      const found = new Map<string, RevertRef>();
      await readGit(["fetch", "--quiet", "--no-tags", remoteName, b]);
      const log = await readGit([
        "log",
        "--format=%H%x1f%B%x1e",
        `${merge}..refs/remotes/${remoteName}/${b}`,
      ]);
      for (const entry of (log ?? "").split("\x1e")) {
        const [commit, body = ""] = entry.trim().split("\x1f");
        if (commit === undefined || !SHA.test(commit)) continue;
        if (body.includes(`This reverts commit ${merge}`))
          found.set(commit, { commit, detected_by: "git_log" });
      }
      if (prNumber !== null) {
        const result = await call([
          "pr",
          "list",
          "--base",
          b,
          "--state",
          "merged",
          "--limit",
          "100",
          "--json",
          "number,title,body,mergeCommit",
        ]);
        if (result.code === 0) {
          const mention = new RegExp(`(#|/pull/)${String(prNumber)}(?![0-9])`);
          for (const raw of list(parseJson(result.stdout, "gh pr list"))) {
            const pr = record(raw);
            const commit = str(record(pr.mergeCommit).oid);
            if (commit === undefined || !SHA.test(commit) || found.has(commit)) continue;
            if (/^revert/i.test(str(pr.title) ?? "") && mention.test(str(pr.body) ?? ""))
              found.set(commit, { commit, detected_by: "pr_reference" });
          }
        }
      }
      return [...found.values()];
    },
  };
};
