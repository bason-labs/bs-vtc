/**
 * H-15 (4): the GitHub merge and revert check (spine §5 reading 239; §7 rows "GitHub revert PRs"
 * and "`gh pr merge --auto` with nothing pending"). The Lead runs it by hand after the round-6
 * merge; no team and no test runs it, and it never runs in `pnpm verify`. It touches only
 * throwaway branches of bs-vtc (`vtc-h15/<stamp>/base` and `…/feature`, plus the
 * `revert-<n>-…` branch GitHub's Revert creates), never `master`, `main` or `build/foundation`:
 * every push and delete goes through {@link assertThrowaway}, and every `gh` argv through
 * {@link safeGhArgs} (no `--admin`, no `--force`, no setting change, no REST write).
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     packages/engine/test/upstream/live/github-revert-check.ts --repo <owner>/bs-vtc \
 *     [--from build/foundation] [--method merge|squash|rebase] [--revert-via api|button] \
 *     [--no-auto-probe] [--keep] [--record <file>] [--run]
 *
 * Run it from a bs-vtc checkout whose `origin` is that repo, signed in with the user's own `gh`
 * (AD-9: it reads no token). Without `--run` it only prints what it would do. With `--run` it:
 * 1. pushes `vtc-h15/<stamp>/base` at `origin/<from>`'s commit (a new branch; `<from>` itself is
 *    never written), and a one-file probe commit on `vtc-h15/<stamp>/feature`, built with a
 *    temporary index (the work tree and the user's index are never touched);
 * 2. opens the probe PR into the throwaway base and, unless `--no-auto-probe`, runs
 *    `gh pr merge --auto` on it with nothing pending (the base has no protection), recording
 *    what GitHub does; then merges it (`--<method>`) if that did not;
 * 3. reverts the PR the way GitHub's Revert button does: `--revert-via api` calls the GraphQL
 *    `revertPullRequest` mutation with no title or body (GitHub's defaults, as the button
 *    writes them); `--revert-via button` asks the Lead to press Revert on the PR page and type
 *    the new PR's number;
 * 4. merges the revert PR, then reads what AD-23 rule 4's revert detection reads
 *    (`RemoteMergeService.findReverts`): `git log <merge>..origin/<base>` commit messages, and the
 *    merged PRs into the base with their title and body;
 * 5. writes the record ({@link RevertCheckRecordSchema}, with {@link detectRevert}'s result) to
 *    `--record` or stdout, and deletes the throwaway branches unless `--keep`.
 * The record's shape is `fixtures/upstream-evidence/github-revert/revert.synthetic.json`; the Lead
 * saves the run's record beside it as `revert.recorded.json` and records the §7 row.
 *
 * It imports nothing from the repo, so Node runs it as is.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ------------------------------------------------------------------------------- arguments

export type MergeMethod = "merge" | "squash" | "rebase";

export interface RevertCheckArgs {
  readonly repo: string;
  readonly from: string;
  readonly method: MergeMethod;
  readonly revertVia: "api" | "button";
  readonly autoProbe: boolean;
  /** Without it, a dry run: the plan is printed and nothing runs. */
  readonly run: boolean;
  readonly keep: boolean;
  readonly record?: string;
}

/** bs-vtc only (H-15): any owner, the repo named `bs-vtc`. */
const BS_VTC = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/bs-vtc$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Pure: the check's arguments; throws on anything it does not know. */
export const parseRevertCheckArgs = (argv: readonly string[]): RevertCheckArgs => {
  let repo: string | undefined;
  let from = "build/foundation";
  let method: MergeMethod = "merge";
  let revertVia: "api" | "button" = "api";
  let autoProbe = true;
  let run = false;
  let keep = false;
  let record: string | undefined;
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--repo":
        repo = value(i, flag);
        i += 1;
        break;
      case "--from":
        from = value(i, flag);
        i += 1;
        break;
      case "--method": {
        const v = value(i, flag);
        if (v !== "merge" && v !== "squash" && v !== "rebase")
          throw new Error("--method is merge, squash or rebase");
        method = v;
        i += 1;
        break;
      }
      case "--revert-via": {
        const v = value(i, flag);
        if (v !== "api" && v !== "button") throw new Error("--revert-via is api or button");
        revertVia = v;
        i += 1;
        break;
      }
      case "--record":
        record = value(i, flag);
        i += 1;
        break;
      case "--no-auto-probe":
        autoProbe = false;
        break;
      case "--run":
        run = true;
        break;
      case "--keep":
        keep = true;
        break;
      default:
        throw new Error(`unknown argument ${String(flag)}`);
    }
  }
  if (repo === undefined || !BS_VTC.test(repo))
    throw new Error("--repo <owner>/bs-vtc is required: H-15 approves bs-vtc only");
  if (!BRANCH.test(from) || from.includes("..")) throw new Error("--from is not a branch name");
  return {
    repo,
    from,
    method,
    revertVia,
    autoProbe,
    run,
    keep,
    ...(record === undefined ? {} : { record }),
  };
};

