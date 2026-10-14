/**
 * The `gh`-backed `RemoteMergeService` (spine AD-23): what it asks `gh` and `git`, how it reads
 * the answers, and the AD-23 Check that no `gh` argv ever carries `GH_FORBIDDEN_ARGS`. A fake
 * `gh` runner records every argv; revert detection runs against a local bare remote.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { findForbiddenGhArgs, GH_FORBIDDEN_ARGS, PullRequestRefSchema } from "@vtc/shared";
import {
  createGhRemoteMerge,
  createGhRunner,
  guardGhArgs,
  isGithubUrl,
  pullRequestRefOf,
  type GhResult,
  type GhRunner,
  type GitReader,
} from "../src/gh-remote-merge.js";
import { exec, type Exec } from "../src/process.js";
import { cleanupDirs, git, initRepo, tempDir } from "./helpers.js";

afterEach(cleanupDirs);

/** Every argv any fake runner in this file was asked to run. */
const ALL_ARGV: string[][] = [];

afterAll(() => {
  // AD-23 Check: no gh argv carries GH_FORBIDDEN_ARGS
  expect(ALL_ARGV.length).toBeGreaterThan(20);
  for (const argv of ALL_ARGV) expect(findForbiddenGhArgs(argv)).toEqual([]);
});

type Responder = (args: readonly string[]) => GhResult | undefined;

const ok = (value: unknown): GhResult => ({
  code: 0,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
});
const fail = (stderr: string, code = 1): GhResult => ({ code, stdout: "", stderr });

const fakeGh = (...responders: Responder[]): { gh: GhRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push([...args]);
    ALL_ARGV.push([...args]);
    for (const respond of responders) {
      const result = respond(args);
      if (result !== undefined) return Promise.resolve(result);
    }
    return Promise.resolve(fail(`unexpected gh ${args.join(" ")}`));
  };
  return { gh, calls };
};

const on =
  (prefix: string, result: GhResult | ((args: readonly string[]) => GhResult)): Responder =>
  (args) =>
    args.join(" ").startsWith(prefix)
      ? typeof result === "function"
        ? result(args)
        : result
      : undefined;

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const MERGED = "c".repeat(40);

const prJson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: "https://github.com/acme/app/pull/12",
  number: 12,
  isDraft: false,
  state: "OPEN",
  headRefOid: HEAD,
  mergeCommit: null,
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
  autoMergeRequest: null,
  isInMergeQueue: false,
  mergeStateStatus: "BLOCKED",
  baseRefName: "main",
  ...over,
});

/** The base's policy, with these required checks (rules only; classic protection unreadable). */
const requiredPolicy = (checks: readonly string[]): Responder[] => [
  on(
    "api --paginate --slurp -H Accept: application/vnd.github+json repos/{owner}/{repo}/rules",
    ok([
      [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: checks.map((context) => ({ context })) },
        },
      ],
    ]),
  ),
  on("api -H Accept: application/vnd.github+json repos/{owner}/{repo}/branches", fail("HTTP 404")),
  on("api -H Accept: application/vnd.github+json repos/{owner}/{repo}", ok({})),
];

const noGit: GitReader = () => Promise.resolve(null);

describe("the gh argv guard (AD-23 rule 2)", () => {
  it("refuses every form of a GH_FORBIDDEN_ARGS flag", () => {
    for (const flag of GH_FORBIDDEN_ARGS) {
      expect(() => {
        guardGhArgs(["pr", "merge", "1", flag]);
      }).toThrow(/never an admin bypass/);
      expect(() => {
        guardGhArgs(["pr", "merge", "1", `${flag}=true`]);
      }).toThrow(/never an admin bypass/);
    }
    expect(() => {
      guardGhArgs(["pr", "merge", "1", "--auto"]);
    }).not.toThrow();
  });

  it("the runner never spawns a forbidden argv", async () => {
    let spawned = 0;
    const run: Exec = () => {
      spawned += 1;
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const gh = createGhRunner("/r", "gh", run);
    await expect(gh(["pr", "merge", "1", "--admin"])).rejects.toThrow(/admin bypass/);
    expect(spawned).toBe(0);
  });

  it("refuses a branch that would read as a flag before running anything", async () => {
    const { gh, calls } = fakeGh();
    const service = createGhRemoteMerge({ repoRoot: "/r", gh, git: noGit });
    await expect(
      service.enableAutoMerge({ branch: "--admin", headSha: HEAD, method: "squash" }),
    ).rejects.toThrow(/not a branch name/);
    await expect(service.disableAutoMerge("-x")).rejects.toThrow(/not a branch name/);
    await expect(service.policy("main..x")).rejects.toThrow(/not a branch name/);
    expect(calls).toEqual([]);
  });

  it("runs the user's gh with prompts off, in the repo", async () => {
    const dir = tempDir("vtc-gh-");
    const stub = join(dir, "gh");
    writeFileSync(
      stub,
      `#!/bin/sh\nprintf '%s|%s|%s\\n' "$PWD" "$GH_PROMPT_DISABLED" "$*" > '${join(dir, "seen")}'\necho '{}'\n`,
    );
    chmodSync(stub, 0o755);
    const result = await createGhRunner(dir, stub, exec)(["auth", "status"]);
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, "seen"), "utf8").trim()).toBe(`${dir}|1|auth status`);
  });
});

