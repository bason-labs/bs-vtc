/**
 * D-cn end to end on real git (spine §5 readings 219 and 233): Lookback's routing fact raises its
 * issue in VTC's repo, and the upstream module answers it with its own PR: it reads
 * `DEFAULT_ROUTING_TABLE` at the default branch's commit of a real bs-vtc checkout (the repo's own
 * `tier-routing.ts`), moves the cell by one value, commits that one file through the real git
 * plumbing and pushes `vtc/auto/config/<fp8>` to a bare remote, then opens the PR. No automatic run
 * is started, so nothing else (acceptance tests, a CHANGELOG entry, test edits) rides along, and
 * the scope check sees one path. GitHub is the in-memory fake (D-cc: no real gh).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  automationFor,
  autoBranchName,
  routedStartTier,
  routingConfigSubject,
  type AutomationContext,
  type AutomationDeps,
  type RoutingTable,
} from "@vtc/shared";
import { createGitOps, createGitPlumbing } from "../../src/git/index.js";
import {
  createUpstream,
  readRoutingTableSource,
  ROUTING_TABLE_FILE,
  writeRoutingTableSource,
  type UpstreamEvent,
} from "../../src/upstream/index.js";
import { addBareRemote, cleanupDirs, git, initRepo, tempDir } from "../helpers/repo.js";
import { fakeAssets, fakeRecorder, memoryGitHub } from "../upstream/fakes.js";

afterEach(cleanupDirs);

const REPO = join(import.meta.dirname, "../../../..");
const UPSTREAM = "bason-labs/bs-vtc";
/** D-cm's table (reading 218(2)) in the repo's own file: the moves below start from its tiers. */
const DCM: RoutingTable = {
  v: 1,
  by_size: { S: "low", M: "mid", L: "top" },
  tagged_floor: "mid",
  high_floor: "top",
  high_risk_tags: ["auth", "payments", "data", "security", "migration"],
};

describe("a routing issue to its PR on real git (D-cn)", () => {
  it("commits only the routing table, moved by one value, and opens the PR without a run", async () => {
    const source = writeRoutingTableSource(
      readFileSync(join(REPO, ROUTING_TABLE_FILE), "utf8"),
      DCM,
    );
    const checkout = initRepo({
      [ROUTING_TABLE_FILE]: source,
      // what a run's Final Review and QA author would have dragged in: never touched here
      "roles/CHANGELOG.md": "# Roles changelog\n",
      "packages/shared/test/contracts-5-4.test.ts": "// pins\n",
    });
    const bare = addBareRemote(checkout);
    const main = git(checkout, "rev-parse", "refs/remotes/origin/main");
    const github = memoryGitHub();
    const events: UpstreamEvent[] = [];
    const started: string[] = [];
    const context: AutomationContext = { githubRemote: true, ghLoggedIn: true, paused: false };
    const automation: AutomationDeps = {
      issues: github.issues,
      pullRequests: github.pullRequests,
      evidence: fakeRecorder(),
      plumbing: createGitPlumbing,
      upstream: { repo: UPSTREAM, share: true, checkout },
      hosting: "branch",
      ffmpeg: false,
    };
    const guardDir = tempDir("vtc-guard-");
    const upstream = createUpstream({
      automation,
      vtcHome: tempDir("vtc-home-"),
      guardDir,
      vtcVersion: "0.5.0",
      assets: fakeAssets(),
      emit: (e) => events.push(e),
      now: () => new Date("2026-10-15T12:00:00Z"),
      defaultBranch: () => Promise.resolve("main"),
      vtcRoots: [REPO],
      gitOps: (root) => createGitOps({ repoRoot: root }),
      ghCommand: join(guardDir, "no-gh"),
      startRun: (input) => {
        started.push(input.request);
        return Promise.resolve();
      },
    });
    const ctx = {
      repoRoot: checkout,
      repo: UPSTREAM,
      state: () => ({
        settings: automationFor({ upstream: { share: true } }, {}, context),
        context,
      }),
      identity: { repo: UPSTREAM, repoRoot: checkout, clientNames: [], homeDir: "/Users/alice" },
      knownValues: [],
    };
    const subject = routingConfigSubject("engineer", "S", "none");
    const outcome = await upstream.report(
      {
        type: "improvement",
        kind: "config",
        subject,
        metrics: {
          "routing.from_tier": 0,
          "routing.to_tier": 1,
          "routing.current_tier": 0,
          "routing.shared": 0,
          "routing.replay_planned": 0,
          "routing.escalated_pct": 64,
        },
        at: "2026-10-15T11:00:00Z",
      },
      ctx,
    );
    expect(outcome).toMatchObject({ status: "issue", action: "opened" });
    expect(started).toEqual([]);
    expect(events.filter((e) => e.type === "automation.skipped")).toEqual([]);
    expect(github.state.prs).toHaveLength(1);
    const pr = github.state.prs[0];
    expect(pr?.base).toBe("main");
    // the branch on the remote holds one commit on main that changes the table only
    const branch = autoBranchName("config", github.state.issues[0]?.marker?.fp ?? "");
    expect(pr?.headRefName).toBe(branch);
    const head = git(bare, "rev-parse", `refs/heads/${branch}`);
    expect(git(bare, "rev-parse", `${head}^`)).toBe(main);
    expect(git(bare, "diff", "--name-only", main, head)).toBe(ROUTING_TABLE_FILE);
    expect(git(bare, "log", "-1", "--format=%B", head)).toContain("Generated-by: VTC 0.5.0");
    const table = readRoutingTableSource(git(bare, "show", `${head}:${ROUTING_TABLE_FILE}`) + "\n");
    expect(table.roles).toEqual({ engineer: { by_size: { S: "mid" } } });
    expect(routedStartTier(table, "engineer", "S", "none")).toBe("mid");
    expect(routedStartTier(table, "qa", "S", "none")).toBe("low");
    // the edit is the file's own form: everything outside the literal is byte for byte the same
    const after = git(bare, "show", `${head}:${ROUTING_TABLE_FILE}`) + "\n";
    const cut = (text: string) => text.split("export const DEFAULT_ROUTING_TABLE")[0];
    expect(cut(after)).toBe(cut(source));
    // the user's work tree and index are untouched
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });
});