// ----------------------------------------------------------------------- throwaway branches

const STAMP = /^\d{8}T\d{6}Z$/;
const THROWAWAY = /^(?:revert-[1-9][0-9]{0,8}-)?vtc-h15\/(\d{8}T\d{6}Z)\/(?:base|feature)$/;

/** Pure: the run's two throwaway branches, stamped with `now` (UTC, to the second). */
export const throwawayBranches = (
  now: Date,
): { readonly stamp: string; readonly base: string; readonly feature: string } => {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  if (!STAMP.test(stamp)) throw new Error(`bad stamp ${stamp}`);
  return { stamp, base: `vtc-h15/${stamp}/base`, feature: `vtc-h15/${stamp}/feature` };
};

/** Pure: the head branch GitHub's Revert creates for PR `pr` of `branch`. */
export const revertBranchOf = (pr: number, branch: string): string =>
  `revert-${String(pr)}-${branch}`;

/**
 * Throws unless `branch` is one of this check's throwaway branches (`vtc-h15/<stamp>/base` or
 * `…/feature`, or GitHub's `revert-<n>-` branch of one) and none of `protectedNames` (the default
 * branch, `master`, `main`, `--from`). Every push and delete runs through it.
 */
export const assertThrowaway = (branch: string, protectedNames: readonly string[]): void => {
  if (!THROWAWAY.test(branch) || protectedNames.includes(branch))
    throw new Error(`refusing to write ${JSON.stringify(branch)}: not a throwaway H-15 branch`);
};

/** `gh` flags and commands the check never passes (AD-23: no admin bypass; no setting change). */
const FORBIDDEN_GH = [/^--admin(?:=|$)/, /^--force(?:=|$)/, /^-X$/, /^--method(?:=|$)/];

/** Pure: `args` when the check may pass them to `gh`; throws otherwise. */
export const safeGhArgs = (args: readonly string[]): readonly string[] => {
  const bad = args.find((a) => FORBIDDEN_GH.some((re) => re.test(a)));
  if (bad !== undefined) throw new Error(`refusing to run gh with ${bad}`);
  const [command, sub] = args;
  if (command === "repo" && sub !== "view")
    throw new Error(`refusing to run gh repo ${String(sub)}`);
  if (command === "api" && sub !== "graphql")
    throw new Error("refusing to run gh api outside GraphQL");
  return args;
};

// --------------------------------------------------------------------------------- record

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

/** What the Lead's run records, and the synthetic fixture's shape. */
export const RevertCheckRecordSchema = z.strictObject({
  v: z.literal(1),
  /** `synthetic`: the expected shape, written before the live run; `recorded`: the run's own. */
  kind: z.enum(["synthetic", "recorded"]),
  note: z.string().max(1000).optional(),
  recorded_at: z.iso.datetime(),
  tools: z.strictObject({ gh: z.string().max(200), git: z.string().max(200) }),
  repo: z.string().regex(BS_VTC),
  method: z.enum(["merge", "squash", "rebase"]),
  branches: z.strictObject({
    base: z.string().regex(THROWAWAY),
    feature: z.string().regex(THROWAWAY),
  }),
  merge: z.strictObject({
    pr: z.int().positive(),
    title: z.string().max(300),
    merge_commit: Sha,
    /** `gh pr merge --auto` with nothing pending; `null` with `--no-auto-probe`. */
    auto: z
      .strictObject({
        exit: z.int().nullable(),
        output: z.string().max(4000),
        merged_at_once: z.boolean(),
      })
      .nullable(),
  }),
  revert: z.strictObject({
    via: z.enum(["api", "button"]),
    pr: z.int().positive(),
    /** As GitHub wrote it: what `findReverts`' PR read matches (`/^revert/i`). */
    title: z.string().max(300),
    /** As GitHub wrote it: what `findReverts`' PR read matches (`#<pr>` or `/pull/<pr>`). */
    body: z.string().max(65_536),
    head: z.string().max(300),
    merge_commit: Sha,
    /** `git log <merge>..origin/<base>`: what `findReverts`' git read matches. */
    commits: z.array(z.strictObject({ sha: Sha, message: z.string().max(65_536) })).max(20),
  }),
  /** `gh pr list --base <base> --state merged`: the PRs `findReverts`' PR read sees. */
  listed: z
    .array(
      z.strictObject({
        number: z.int().positive(),
        title: z.string().max(300),
        body: z.string().max(65_536),
        merge_commit: Sha.nullable(),
      }),
    )
    .max(20),
  detection: z.strictObject({ git_log: z.boolean(), pr_reference: z.boolean() }),
});
export type RevertCheckRecord = z.infer<typeof RevertCheckRecordSchema>;