describe("remote and policy (AD-23 rule 1)", () => {
  it.each([
    ["https://github.com/acme/app.git", true],
    ["git@github.com:acme/app.git", true],
    ["ssh://git@github.com/acme/app.git", true],
    ["https://x-token@github.com/acme/app", true],
    ["https://gitlab.com/acme/app.git", false],
    ["https://github.com.evil.example/acme/app", false],
    ["/srv/git/app.git", false],
  ])("%s is on GitHub: %s", (url, expected) => {
    expect(isGithubUrl(url)).toBe(expected);
  });

  it("reports GitHub and the gh login from gh auth status (no token read)", async () => {
    const { gh, calls } = fakeGh(on("auth status", ok("")));
    const service = createGhRemoteMerge({
      repoRoot: "/r",
      gh,
      git: (args) =>
        Promise.resolve(
          args.join(" ") === "remote get-url --push origin" ? "git@github.com:a/b.git\n" : null,
        ),
    });
    expect(await service.remote()).toEqual({ github: true, ghAuthenticated: true });
    expect(calls).toEqual([["auth", "status"]]);
    const loggedOut = fakeGh(on("auth status", fail("not logged in")));
    expect(
      await createGhRemoteMerge({
        repoRoot: "/r",
        gh: loggedOut.gh,
        git: () => Promise.resolve("https://github.com/a/b\n"),
      }).remote(),
    ).toEqual({ github: true, ghAuthenticated: false });
    const elsewhere = fakeGh();
    expect(
      await createGhRemoteMerge({
        repoRoot: "/r",
        gh: elsewhere.gh,
        git: () => Promise.resolve("https://gitlab.com/a/b\n"),
      }).remote(),
    ).toEqual({ github: false, ghAuthenticated: false });
    expect(elsewhere.calls).toEqual([]);
  });

  it("reads rules, classic protection and the repo's merge settings", async () => {
    const { gh, calls } = fakeGh(
      // every page of the rules (gh api --paginate --slurp): a rule on page 2 counts
      on(
        "api --paginate --slurp -H Accept: application/vnd.github+json repos/{owner}/{repo}/rules/branches/main?per_page=100",
        ok([
          [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "ci / test" }] },
            },
            { type: "pull_request", parameters: { required_approving_review_count: 1 } },
          ],
          [{ type: "merge_queue", parameters: {} }, { type: "deletion" }],
        ]),
      ),
      on(
        "api -H Accept: application/vnd.github+json repos/{owner}/{repo}/branches/main/protection",
        ok({
          required_status_checks: { contexts: ["lint"], checks: [{ context: "ci / test" }] },
          required_signatures: { enabled: true },
        }),
      ),
      on(
        "api -H Accept: application/vnd.github+json repos/{owner}/{repo}",
        ok({
          allow_auto_merge: true,
          allow_merge_commit: false,
          allow_squash_merge: true,
          allow_rebase_merge: true,
        }),
      ),
    );
    const policy = await createGhRemoteMerge({ repoRoot: "/r", gh, git: noGit }).policy("main");
    expect(policy).toEqual({
      base: "main",
      auto_merge_allowed: true,
      required_checks: ["ci / test", "lint"],
      merge_methods: ["squash", "rebase"],
      merge_queue: true,
      requires_review: true,
      signatures_required: true,
    });
    // reads only: no PATCH, PUT, POST or DELETE, no -f/-F field that would make gh POST
    for (const argv of calls)
      expect(argv.some((a) => /^(-X|--method|-f|-F|--field|--raw-field)$/.test(a))).toBe(false);
  });

  it("fails closed where the user cannot read a setting", async () => {
    const { gh } = fakeGh(
      on(
        "api --paginate --slurp -H Accept: application/vnd.github+json repos/{owner}/{repo}/rules",
        ok([[]]),
      ),
      on(
        "api -H Accept: application/vnd.github+json repos/{owner}/{repo}/branches",
        fail("HTTP 403"),
      ),
      on("api -H Accept: application/vnd.github+json repos/{owner}/{repo}", ok({ name: "app" })),
    );
    expect(await createGhRemoteMerge({ repoRoot: "/r", gh, git: noGit }).policy("main")).toEqual({
      base: "main",
      auto_merge_allowed: null,
      required_checks: [],
      merge_methods: [],
      merge_queue: false,
      requires_review: false,
      signatures_required: false,
    });
  });
});