/**
 * Pure: whether AD-23 rule 4's two reads (`RemoteMergeService.findReverts`, `@vtc/shared`
 * interfaces/git.ts) find the revert in a record, read the way `findReverts` reads them: a commit
 * after the merge whose message says "This reverts commit <merge>" (the `git log` read), and,
 * among the merged PRs `gh pr list --base <base> --state merged` lists (`listed`), one with a
 * merge commit, titled "Revert…", whose body names `#<pr>` or `/pull/<pr>` (the PR read). The PR
 * read counts only when that listed PR's merge commit is the revert's own.
 */
export const detectRevert = (
  record: Pick<RevertCheckRecord, "merge" | "revert" | "listed">,
): { readonly git_log: boolean; readonly pr_reference: boolean } => {
  const mention = new RegExp(`(#|/pull/)${String(record.merge.pr)}(?![0-9])`);
  return {
    git_log: record.revert.commits.some((c) =>
      c.message.includes(`This reverts commit ${record.merge.merge_commit}`),
    ),
    pr_reference: record.listed.some(
      (p) =>
        p.merge_commit !== null &&
        /^[0-9a-f]{40}$/.test(p.merge_commit) &&
        p.merge_commit === record.revert.merge_commit &&
        /^revert/i.test(p.title) &&
        mention.test(p.body),
    ),
  };
};

/**
 * Pure: whether a checkout's `origin` URL is `repo` (`<owner>/<name>`) on github.com: the owner
 * must follow `github.com/` or `github.com:`, so `git@github.com:other/bs-vtc.git` is not
 * `owner/bs-vtc`. Every push and delete goes to `origin`, while `gh` reads and merges `--repo`.
 */
export const originIsRepo = (origin: string, repo: string): boolean => {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(?:https://(?:[^@/]+@)?|ssh://git@|git@)github\\.com[:/]${escaped}(?:\\.git)?/?$`,
    "i",
  ).test(origin.trim());
};

// ---------------------------------------------------------------------- the live run (Lead)

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const exec = (
  program: string,
  args: readonly string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Ran => {
  const result = spawnSync(program, [...args], {
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", ...options.env },
    timeout: 120_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

const must = (what: string, ran: Ran): string => {
  if (ran.code !== 0) throw new Error(`${what} failed (${String(ran.code)}): ${ran.stderr.trim()}`);
  return ran.stdout.trim();
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const live = async (args: RevertCheckArgs): Promise<void> => {
  const gh = (ghArgs: readonly string[]): Ran => exec("gh", safeGhArgs(ghArgs));
  const git = (gitArgs: readonly string[], options?: Parameters<typeof exec>[2]): Ran =>
    exec("git", gitArgs, options);
  const { stamp, base, feature } = throwawayBranches(new Date());

  // preflight: the checkout's origin is the repo, gh is signed in, the method is allowed
  const origin = must("git remote get-url origin", git(["remote", "get-url", "origin"]));
  if (!originIsRepo(origin, args.repo))
    throw new Error(`origin (${origin}) is not ${args.repo}: run this from a bs-vtc checkout`);
  must("gh auth status", gh(["auth", "status"]));
  const settings = JSON.parse(
    must(
      "gh repo view",
      gh([
        "repo",
        "view",
        args.repo,
        "--json",
        "defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
      ]),
    ),
  ) as {
    defaultBranchRef?: { name?: string };
    mergeCommitAllowed?: boolean;
    squashMergeAllowed?: boolean;
    rebaseMergeAllowed?: boolean;
  };
  const allowed = {
    merge: settings.mergeCommitAllowed,
    squash: settings.squashMergeAllowed,
    rebase: settings.rebaseMergeAllowed,
  }[args.method];
  if (allowed !== true) throw new Error(`${args.repo} does not allow --${args.method} merges`);
  const protectedNames = [
    "master",
    "main",
    args.from,
    ...(settings.defaultBranchRef?.name === undefined ? [] : [settings.defaultBranchRef.name]),
  ];
  const push = (sha: string, branch: string): void => {
    assertThrowaway(branch, protectedNames);
    must(`push ${branch}`, git(["push", "origin", `${sha}:refs/heads/${branch}`]));
  };
  const remove = (branch: string): void => {
    assertThrowaway(branch, protectedNames);
    const ran = git(["push", "origin", "--delete", branch]);
    console.warn(
      ran.code === 0 ? `deleted ${branch}` : `could not delete ${branch} (already gone?)`,
    );
  };
  const prState = (n: number) =>
    JSON.parse(
      must(
        `gh pr view ${String(n)}`,
        gh([
          "pr",
          "view",
          String(n),
          "--repo",
          args.repo,
          "--json",
          "id,number,title,body,state,headRefName,baseRefName,mergeCommit,autoMergeRequest",
        ]),
      ),
    ) as {
      id: string;
      number: number;
      title: string;
      body: string;
      state: string;
      headRefName: string;
      baseRefName: string;
      mergeCommit: { oid?: string } | null;
      autoMergeRequest: unknown;
    };
  const waitMerged = async (n: number, seconds: number) => {
    for (let i = 0; i < seconds; i += 2) {
      const pr = prState(n);
      if (pr.state === "MERGED") return pr;
      await sleep(2000);
    }
    return prState(n);
  };
  const mergeNow = async (n: number) => {
    must(
      `gh pr merge ${String(n)}`,
      gh(["pr", "merge", String(n), "--repo", args.repo, `--${args.method}`]),
    );
    const pr = await waitMerged(n, 30);
    if (pr.state !== "MERGED" || pr.mergeCommit?.oid === undefined)
      throw new Error(`PR #${String(n)} did not merge`);
    return { ...pr, mergeCommit: { oid: pr.mergeCommit.oid } };
  };

  const branches = [base, feature];
  let revertHead: string | undefined;
  try {
    // 1. the throwaway base at <from>'s commit, and the probe commit on the feature branch
    must(`fetch ${args.from}`, git(["fetch", "--no-tags", "origin", args.from]));
    const from = must("rev-parse", git(["rev-parse", "--verify", `FETCH_HEAD^{commit}`]));
    push(from, base);
    const tmp = mkdtempSync(join(tmpdir(), "vtc-h15-"));
    let probe: string;
    try {
      const env = { GIT_INDEX_FILE: join(tmp, "index") };
      const blob = must(
        "hash-object",
        git(["hash-object", "-w", "--stdin"], {
          input: `H-15 merge and revert probe ${stamp} (spine §5 reading 239). Safe to delete.\n`,
        }),
      );
      must("read-tree", git(["read-tree", from], { env }));
      must(
        "update-index",
        git(["update-index", "--add", "--cacheinfo", `100644,${blob},.vtc-h15/${stamp}.md`], {
          env,
        }),
      );
      const tree = must("write-tree", git(["write-tree"], { env }));
      probe = must(
        "commit-tree",
        git(["commit-tree", tree, "-p", from, "-m", `H-15 merge probe ${stamp}`]),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    push(probe, feature);

    // 2. the probe PR, the auto-merge probe, the merge
    const title = `H-15 merge probe ${stamp}`;
    const url = must(
      "gh pr create",
      gh([
        "pr",
        "create",
        "--repo",
        args.repo,
        "--base",
        base,
        "--head",
        feature,
        "--title",
        title,
        "--body",
        "Throwaway PR of the H-15 merge and revert check (spine §5 reading 239). Safe to delete.",
      ]),
    );
    const pr = Number(/\/pull\/(\d+)\s*$/.exec(url)?.[1]);
    if (!Number.isInteger(pr)) throw new Error(`no PR number in ${url}`);
    let auto: RevertCheckRecord["merge"]["auto"] = null;
    if (args.autoProbe) {
      const ran = gh([
        "pr",
        "merge",
        String(pr),
        "--repo",
        args.repo,
        "--auto",
        `--${args.method}`,
      ]);
      const after = await waitMerged(pr, 20);
      auto = {
        exit: ran.code,
        output: `${ran.stdout}\n${ran.stderr}`.trim().slice(0, 4000),
        merged_at_once: after.state === "MERGED",
      };
      if (after.state !== "MERGED" && after.autoMergeRequest !== null)
        gh(["pr", "merge", String(pr), "--repo", args.repo, "--disable-auto"]);
    }
    const merged = prState(pr).state === "MERGED" ? await waitMerged(pr, 2) : await mergeNow(pr);
    const mergeCommit = merged.mergeCommit?.oid;
    if (mergeCommit === undefined) throw new Error("the probe PR has no merge commit");

    // 3. the revert, as GitHub's Revert button writes it
    let revertPr: number;
    if (args.revertVia === "api") {
      const out = must(
        "revertPullRequest",
        gh([
          "api",
          "graphql",
          "-f",
          "query=mutation($id: ID!) { revertPullRequest(input: { pullRequestId: $id }) { revertPullRequest { number } } }",
          "-f",
          `id=${merged.id}`,
        ]),
      );
      revertPr = (
        JSON.parse(out) as {
          data: { revertPullRequest: { revertPullRequest: { number: number } } };
        }
      ).data.revertPullRequest.revertPullRequest.number;
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(
          `Press "Revert" on the PR page of #${String(pr)} in ${args.repo}, create the revert PR, then type its number: `,
        );
        revertPr = Number(answer.trim());
      } finally {
        rl.close();
      }
      if (!Number.isInteger(revertPr) || revertPr <= 0) throw new Error("no revert PR number");
    }
    const revert = prState(revertPr);
    revertHead = revert.headRefName;
    if (revert.baseRefName !== base)
      throw new Error(`the revert PR targets ${revert.baseRefName}, not ${base}`);

    // 4. merge it, then read what revert detection reads
    const revertMerged = await mergeNow(revertPr);
    must(
      `fetch ${base}`,
      git(["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]),
    );
    const log = must(
      "git log",
      git(["log", "--format=%H%x1f%B%x1e", `${mergeCommit}..refs/remotes/origin/${base}`]),
    );
    const commits = log
      .split("\x1e")
      .map((entry) => entry.trim().split("\x1f"))
      .flatMap(([sha, message = ""]) =>
        sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? [{ sha, message }] : [],
      );
    const listed = (
      JSON.parse(
        must(
          "gh pr list",
          gh([
            "pr",
            "list",
            "--repo",
            args.repo,
            "--base",
            base,
            "--state",
            "merged",
            "--limit",
            "20",
            "--json",
            "number,title,body,mergeCommit",
          ]),
        ),
      ) as { number: number; title: string; body: string; mergeCommit: { oid?: string } | null }[]
    ).map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body,
      merge_commit: p.mergeCommit?.oid ?? null,
    }));

    // 5. the record
    const partial = {
      merge: { pr, title: merged.title, merge_commit: mergeCommit, auto },
      revert: {
        via: args.revertVia,
        pr: revertPr,
        title: revert.title,
        body: revert.body,
        head: revert.headRefName,
        merge_commit: revertMerged.mergeCommit.oid,
        commits,
      },
    };
    const record = RevertCheckRecordSchema.parse({
      v: 1,
      kind: "recorded",
      recorded_at: new Date().toISOString(),
      tools: {
        gh: must("gh --version", exec("gh", ["--version"])).split("\n")[0] ?? "",
        git: must("git --version", git(["--version"])),
      },
      repo: args.repo,
      method: args.method,
      branches: { base, feature },
      ...partial,
      listed,
      detection: detectRevert({ ...partial, listed }),
    });
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (args.record === undefined) process.stdout.write(text);
    else writeFileSync(args.record, text);
    console.warn(
      `revert detection: git_log ${String(record.detection.git_log)}, pr_reference ${String(record.detection.pr_reference)}`,
    );
  } finally {
    if (!args.keep) {
      if (revertHead !== undefined && THROWAWAY.test(revertHead)) remove(revertHead);
      for (const branch of [...branches].reverse()) remove(branch);
    }
  }
};

const main = async (argv: readonly string[]): Promise<void> => {
  const args = parseRevertCheckArgs(argv);
  const { base, feature } = throwawayBranches(new Date());
  console.warn(
    [
      `H-15 GitHub merge and revert check on ${args.repo} (throwaway branches only):`,
      `- push ${base} at origin/${args.from}'s commit, and a probe commit on ${feature}`,
      `- open the probe PR into ${base}${args.autoProbe ? ", try gh pr merge --auto with nothing pending" : ""}, merge it (--${args.method})`,
      `- revert it ${args.revertVia === "api" ? "with GitHub's revertPullRequest (the Revert button's defaults)" : "with the Revert button (you press it)"}, merge the revert`,
      `- record the title, body and commits revert detection reads${args.record === undefined ? "" : ` to ${args.record}`}`,
      args.keep ? "- keep the branches" : "- delete the throwaway branches",
    ].join("\n"),
  );
  if (!args.run) {
    console.warn("dry run: nothing was done; pass --run to do it");
    return;
  }
  await live(args);
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