describe("the merge path (AD-23 rule 2)", () => {
  it("reads the PR with the 4.5.0 fields", () => {
    const ref = pullRequestRefOf(prJson());
    expect(PullRequestRefSchema.parse(ref)).toEqual({
      url: "https://github.com/acme/app/pull/12",
      draft: false,
      state: "open",
      head_sha: HEAD,
      ci: "green",
      number: 12,
      auto_merge: "not_requested",
      merge_state_status: "BLOCKED",
    });
    expect(pullRequestRefOf(prJson({ autoMergeRequest: { enabledAt: "x" } }))?.auto_merge).toBe(
      "enabled",
    );
    expect(pullRequestRefOf(prJson({ isInMergeQueue: true }))?.auto_merge).toBe("queued");
    expect(
      pullRequestRefOf(prJson({ state: "MERGED", mergeCommit: { oid: MERGED } })),
    ).toMatchObject({ state: "merged", merge_commit: MERGED, auto_merge: "merged" });
  });

  it("reads the required checks only while the PR head is the gated SHA", async () => {
    const { gh, calls } = fakeGh(
      on("pr view vtc/F-1", ok(prJson())),
      ...requiredPolicy(["test", "lint"]),
      on("pr checks vtc/F-1 --required", {
        code: 8,
        stdout: JSON.stringify([
          { name: "test", bucket: "pass" },
          { name: "lint", bucket: "pending" },
          { name: "e2e", bucket: "fail" },
          { name: "docs", bucket: "skipping" },
          { name: "odd", bucket: "weird" },
        ]),
        stderr: "",
      }),
    );
    const service = createGhRemoteMerge({ repoRoot: "/r", gh, git: noGit });
    expect(await service.requiredChecks("vtc/F-1", HEAD)).toEqual([
      { name: "test", state: "success" },
      { name: "lint", state: "pending" },
      { name: "e2e", state: "failure" },
      { name: "docs", state: "skipped" },
      { name: "odd", state: "unknown" },
    ]);
    await expect(service.requiredChecks("vtc/F-1", OTHER)).rejects.toThrow(/not the gated/);
    expect(calls.filter((c) => c[1] === "checks")).toHaveLength(1);
    const none = fakeGh(
      on("pr view", ok(prJson())),
      ...requiredPolicy([]),
      on("pr checks", fail("no required checks reported on the 'vtc/F-1' branch")),
    );
    expect(
      await createGhRemoteMerge({ repoRoot: "/r", gh: none.gh, git: noGit }).requiredChecks(
        "vtc/F-1",
        HEAD,
      ),
    ).toEqual([]);
  });

  it("refuses checks read while a push moved the PR head off the gated SHA", async () => {
    let views = 0;
    const { gh } = fakeGh(
      on("pr view vtc/F-1", () => {
        views += 1;
        return ok(prJson(views === 1 ? {} : { headRefOid: OTHER }));
      }),
      ...requiredPolicy(["test"]),
      on("pr checks vtc/F-1 --required", ok([{ name: "test", bucket: "pass" }])),
    );
    await expect(
      createGhRemoteMerge({ repoRoot: "/r", gh, git: noGit }).requiredChecks("vtc/F-1", HEAD),
    ).rejects.toThrow(/moved to b{40} while its checks were read, not the gated a{40}/);
    expect(views).toBe(2);
  });

  it("counts a required check that has not reported yet as pending (AD-23 rule 2)", async () => {
    const { gh, calls } = fakeGh(
      on("pr view vtc/F-1", ok(prJson({ baseRefName: "develop" }))),
      ...requiredPolicy(["test", "e2e"]),
      on("pr checks vtc/F-1 --required", ok([{ name: "test", bucket: "pass" }])),
    );
    const service = createGhRemoteMerge({ repoRoot: "/r", gh, git: noGit });
    expect(await service.requiredChecks("vtc/F-1", HEAD)).toEqual([
      { name: "test", state: "success" },
      { name: "e2e", state: "pending" },
    ]);
    // the policy of the PR's own base
    expect(
      calls.some((c) => c.at(-1) === "repos/{owner}/{repo}/rules/branches/develop?per_page=100"),
    ).toBe(true);
    // none reported at all: every required check is pending
    const silent = fakeGh(
      on("pr view", ok(prJson())),
      ...requiredPolicy(["test"]),
      on("pr checks", fail("no required checks reported on the 'vtc/F-1' branch")),
    );
    expect(
      await createGhRemoteMerge({ repoRoot: "/r", gh: silent.gh, git: noGit }).requiredChecks(
        "vtc/F-1",
        HEAD,
      ),
    ).toEqual([{ name: "test", state: "pending" }]);
    // no base reported: fail closed
    const nobase = fakeGh(on("pr view", ok(prJson({ baseRefName: undefined }))));
    await expect(
      createGhRemoteMerge({ repoRoot: "/r", gh: nobase.gh, git: noGit }).requiredChecks(
        "vtc/F-1",
        HEAD,
      ),
    ).rejects.toThrow(/no base branch/);
  });

  it("enables auto-merge bound to the gated SHA, never with --admin", async () => {
    let enabled = false;
    const { gh, calls } = fakeGh(
      on("pr view vtc/F-1", () =>
        ok(prJson(enabled ? { autoMergeRequest: { mergeMethod: "SQUASH" } } : {})),
      ),
      on("pr merge 12 --auto", () => {
        enabled = true;
        return ok("");
      }),
    );
    const ref = await createGhRemoteMerge({ repoRoot: "/r", gh, git: noGit }).enableAutoMerge({
      branch: "vtc/F-1",
      headSha: HEAD,
      method: "squash",
    });
    expect(ref.auto_merge).toBe("enabled");
    expect(calls.find((c) => c[1] === "merge")).toEqual([
      "pr",
      "merge",
      "12",
      "--auto",
      "--match-head-commit",
      HEAD,
      "--squash",
    ]);
    const refused = fakeGh(
      on("pr view", ok(prJson())),
      on("pr merge", fail("Head branch was modified")),
    );
    await expect(
      createGhRemoteMerge({ repoRoot: "/r", gh: refused.gh, git: noGit }).enableAutoMerge({
        branch: "vtc/F-1",
        headSha: HEAD,
        method: "merge",
      }),
    ).rejects.toThrow(/gh pr merge failed: Head branch was modified/);
  });

  it("disables auto-merge on an open PR, and does nothing without one", async () => {
    const { gh, calls } = fakeGh(
      on("pr view vtc/F-1", ok(prJson({ autoMergeRequest: {} }))),
      on("pr merge 12 --disable-auto", ok("")),
      on("pr view vtc/F-2", fail("no pull requests found")),
    );
    const service = createGhRemoteMerge({ repoRoot: "/r", gh, git: noGit });
    expect(await service.disableAutoMerge("vtc/F-1")).toMatchObject({ number: 12 });
    expect(calls.some((c) => c.join(" ") === "pr merge 12 --disable-auto")).toBe(true);
    expect(await service.disableAutoMerge("vtc/F-2")).toBeNull();
    // no auto-merge request on the PR: nothing to disable, gh is not asked
    const idle = fakeGh(on("pr view vtc/F-1", ok(prJson())));
    expect(
      await createGhRemoteMerge({ repoRoot: "/r", gh: idle.gh, git: noGit }).disableAutoMerge(
        "vtc/F-1",
      ),
    ).toMatchObject({ auto_merge: "not_requested" });
    expect(idle.calls.some((c) => c.includes("--disable-auto"))).toBe(false);
  });
});

describe("the post-merge watch (AD-23 rule 4)", () => {
  const policyResponders = [
    on(
      "api --paginate --slurp -H Accept: application/vnd.github+json repos/{owner}/{repo}/rules",
      ok([
        [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "test" }, { context: "legacy" }] },
          },
        ],
      ]),
    ),
    on(
      "api -H Accept: application/vnd.github+json repos/{owner}/{repo}/branches",
      fail("HTTP 404"),
    ),
  ];

  it("reads the merge commit's check runs and statuses, marking the required ones", async () => {
    const { gh } = fakeGh(
      ...policyResponders,
      // two pages of check runs: the superseding re-run is on the second
      on(
        `api --paginate --slurp -H Accept: application/vnd.github+json repos/{owner}/{repo}/commits/${MERGED}/check-runs?per_page=100`,
        ok([
          {
            check_runs: [
              {
                id: 1,
                name: "test",
                status: "completed",
                conclusion: "failure",
                html_url: "https://github.com/acme/app/runs/1",
              },
              { id: 3, name: "lint", status: "in_progress", conclusion: null },
            ],
          },
          {
            check_runs: [
              {
                id: 5,
                name: "test",
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/acme/app/runs/5",
              },
              { id: 4, name: "nightly", status: "completed", conclusion: "timed_out" },
            ],
          },
        ]),
      ),
      on(
        `api --paginate --slurp -H Accept: application/vnd.github+json repos/{owner}/{repo}/commits/${MERGED}/status`,
        ok([
          {
            statuses: [
              { context: "legacy", state: "error", target_url: "http://insecure.example/x" },
            ],
          },
        ]),
      ),
      on("api -H Accept: application/vnd.github+json repos/{owner}/{repo}", ok({})),
    );
    const runs = await createGhRemoteMerge({ repoRoot: "/r", gh, git: noGit }).baseRuns(
      "main",
      MERGED,
    );
    expect(runs).toEqual([
      {
        name: "test",
        conclusion: "success",
        required: true,
        url: "https://github.com/acme/app/runs/5",
      },
      { name: "lint", conclusion: "pending", required: false },
      { name: "nightly", conclusion: "failure", required: false },
      { name: "legacy", conclusion: "failure", required: true },
    ]);
  });

  it("finds a revert in git log after fetching the base, and a merged Revert PR naming ours", async () => {
    // a local bare remote: the user's clone, and a teammate who reverts the merge on main
    const origin = tempDir("vtc-origin-");
    git(origin, "init", "-q", "--bare", "-b", "main");
    const mine = initRepo();
    git(mine, "remote", "add", "origin", origin);
    writeFileSync(join(mine, "feature.txt"), "feature\n");
    git(mine, "add", ".");
    git(mine, "commit", "-q", "-m", "feature F-1 (#12)");
    const merge = git(mine, "rev-parse", "HEAD");
    git(mine, "push", "-q", "origin", "main");
    const teammate = tempDir("vtc-mate-");
    git(teammate, "clone", "-q", origin, ".");
    git(teammate, "config", "user.email", "mate@example.com");
    git(teammate, "config", "user.name", "Mate");
    git(teammate, "revert", "--no-edit", merge);
    const revert = git(teammate, "rev-parse", "HEAD");
    git(teammate, "push", "-q", "origin", "main");
    const prRevert = "d".repeat(40);
    const { gh } = fakeGh(
      on(
        "pr list --base main --state merged",
        ok([
          {
            number: 14,
            title: 'Revert "feature F-1"',
            body: "Reverts acme/app#12",
            mergeCommit: { oid: prRevert },
          },
          {
            number: 15,
            title: "Revert something else",
            body: "Reverts acme/app#120",
            mergeCommit: { oid: "e".repeat(40) },
          },
          {
            number: 16,
            title: "Follow-up to #12",
            body: "#12",
            mergeCommit: { oid: "f".repeat(40) },
          },
          {
            number: 17,
            title: "Revert via the API",
            body: "Reverts acme/app#12",
            mergeCommit: { oid: revert },
          },
        ]),
      ),
    );
    const service = createGhRemoteMerge({ repoRoot: mine, gh });
    expect(await service.findReverts("main", merge, 12)).toEqual([
      { commit: revert, detected_by: "git_log" },
      { commit: prRevert, detected_by: "pr_reference" },
    ]);
    expect(await service.findReverts("main", merge, null)).toEqual([
      { commit: revert, detected_by: "git_log" },
    ]);
    // nothing reverted: nothing found
    expect(await service.findReverts("main", revert, null)).toEqual([]);
  });
});
