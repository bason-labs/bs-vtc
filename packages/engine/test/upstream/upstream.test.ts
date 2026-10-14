/** The upstream module end to end with in-memory fakes (AD-27; D-cc: no real gh, git or GitHub). */
import {
  automationFor,
  splitRolePrompt,
  type AutomationContext,
  type AutomationDeps,
  type EvidenceRecorder,
  type PromptProposal,
  type ReplayResult,
  ROLE_DENIED_VTC,
} from "@vtc/shared";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoFingerprint,
  createUpstream,
  projectUpstreamReport,
  UPSTREAM_EVIDENCE_ROUTE,
  upstreamStateDir,
  type AutomationFact,
  type AutoPrInput,
  type FfmpegCommand,
  type ProjectContext,
  type UpstreamEvent,
} from "../../src/upstream/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import {
  fakeAssets,
  fakePlumbing,
  fakeRecorder,
  fakeRemoteRefs,
  memoryGitHub,
  type FakePlumbing,
} from "./fakes.js";

afterEach(cleanupDirs);

const UPSTREAM = "bason-labs/bs-vtc";
const PROJECT = "acme-corp/payroll-portal";
const BASE_SHA = "1".repeat(40);

interface Harness {
  readonly github: ReturnType<typeof memoryGitHub>;
  readonly events: UpstreamEvent[];
  readonly upstream: ReturnType<typeof createUpstream>;
  readonly ctx: ProjectContext;
  readonly plumbing: FakePlumbing;
  readonly clock: { now: Date };
  readonly checkout: string;
  readonly vtcHome: string;
  /** The bs-vtc checkout's files at `BASE_SHA` (what `gitOps.readFileAtCommit` serves). */
  readonly files: Map<string, string>;
  setContext(change: Partial<AutomationContext>): void;
  setShare(share: boolean): void;
}

const harness = (
  options: {
    automation?: Partial<AutomationDeps>;
    noRecorder?: boolean;
    contexts?: () => Partial<AutomationContext>;
    /** Share GitHub, the remote and the clock with another installation's harness. */
    shared?: Harness;
    /** Share VTC's home too (another daemon on the same machine). */
    sameHome?: boolean;
    /** With `shared`: its own clone of the shared remote (another installation's checkout). */
    clone?: boolean;
    /** Wire `UpstreamDeps.remoteRefs` (fetch and commit messages) over the fake plumbing. */
    remoteRefs?: boolean;
    noGitOps?: boolean;
    ffmpegCommand?: FfmpegCommand;
    evidence?: ProjectContext["evidence"];
  } = {},
): Harness => {
  const clock = options.shared?.clock ?? { now: new Date("2026-10-15T12:00:00Z") };
  const plumbing =
    options.shared !== undefined && options.clone !== true
      ? options.shared.plumbing
      : fakePlumbing({ "refs/remotes/origin/main": BASE_SHA }, options.shared?.plumbing);
  const github =
    options.shared?.github ?? memoryGitHub({ remote: plumbing.remote, now: () => clock.now });
  const events: UpstreamEvent[] = [];
  const repoRoot = options.shared?.ctx.repoRoot ?? tempDir("vtc-project-");
  const checkout = options.shared?.checkout ?? tempDir("vtc-checkout-");
  const files = options.shared?.files ?? new Map<string, string>();
  const vtcHome =
    options.shared !== undefined && options.sameHome === true
      ? options.shared.vtcHome
      : tempDir("vtc-home-");
  let context: AutomationContext = { githubRemote: true, ghLoggedIn: true, paused: false };
  let share = true;
  const automation: AutomationDeps = {
    issues: github.issues,
    pullRequests: github.pullRequests,
    ...(options.noRecorder === true ? {} : { evidence: fakeRecorder() }),
    plumbing: () => plumbing,
    upstream: { repo: UPSTREAM, share: true, checkout },
    hosting: "branch",
    ffmpeg: false,
    ...options.automation,
  };
  const ctx: ProjectContext = {
    repoRoot,
    repo: PROJECT,
    state: () => {
      const c = { ...context, ...options.contexts?.() };
      return {
        settings: automationFor({ upstream: { share } }, {}, c),
        context: c,
      };
    },
    identity: {
      repo: PROJECT,
      remoteUrl: `git@github.com:${PROJECT}.git`,
      repoRoot: "/Users/alice/clients/globex/payroll-portal",
      clientNames: ["Globex Industries"],
      homeDir: "/Users/alice",
    },
    knownValues: ["sk-live-payroll-SECRET-1234"],
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
  };
  const upstream = createUpstream({
    automation,
    vtcHome,
    guardDir: tempDir("vtc-guard-"),
    vtcVersion: "0.4.0",
    assets: fakeAssets(),
    emit: (e) => events.push(e),
    now: () => clock.now,
    defaultBranch: () => Promise.resolve("main"),
    vtcRoots: ["/Users/alice/vtc"],
    ...(options.noGitOps === true
      ? {}
      : {
          gitOps: () => ({
            readFileAtCommit: (sha, path) => {
              const text = sha === BASE_SHA ? files.get(path) : undefined;
              return Promise.resolve(
                text === undefined ? undefined : new TextEncoder().encode(text),
              );
            },
          }),
        }),
    ...(options.ffmpegCommand === undefined ? {} : { ffmpegCommand: options.ffmpegCommand }),
    ...(options.remoteRefs === true ? { remoteRefs: () => fakeRemoteRefs(plumbing) } : {}),
  });
  return {
    github,
    events,
    upstream,
    ctx,
    plumbing,
    clock,
    checkout,
    vtcHome,
    files,
    setContext: (change) => {
      context = { ...context, ...change };
    },
    setShare: (value) => {
      share = value;
    },
  };
};

const defect = (
  over: Partial<Extract<AutomationFact, { type: "vtc_defect" }>> = {},
): AutomationFact => ({
  type: "vtc_defect",
  errorClass: "adapter.parse_failure",
  role: "implementer",
  host: "codex",
  model: "gpt-5.5-codex",
  stack: `Error: x\n    at parseLine (/Users/alice/vtc/packages/adapters/src/codex/parse.ts:1:1)\n    at handler (/Users/alice/clients/globex/payroll-portal/src/a.ts:1:1)`,
  at: "2026-10-15T11:00:00Z",
  ...over,
});

const types = (events: readonly UpstreamEvent[]): string[] => events.map((e) => e.type);

describe("raising upstream issues", () => {
  it("records a first defect occurrence and raises the issue when it recurs", async () => {
    const h = harness();
    expect(await h.upstream.report(defect(), h.ctx)).toMatchObject({ status: "recorded" });
    const opened = await h.upstream.report(defect(), h.ctx);
    expect(opened).toMatchObject({ status: "issue", action: "opened" });
    const [issue] = h.github.state.issues;
    expect(issue?.repo).toBe(UPSTREAM);
    expect(issue?.labels).toEqual(["vtc:auto", "vtc:kind/defect"]);
    expect(issue?.title).toBe("vtc(defect): adapter.parse_failure in implementer");
    expect(issue?.body).toContain("| 2 |");
    for (const word of ["alice", "globex", "payroll", "acme"]) {
      expect(issue?.body.toLowerCase()).not.toContain(word);
    }
    expect(types(h.events)).toEqual(["upstream.issue_opened"]);
  });

  it("follows the dedupe table: duplicate within 24 h, muted, regression, quiet sweep and reopen", async () => {
    const h = harness();
    await h.upstream.report(defect(), h.ctx);
    await h.upstream.report(defect(), h.ctx);
    expect(await h.upstream.report(defect(), h.ctx)).toMatchObject({
      status: "skipped",
      reason: "duplicate",
    });
    h.clock.now = new Date("2026-10-16T12:30:00Z");
    expect(await h.upstream.report(defect(), h.ctx)).toMatchObject({
      status: "issue",
      action: "edited",
    });
    expect(h.github.state.issues).toHaveLength(1);

    // Closed as completed by a human, then it recurs: a linked regression.
    h.github.human(1, { close: "completed" });
    h.clock.now = new Date("2026-10-18T12:00:00Z");
    expect(await h.upstream.report(defect(), h.ctx)).toMatchObject({
      status: "issue",
      action: "opened",
    });
    const regression = h.github.state.issues[1];
    expect(regression?.labels).toContain("vtc:regression");
    expect(regression?.body).toContain("Regression of #1.");
    expect(
      h.events.find((e) => e.type === "upstream.issue_opened" && "regression_of" in e.payload)
        ?.payload,
    ).toMatchObject({ regression_of: 1 });

    // Quiet for 14 days: the sweep closes it; when it recurs it is reopened.
    h.clock.now = new Date("2026-11-02T12:00:00Z");
    const swept = await h.upstream.sweep(h.ctx);
    expect(swept).toEqual([
      expect.objectContaining({ status: "issue", action: "closed", number: 2 }),
    ]);
    expect(h.github.state.issues[1]).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(await h.upstream.report(defect(), h.ctx)).toMatchObject({
      status: "issue",
      action: "reopened",
      number: 2,
    });

    // A human closes it as not planned: muted forever.
    h.github.human(2, { close: "not_planned" });
    h.clock.now = new Date("2026-11-20T12:00:00Z");
    expect(await h.upstream.report(defect(), h.ctx)).toMatchObject({
      status: "skipped",
      reason: "muted",
    });
    expect(h.github.state.issues).toHaveLength(2);
    expect(
      h.events.filter((e) => e.type === "automation.skipped").map((e) => e.payload),
    ).toContainEqual(expect.objectContaining({ reason: "muted", kind: "defect" }));
  });

  it("never creates two issues for concurrent occurrences of one fingerprint", async () => {
    const h = harness();
    const fact: AutomationFact = {
      type: "security_advisory",
      advisoryId: "GHSA-9",
      package: "yaml",
      at: "2026-10-15T11:00:00Z",
    };
    const outcomes = await Promise.all([
      h.upstream.report(fact, h.ctx),
      h.upstream.report(fact, h.ctx),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["issue", "skipped"]);
    expect(h.github.state.issues).toHaveLength(1);
  });

  it("keeps the sweep off issues labelled vtc:keep or with human activity", async () => {
    const h = harness();
    for (const id of ["GHSA-0001", "GHSA-0002", "GHSA-0003"]) {
      await h.upstream.report(
        { type: "security_advisory", advisoryId: id, package: "yaml", at: "2026-10-15T11:00:00Z" },
        h.ctx,
      );
    }
    h.github.human(1, { label: "vtc:keep" });
    h.github.human(2, { comment: "I am looking at this" });
    h.clock.now = new Date("2026-11-15T12:00:00Z");
    const swept = await h.upstream.sweep(h.ctx);
    expect(swept.map((o) => ("number" in o ? o.number : 0))).toEqual([3]);
  });

  it("caps new issues at five per repo per day", async () => {
    const h = harness();
    const outcomes = [];
    for (let i = 1; i <= 6; i += 1) {
      outcomes.push(
        await h.upstream.report(
          {
            type: "security_advisory",
            advisoryId: `GHSA-000${String(i)}`,
            package: "yaml",
            at: "2026-10-15T11:00:00Z",
          },
          h.ctx,
        ),
      );
    }
    expect(outcomes.filter((o) => o.status === "issue")).toHaveLength(5);
    expect(outcomes[5]).toMatchObject({ status: "skipped", reason: "rate_limit" });
    expect(h.github.state.issues[0]?.labels).toEqual([
      "vtc:auto",
      "vtc:kind/security",
      "vtc:security",
    ]);
  });

  it("checks the opt-outs when queued and again when sent", async () => {
    const off = harness();
    off.setShare(false);
    expect(
      await off.upstream.report(
        {
          type: "security_advisory",
          advisoryId: "GHSA-1",
          package: "yaml",
          at: "2026-10-15T11:00:00Z",
        },
        off.ctx,
      ),
    ).toMatchObject({
      status: "skipped",
      reason: "share_off",
    });
    let calls = 0;
    const late = harness({ contexts: () => ((calls += 1) > 1 ? { paused: true } : {}) });
    expect(
      await late.upstream.report(
        {
          type: "security_advisory",
          advisoryId: "GHSA-1",
          package: "yaml",
          at: "2026-10-15T11:00:00Z",
        },
        late.ctx,
      ),
    ).toMatchObject({
      status: "skipped",
      reason: "paused",
    });
    expect(late.github.state.issues).toHaveLength(0);
    const logout = harness();
    logout.setContext({ ghLoggedIn: false });
    expect(
      await logout.upstream.report(
        {
          type: "security_advisory",
          advisoryId: "GHSA-1",
          package: "yaml",
          at: "2026-10-15T11:00:00Z",
        },
        logout.ctx,
      ),
    ).toMatchObject({
      reason: "gh_unavailable",
    });
  });

  it("fails closed on privacy: nothing is sent when a project identifier or secret shows", async () => {
    const h = harness();
    const fact = defect({ model: "globex-tuned" });
    await h.upstream.report(fact, h.ctx);
    expect(await h.upstream.report(fact, h.ctx)).toMatchObject({
      status: "skipped",
      reason: "privacy",
    });
    const secret = defect({ errorClass: "engine.crash", model: "sk-live-payroll-SECRET-1234" });
    await h.upstream.report(secret, h.ctx);
    expect(await h.upstream.report(secret, h.ctx)).toMatchObject({
      status: "skipped",
      reason: "privacy",
    });
    expect(h.github.state.issues).toHaveLength(0);
    const skip = h.events.find((e) => e.type === "automation.skipped");
    expect(JSON.stringify(skip)).not.toMatch(/globex|SECRET/i);
  });

  it("raises project issues in the project's repo, redacted, and only with a GitHub remote", async () => {
    const h = harness();
    const fact: AutomationFact = {
      type: "project_problem",
      kind: "parked",
      ruleId: "task.parked",
      path: "src/payroll/export.ts",
      title: "Payroll export task is parked",
      detail: "T-4 parked: the API key sk-live-payroll-SECRET-1234 is rejected",
      run: "R7",
      at: "2026-10-15T11:00:00Z",
    };
    expect(await h.upstream.report(fact, h.ctx)).toMatchObject({
      status: "issue",
      action: "opened",
    });
    const [issue] = h.github.state.issues;
    expect(issue?.repo).toBe(PROJECT);
    expect(issue?.title).toBe("vtc(parked): Payroll export task is parked");
    expect(issue?.body).toContain("T-4 parked");
    expect(issue?.body).not.toContain("SECRET-1234");
    expect(issue?.labels).toEqual(["vtc:auto", "vtc:kind/parked"]);
    h.setContext({ githubRemote: false });
    expect(await h.upstream.report({ ...fact, ruleId: "other" }, h.ctx)).toMatchObject({
      reason: "no_github_remote",
    });
  });
});

const PROMPT = `<!-- vtc:locked -->
# Implementer

Locked core: never touch files outside the task's scope.

<!-- vtc:editable -->
Prefer small commits.
Run the tests before you finish.
`;

const replay = (over: Partial<ReplayResult> = {}): ReplayResult => ({
  v: 1,
  proposal: "implementer-steps",
  role: "implementer",
  host: "codex",
  baseline: "a".repeat(64),
  candidate: "b".repeat(64),
  grader_bundle_sha: "c".repeat(64),
  k: 3,
  per_task: [
    { task: "T-12", a: [false, false, true], b: [true, true, true], regression_set: false },
    { task: "T-15", a: [false, true, false], b: [true, true, false], regression_set: true },
  ],
  aa_flip_rate: 0.05,
  sign_test: { n_discordant: 4, wins_b: 4, p: 0.0625 },
  tokens_delta_pct: -8,
  verdict: "improve",
  finished_at: "2026-10-15T10:00:00Z",
  ...over,
});

const proposal: PromptProposal = {
  v: 1,
  id: "implementer-steps",
  base: {
    role: "implementer",
    host: "codex",
    effective_sha256: "a".repeat(64),
  } as PromptProposal["base"],
  changes: [
    {
      hypothesis: "Listing the steps first cuts rework rounds.",
      target_metric: "rounds_to_done",
      trace_ids: ["r1-a1", "r2-a4"],
      summary: "plan the steps before editing",
    },
  ],
  editable:
    "Plan the steps before editing.\nPrefer small commits.\nRun the tests before you finish.",
  created_at: "2026-10-15T09:00:00Z",
};

describe("the Lookback PR", () => {
  const withCheckout = (h: Harness): void => {
    h.files.set("roles/implementer/prompt.md", PROMPT);
    h.files.set("roles/CHANGELOG.md", "# Role prompt changes\n\n## older entry\n");
  };

  it("commits the editable section and a CHANGELOG entry, opens a draft with evidence, then marks it ready", async () => {
    const h = harness();
    withCheckout(h);
    const outcome = await h.upstream.openLookbackPr({ replay: replay(), proposal }, h.ctx);
    expect(outcome).toMatchObject({ status: "pr", ready: true, evidence: "partial" });
    const fp = autoFingerprint({
      kind: "lookback",
      subject: "implementer",
      proposalKind: "prompt",
    });

    const [evidenceCommit, change] = h.plumbing.commits;
    expect(
      evidenceCommit?.changes.every((c) => c.path.startsWith(`lookback/${fp.slice(0, 8)}/`)),
    ).toBe(true);
    expect(change?.base).toBe(BASE_SHA);
    expect(change?.parents).toEqual([BASE_SHA]);
    const decoder = new TextDecoder();
    const prompt = decoder.decode(
      change?.changes.find((c) => c.path === "roles/implementer/prompt.md")?.bytes ??
        new Uint8Array(),
    );
    const split = splitRolePrompt(prompt);
    expect(split.ok && split.locked).toBe(
      "# Implementer\n\nLocked core: never touch files outside the task's scope.",
    );
    expect(split.ok && split.editable).toBe(proposal.editable);
    const changelog = decoder.decode(
      change?.changes.find((c) => c.path === "roles/CHANGELOG.md")?.bytes ?? new Uint8Array(),
    );
    expect(changelog.indexOf("implementer: plan the steps")).toBeLessThan(
      changelog.indexOf("older entry"),
    );
    expect(changelog).toContain("Listing the steps first");
    expect(changelog).toContain("`r1-a1`");
    expect(changelog).toContain("+Plan the steps before editing.");
    expect(changelog).toContain("A/A flip rate");
    expect(h.plumbing.pushes.map((p) => p.dst)).toEqual([
      "refs/heads/vtc-evidence",
      `refs/heads/vtc/auto/lookback/${fp.slice(0, 8)}`,
    ]);

    const [pr] = h.github.state.prs;
    expect(pr?.repo).toBe(UPSTREAM);
    expect(pr?.isDraft).toBe(false);
    expect(h.github.state.log.filter((l) => l.startsWith("pr"))).toEqual([
      "pr create 1",
      "pr ready 1",
    ]);
    expect(pr?.title).toBe("vtc(lookback): improve the implementer prompt");
    expect(pr?.labels).toEqual(["vtc:auto", "vtc:kind/lookback", "evidence: partial"]);
    expect(
      pr?.body.startsWith(`<!-- vtc:auto v=1 kind=lookback fp=${fp} role=implementer -->`),
    ).toBe(true);
    expect(pr?.body).toContain("VTC never merges automatic PRs");
    expect(pr?.body).toContain(`https://github.com/${UPSTREAM}/blob/`);
    expect(pr?.body).not.toMatch(/T-12|T-15|alice|globex|payroll/);
    expect(types(h.events)).toEqual(["upstream.pr_opened"]);
    expect(h.events[0]?.payload).toMatchObject({
      evidence: "partial",
      branch: `vtc/auto/lookback/${fp.slice(0, 8)}`,
    });
  });

  const lookbackBranch = `refs/heads/vtc/auto/lookback/${autoFingerprint({
    kind: "lookback",
    subject: "implementer",
    proposalKind: "prompt",
  }).slice(0, 8)}`;

  it("supersedes the older Lookback PR of the role: pushes on VTC's head first, then closes", async () => {
    const h = harness();
    withCheckout(h);
    await h.upstream.openLookbackPr({ replay: replay(), proposal }, h.ctx);
    const oldHead = h.plumbing.remote.get(lookbackBranch);
    const outcome = await h.upstream.openLookbackPr(
      { replay: replay({ finished_at: "2026-10-16T10:00:00Z" }), proposal },
      h.ctx,
    );
    expect(outcome).toMatchObject({ status: "pr", number: 2 });
    // The new head descends from VTC's old head (a fast-forward), on the same branch, which the
    // close therefore never deletes.
    const newHead = h.plumbing.remote.get(lookbackBranch);
    expect(newHead).not.toBe(oldHead);
    expect(h.plumbing.commits.find((c) => c.sha === newHead)?.parents).toEqual([oldHead, BASE_SHA]);
    expect(h.github.state.prs.map((p) => p.state)).toEqual(["closed", "open"]);
    expect(h.github.state.prs[0]?.branchDeleted).toBe(false);
    expect(h.github.state.prs[1]?.headSha).toBe(newHead);
    expect(h.github.state.log.filter((l) => l.startsWith("pr"))).toEqual([
      "pr create 1",
      "pr ready 1",
      "pr close 1",
      "pr create 2",
      "pr ready 2",
    ]);
    expect(types(h.events)).toEqual([
      "upstream.pr_opened",
      "upstream.pr_closed",
      "upstream.pr_opened",
    ]);
  });

  it("deletes a superseded PR's own branch only at VTC's head", async () => {
    const h = harness();
    withCheckout(h);
    const older = "aaaaaaaaaaaaaaaa";
    const report = projectUpstreamReport({
      kind: "lookback",
      fingerprint: older,
      vtcVersion: "0.4.0",
      role: "implementer",
      occurrences: 1,
      firstSeen: "2026-10-15T00:00:00Z",
      lastSeen: "2026-10-15T00:00:00Z",
    });
    expect(
      await h.upstream.openPullRequest(
        {
          target: "upstream",
          kind: "lookback",
          fingerprint: older,
          role: "implementer",
          summary: "improve the implementer prompt",
          slots: { summary: "An older proposal." },
          source: {
            changes: [{ path: "roles/CHANGELOG.md", bytes: new TextEncoder().encode("x") }],
            message: "older",
          },
          report,
          specVerifier: "none",
          evidence: {
            plan: { upstreamSafe: true, change: "prompt" },
            snapshot: { routes: {}, events: [] },
          },
        },
        h.ctx,
      ),
    ).toMatchObject({ status: "pr", number: 1 });
    expect(h.plumbing.remote.has("refs/heads/vtc/auto/lookback/aaaaaaaa")).toBe(true);
    await h.upstream.openLookbackPr({ replay: replay(), proposal }, h.ctx);
    expect(h.github.state.prs[0]).toMatchObject({ state: "closed", branchDeleted: true });
    expect(h.plumbing.remote.has("refs/heads/vtc/auto/lookback/aaaaaaaa")).toBe(false);
  });

  it("builds on another installation's VTC head of the shared branch (fetched, by its trailer)", async () => {
    const first = harness({ remoteRefs: true });
    withCheckout(first);
    await first.upstream.openLookbackPr({ replay: replay(), proposal }, first.ctx);
    const theirs = first.plumbing.remote.get(lookbackBranch);
    const second = harness({ shared: first, clone: true, remoteRefs: true });
    expect(
      await second.upstream.openLookbackPr(
        { replay: replay({ finished_at: "2026-10-16T10:00:00Z" }), proposal },
        second.ctx,
      ),
    ).toMatchObject({ status: "pr", number: 2 });
    const head = second.plumbing.remote.get(lookbackBranch);
    expect(second.plumbing.commits.find((c) => c.sha === head)?.parents).toEqual([
      theirs,
      BASE_SHA,
    ]);
    expect(first.github.state.prs.map((p) => p.state)).toEqual(["closed", "open"]);
  });

  it("fetches a branch left on the remote after its PR closed, and fast-forwards it", async () => {
    const first = harness({ remoteRefs: true });
    withCheckout(first);
    await first.upstream.openLookbackPr({ replay: replay(), proposal }, first.ctx);
    // A human closes the PR and leaves the branch.
    await first.github.pullRequests.close(UPSTREAM, 1, "not now");
    const left = first.plumbing.remote.get(lookbackBranch);
    expect(left).toBeDefined();
    const second = harness({ shared: first, clone: true, remoteRefs: true });
    expect(second.plumbing.refs.has(lookbackBranch.replace("heads", "remotes/origin"))).toBe(false);
    expect(
      await second.upstream.openLookbackPr(
        { replay: replay({ finished_at: "2026-10-16T10:00:00Z" }), proposal },
        second.ctx,
      ),
    ).toMatchObject({ status: "pr" });
    const head = second.plumbing.remote.get(lookbackBranch);
    expect(second.plumbing.commits.find((c) => c.sha === head)?.parents).toEqual([left, BASE_SHA]);
  });

  it("leaves a branch with a human's commit alone: no push, no evidence, the older PR stays open", async () => {
    const h = harness({ remoteRefs: true });
    withCheckout(h);
    await h.upstream.openLookbackPr({ replay: replay(), proposal }, h.ctx);
    // A human pushes a fix-up commit onto the automatic branch.
    const human = await h.plumbing.commit({
      base: h.plumbing.remote.get(lookbackBranch) ?? null,
      parents: [h.plumbing.remote.get(lookbackBranch) ?? ""],
      changes: [],
      message: "human fix-up",
    });
    h.plumbing.remote.set(lookbackBranch, human);
    const pushes = h.plumbing.pushes.length;
    expect(
      await h.upstream.openLookbackPr(
        { replay: replay({ finished_at: "2026-10-16T10:00:00Z" }), proposal },
        h.ctx,
      ),
    ).toMatchObject({ status: "skipped", reason: "duplicate" });
    expect(h.plumbing.remote.get(lookbackBranch)).toBe(human);
    // Checked before capture: no media reaches the evidence branch for a PR that cannot open.
    expect(h.plumbing.pushes.slice(pushes)).toEqual([]);
    expect(h.github.state.prs.map((p) => p.state)).toEqual(["open"]);
    expect(types(h.events)).not.toContain("upstream.pr_closed");
  });

  it("reads the prompt at the default branch's commit, never the work tree; no reader, no PR", async () => {
    const h = harness({ noGitOps: true });
    withCheckout(h);
    expect(await h.upstream.openLookbackPr({ replay: replay(), proposal }, h.ctx)).toMatchObject({
      status: "skipped",
      reason: "no_upstream_checkout",
    });
    expect(h.plumbing.pushes).toHaveLength(0);
  });

  it("refuses model-written text that names a project path", async () => {
    const h = harness();
    withCheckout(h);
    const leaky: PromptProposal = {
      ...proposal,
      changes: [
        {
          ...(proposal.changes[0] as PromptProposal["changes"][number]),
          hypothesis: "Edits to src/payroll/export.ts kept failing.",
        },
      ],
    };
    expect(
      await h.upstream.openLookbackPr({ replay: replay(), proposal: leaky }, h.ctx),
    ).toMatchObject({ status: "skipped", reason: "privacy" });
    expect(h.plumbing.pushes).toHaveLength(0);
  });

  it("skips without a bs-vtc checkout, and ignores any verdict but improve", async () => {
    const h = harness({ automation: { upstream: { repo: UPSTREAM, share: true } } });
    expect(await h.upstream.openLookbackPr({ replay: replay(), proposal }, h.ctx)).toMatchObject({
      status: "skipped",
      reason: "no_upstream_checkout",
    });
    expect(
      await h.upstream.openLookbackPr(
        { replay: replay({ verdict: "no_change" }), proposal },
        h.ctx,
      ),
    ).toEqual({
      status: "ignored",
    });
  });

  it("refuses a proposal that names the project", async () => {
    const h = harness();
    withCheckout(h);
    const leaky = { ...proposal, editable: "For Globex Industries payroll, plan the steps first." };
    expect(
      await h.upstream.openLookbackPr({ replay: replay(), proposal: leaky }, h.ctx),
    ).toMatchObject({
      status: "skipped",
      reason: "privacy",
    });
    expect(h.plumbing.pushes).toHaveLength(0);
    expect(h.github.state.prs).toHaveLength(0);
  });
});

describe("bs-vtc PRs caused by a project run", () => {
  it("record only the upstream-safe projection, whatever snapshot the caller passed", async () => {
    const probes: Record<string, number> = {};
    const inner = fakeRecorder();
    const recorder: EvidenceRecorder = {
      renderGateReport: (request) => inner.renderGateReport(request),
      capture: async (request) => {
        for (const path of ["/api/runs/R7/status", UPSTREAM_EVIDENCE_ROUTE]) {
          probes[path] = (await fetch(new URL(path, request.origin))).status;
        }
        expect(request.shots.every((s) => s.path.startsWith("/lookback/?evidence=upstream"))).toBe(
          true,
        );
        expect(request.denyText).toContain("payroll-portal");
        return inner.capture(request);
      },
    };
    const h = harness({ automation: { evidence: recorder, hosting: "attach" } });
    const fp = autoFingerprint({ kind: "config", subject: "max_rounds" });
    const outcome = await h.upstream.openPullRequest(
      {
        target: "upstream",
        kind: "config",
        fingerprint: fp,
        summary: "raise the review round cap",
        slots: { summary: "Raises the cap." },
        source: {
          changes: [{ path: "roles/x.yaml", bytes: new TextEncoder().encode("x") }],
          message: "cap",
        },
        report: projectUpstreamReport({
          kind: "config",
          fingerprint: fp,
          vtcVersion: "0.4.0",
          occurrences: 1,
          firstSeen: "2026-10-15T00:00:00Z",
          lastSeen: "2026-10-15T00:00:00Z",
        }),
        specVerifier: "none",
        evidence: {
          plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
          snapshot: {
            routes: { "/api/runs/R7/status": { title: "Payroll export" } },
            events: [{ run: "R7", seq: 1 }],
          },
        },
      },
      h.ctx,
    );
    expect(outcome).toMatchObject({ status: "pr" });
    expect(probes).toEqual({ "/api/runs/R7/status": 404, [UPSTREAM_EVIDENCE_ROUTE]: 200 });
  });
});

describe("no PR without evidence", () => {
  const prInput = {
    target: "project" as const,
    kind: "parked" as const,
    fingerprint: "0123456789abcdef",
    summary: "fix the parked export task",
    slots: { summary: "Fixes the export." },
    source: {
      changes: [{ path: "src/a.ts", bytes: new TextEncoder().encode("x") }],
      message: "fix",
    },
    specVerifier: "none" as const,
    evidence: {
      plan: { run: "R7", upstreamSafe: false, change: "non_ui" as const },
      snapshot: { routes: {}, events: [] },
      gateReport: {} as never,
    },
  };

  it("retries once, then opens no PR and raises 'evidence capture failed' upstream", async () => {
    const recorder = fakeRecorder({ failing: () => true });
    const h = harness({ automation: { evidence: recorder } });
    expect(await h.upstream.openPullRequest(prInput, h.ctx)).toMatchObject({
      status: "skipped",
      reason: "evidence_failed",
    });
    expect(recorder.requests).toHaveLength(2);
    expect(h.github.state.prs).toHaveLength(0);
    expect(h.plumbing.pushes).toHaveLength(0);
    const [issue] = h.github.state.issues;
    expect(issue?.repo).toBe(UPSTREAM);
    expect(issue?.title).toBe("vtc(defect): evidence.capture_failed in the engine");
    expect(types(h.events)).toEqual(["upstream.issue_opened", "automation.skipped"]);
  });

  it("opens no PR when no recorder is available", async () => {
    const h = harness({ noRecorder: true });
    expect(await h.upstream.openPullRequest(prInput, h.ctx)).toMatchObject({
      reason: "evidence_failed",
    });
    expect(h.github.state.prs).toHaveLength(0);
  });

  it("keeps an automatic run's PR draft until the Spec-Verifier passes", async () => {
    const h = harness({ automation: { hosting: "attach" } });
    const outcome = await h.upstream.openPullRequest(
      { ...prInput, specVerifier: "pending", issue: 3 },
      h.ctx,
    );
    expect(outcome).toMatchObject({ status: "pr", ready: false, evidence: "complete" });
    const [pr] = h.github.state.prs;
    expect(pr?.repo).toBe(PROJECT);
    expect(pr?.isDraft).toBe(true);
    expect(pr?.attached).toEqual(["01-replay.webm", "02-final-state.png", "03-gate-report.png"]);
    expect(pr?.body).toContain(
      "![Flow Studio replay of the run that produced this PR](01-replay.webm)",
    );
    expect(pr?.body).toContain("Closes #3");
    expect(
      await h.upstream.completePullRequest("project", pr?.number ?? 0, "fail", h.ctx),
    ).toMatchObject({ ready: false });
    expect(
      await h.upstream.completePullRequest("project", pr?.number ?? 0, "pass", h.ctx),
    ).toMatchObject({ ready: true });
    expect(h.github.state.prs[0]?.isDraft).toBe(false);
  });

  it("caps open automatic PRs per kind", async () => {
    const h = harness({ automation: { hosting: "attach" } });
    for (const fp of ["1111111111111111", "2222222222222222", "3333333333333333"]) {
      expect(
        await h.upstream.openPullRequest({ ...prInput, fingerprint: fp }, h.ctx),
      ).toMatchObject({ status: "pr" });
    }
    expect(
      await h.upstream.openPullRequest({ ...prInput, fingerprint: "4444444444444444" }, h.ctx),
    ).toMatchObject({
      status: "skipped",
      reason: "rate_limit",
    });
  });
});

describe("the remote is the source of truth, across installations", () => {
  it("another machine reopens an issue VTC's quiet sweep closed (no ledger there)", async () => {
    const first = harness();
    await first.upstream.report(defect(), first.ctx);
    await first.upstream.report(defect(), first.ctx);
    first.clock.now = new Date("2026-11-02T12:00:00Z");
    expect(await first.upstream.sweep(first.ctx)).toEqual([
      expect.objectContaining({ action: "closed", number: 1 }),
    ]);
    const other = harness({ shared: first });
    other.clock.now = new Date("2026-11-03T12:00:00Z");
    await other.upstream.report(defect({ at: "2026-11-03T11:00:00Z" }), other.ctx);
    expect(
      await other.upstream.report(defect({ at: "2026-11-03T11:00:00Z" }), other.ctx),
    ).toMatchObject({ status: "issue", action: "reopened", number: 1 });
    // A human's not-planned close stays muted for every installation.
    first.github.human(1, { close: "not_planned" });
    expect(
      await harness({ shared: first }).upstream.raise(
        {
          target: "upstream",
          kind: "defect",
          fingerprint: first.github.state.issues[0]?.marker?.fp ?? "",
          minOccurrences: 1,
          facts: {
            kind: "defect",
            fingerprint: first.github.state.issues[0]?.marker?.fp ?? "",
            vtcVersion: "0.4.0",
            errorClass: "adapter.parse_failure",
          },
          at: "2026-11-03T11:00:00Z",
        },
        first.ctx,
      ),
    ).toMatchObject({ status: "skipped", reason: "muted" });
  });

  it("counts the five-a-day cap from the remote, so installations share it", async () => {
    const first = harness();
    const second = harness({ shared: first });
    const advisory = (n: number): AutomationFact => ({
      type: "security_advisory",
      advisoryId: `GHSA-000${String(n)}`,
      package: "yaml",
      at: "2026-10-15T11:00:00Z",
    });
    for (const n of [1, 2, 3]) await first.upstream.report(advisory(n), first.ctx);
    expect(await second.upstream.report(advisory(4), second.ctx)).toMatchObject({
      status: "issue",
    });
    expect(await second.upstream.report(advisory(5), second.ctx)).toMatchObject({
      status: "issue",
    });
    expect(await second.upstream.report(advisory(6), second.ctx)).toMatchObject({
      status: "skipped",
      reason: "rate_limit",
    });
    expect(first.github.state.issues).toHaveLength(5);
  });

  it("never closes as quiet an issue another installation keeps seeing", async () => {
    const first = harness();
    await first.upstream.report(defect(), first.ctx);
    await first.upstream.report(defect(), first.ctx);
    const second = harness({ shared: first });
    second.clock.now = new Date("2026-10-29T12:00:00Z");
    await second.upstream.report(defect({ at: "2026-10-29T11:00:00Z" }), second.ctx);
    expect(
      await second.upstream.report(defect({ at: "2026-10-29T11:00:00Z" }), second.ctx),
    ).toMatchObject({ status: "issue", number: 1 });
    expect(first.github.state.issues[0]?.humanActivity).toBe(false);
    // 18 days after the first installation last saw it, 4 after the second did.
    first.clock.now = new Date("2026-11-02T12:00:00Z");
    expect(await first.upstream.sweep(first.ctx)).toEqual([]);
    expect(await second.upstream.sweep(second.ctx)).toEqual([]);
    expect(first.github.state.issues[0]?.state).toBe("open");
  });

  it("serialises two daemons on one machine: one issue for one fingerprint", async () => {
    const first = harness();
    const second = harness({ shared: first, sameHome: true });
    const fact: AutomationFact = {
      type: "security_advisory",
      advisoryId: "GHSA-9",
      package: "yaml",
      at: "2026-10-15T11:00:00Z",
    };
    const outcomes = await Promise.all([
      first.upstream.report(fact, first.ctx),
      second.upstream.report(fact, second.ctx),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["issue", "skipped"]);
    expect(first.github.state.issues).toHaveLength(1);
  });
});

describe("what leaves for the upstream repo", () => {
  const fp = autoFingerprint({ kind: "config", subject: "max_rounds" });
  const input = (over: Partial<AutoPrInput> = {}): AutoPrInput => ({
    target: "upstream",
    kind: "config",
    fingerprint: fp,
    summary: "raise the review round cap",
    slots: { summary: "Raises the cap." },
    source: {
      changes: [{ path: "roles/x.yaml", bytes: new TextEncoder().encode("max_rounds: 4\n") }],
      message: "cap",
    },
    report: projectUpstreamReport({
      kind: "config",
      fingerprint: fp,
      vtcVersion: "0.4.0",
      occurrences: 1,
      firstSeen: "2026-10-15T00:00:00Z",
      lastSeen: "2026-10-15T00:00:00Z",
    }),
    specVerifier: "none",
    evidence: {
      plan: { upstreamSafe: true, change: "non_ui" },
      snapshot: { routes: {}, events: [] },
      gateReport: {} as never,
    },
    ...over,
  });

  it("checks every committed file and the model's text before anything is pushed", async () => {
    const h = harness({ automation: { hosting: "attach" } });
    expect(await h.upstream.openPullRequest(input(), h.ctx)).toMatchObject({ status: "pr" });
    const leakyFile = input({
      fingerprint: "1111111111111111",
      source: {
        changes: [
          { path: "roles/x.yaml", bytes: new TextEncoder().encode("# for Globex Industries\n") },
        ],
        message: "cap",
      },
    });
    expect(await h.upstream.openPullRequest(leakyFile, h.ctx)).toMatchObject({
      status: "skipped",
      reason: "privacy",
    });
    const leakyText = input({
      fingerprint: "2222222222222222",
      slots: { summary: "Needed for app/services/payslip.rb." },
    });
    expect(await h.upstream.openPullRequest(leakyText, h.ctx)).toMatchObject({
      status: "skipped",
      reason: "privacy",
    });
    expect(h.plumbing.pushes).toHaveLength(1);
  });

  it("re-checks the opt-outs right before each push: nothing leaves once sharing is off", async () => {
    const inner = fakeRecorder();
    const during = { capture: (): void => undefined };
    const recorder: EvidenceRecorder = {
      renderGateReport: (request) => inner.renderGateReport(request),
      capture: (request) => {
        during.capture();
        return inner.capture(request);
      },
    };
    const h = harness({ automation: { evidence: recorder } });
    during.capture = () => {
      h.setShare(false);
    };
    expect(await h.upstream.openPullRequest(input(), h.ctx)).toMatchObject({
      status: "skipped",
      reason: "share_off",
    });
    expect(h.plumbing.pushes).toHaveLength(0);
    expect(h.github.state.prs).toHaveLength(0);
  });
});

describe("evidence settings and the GIF", () => {
  const prInput = (over: Partial<AutoPrInput> = {}): AutoPrInput => ({
    target: "project",
    kind: "parked",
    fingerprint: "0123456789abcdef",
    summary: "fix the parked export task",
    slots: { summary: "Fixes the export." },
    source: {
      changes: [{ path: "src/a.ts", bytes: new TextEncoder().encode("x") }],
      message: "fix",
    },
    specVerifier: "pending",
    evidence: {
      plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
      snapshot: { routes: {}, events: [] },
      gateReport: {} as never,
    },
    ...over,
  });

  it("drops recordings when the project turns video off, and keeps to its max_mb", async () => {
    const h = harness({ automation: { hosting: "attach" }, evidence: { video: false } });
    expect(await h.upstream.openPullRequest(prInput(), h.ctx)).toMatchObject({
      status: "pr",
      evidence: "partial",
    });
    expect(h.github.state.prs[0]?.attached).toEqual(["01-final-state.png", "02-gate-report.png"]);
    expect(h.github.state.prs[0]?.labels).toContain("evidence: partial");
    const small = harness({ automation: { hosting: "attach" }, evidence: { maxBytes: 2500 } });
    expect(await small.upstream.openPullRequest(prInput(), small.ctx)).toMatchObject({
      status: "pr",
      evidence: "partial",
    });
    expect(small.github.state.prs[0]?.attached).toHaveLength(2);
  });

  it("keeps a branch an automatic run pushed draft unless the Spec Verifier passed", async () => {
    const h = harness({ automation: { hosting: "attach" } });
    expect(
      await h.upstream.openPullRequest(
        prInput({ source: { pushedHead: "7".repeat(40) }, specVerifier: "none" }),
        h.ctx,
      ),
    ).toMatchObject({ status: "pr", ready: false });
    expect(h.github.state.prs[0]?.isDraft).toBe(true);
  });

  it("makes the GIF with the ffmpeg on PATH when automation.ffmpeg is on (branch hosting)", async () => {
    const bin = tempDir("vtc-ffmpeg-");
    writeFileSync(
      join(bin, "ffmpeg"),
      '#!/bin/sh\nfor last in "$@"; do :; done\nprintf gif > "$last"\n',
    );
    chmodSync(join(bin, "ffmpeg"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    try {
      const h = harness({ automation: { ffmpeg: true } });
      expect(await h.upstream.openPullRequest(prInput(), h.ctx)).toMatchObject({
        status: "pr",
        evidence: "complete",
      });
      expect(h.github.state.prs[0]?.body).toContain("replay-preview.gif");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("opens no PR, and raises no 'evidence capture failed', when the shared evidence branch refuses the push", async () => {
    const h = harness();
    h.plumbing.remote.set("refs/heads/vtc-evidence", "9".repeat(40));
    expect(await h.upstream.openPullRequest(prInput(), h.ctx)).toMatchObject({
      status: "skipped",
      reason: "evidence_failed",
    });
    expect(h.github.state.prs).toHaveLength(0);
    expect(h.github.state.issues).toHaveLength(0);
  });

  it("fetches the evidence branch another installation pushed, so its PR opens", async () => {
    const first = harness({ remoteRefs: true });
    expect(await first.upstream.openPullRequest(prInput(), first.ctx)).toMatchObject({
      status: "pr",
    });
    const second = harness({ shared: first, clone: true, remoteRefs: true });
    expect(
      await second.upstream.openPullRequest(
        prInput({ fingerprint: "fedcba9876543210" }),
        second.ctx,
      ),
    ).toMatchObject({ status: "pr" });
    expect(first.github.state.issues).toHaveLength(0);
  });
});

describe("project-repo PRs", () => {
  const TOKEN = `ghp_${"a".repeat(36)}`;
  const input = (over: Partial<AutoPrInput> = {}): AutoPrInput => ({
    target: "project",
    kind: "parked",
    fingerprint: "0123456789abcdef",
    summary: "fix key sk-live-payroll-SECRET-1234",
    slots: {
      summary: `The key sk-live-payroll-SECRET-1234 and ${TOKEN} were rejected.`,
      diff: `+API_KEY=${TOKEN}`,
      provenance: "run R7, key sk-live-payroll-SECRET-1234",
    },
    source: {
      changes: [{ path: "src/a.ts", bytes: new TextEncoder().encode("x") }],
      message: "fix",
    },
    specVerifier: "pending",
    evidence: {
      plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
      snapshot: { routes: {}, events: [] },
      gateReport: {} as never,
    },
    ...over,
  });

  it("pass the shared redaction: no known value or token in the title, body or commit", async () => {
    const h = harness({ automation: { hosting: "attach" } });
    expect(await h.upstream.openPullRequest(input(), h.ctx)).toMatchObject({ status: "pr" });
    const [pr] = h.github.state.prs;
    const commit = h.plumbing.commits.at(-1);
    for (const text of [pr?.title, pr?.body, commit?.message]) {
      expect(text).toBeDefined();
      expect(text).not.toContain("SECRET-1234");
      expect(text).not.toContain("ghp_aaaa");
    }
    expect(pr?.title).toBe("vtc(parked): fix key [REDACTED:known_value]");
    expect(pr?.body).toContain("[REDACTED:github_token]");
    // Project details stay: the PR is for the project's own repo.
    expect(pr?.body).toContain("were rejected");
  });

  it("opens no PR for a fingerprint a human muted", async () => {
    const h = harness({ automation: { hosting: "attach" } });
    await h.upstream.report(
      {
        type: "project_problem",
        kind: "parked",
        ruleId: "task.parked",
        path: "src/payroll/export.ts",
        title: "Payroll export task is parked",
        detail: "T-4 parked",
        run: "R7",
        at: "2026-10-15T11:00:00Z",
      },
      h.ctx,
    );
    const [issue] = h.github.state.issues;
    const fp = issue?.marker?.fp ?? "";
    expect(fp).not.toBe("");
    h.github.human(issue?.number ?? 0, { label: "vtc:muted" });
    expect(await h.upstream.openPullRequest(input({ fingerprint: fp }), h.ctx)).toMatchObject({
      status: "skipped",
      reason: "muted",
    });
    expect(h.github.state.prs).toHaveLength(0);
    expect(h.plumbing.pushes).toHaveLength(0);
  });

  it("keeps the project's ledger in the engine's guard dir, never in the checkout", async () => {
    const h = harness({ automation: { hosting: "attach" } });
    expect(await h.upstream.openPullRequest(input(), h.ctx)).toMatchObject({ status: "pr" });
    expect(existsSync(join(h.ctx.repoRoot, ".vtc", "state"))).toBe(false);
  });

  it("keeps VTC's own ledger and locks under <vtcHome>/guard/, which no role may write", async () => {
    const h = harness();
    await h.upstream.report(defect(), h.ctx);
    expect(await h.upstream.report(defect(), h.ctx)).toMatchObject({ status: "issue" });
    const state = upstreamStateDir(h.vtcHome);
    expect(relative(h.vtcHome, state).split(sep)[0]).toBe("guard");
    expect(ROLE_DENIED_VTC.homeWriteDeny).toContain("guard/**");
    expect(existsSync(join(state, "ledger.jsonl"))).toBe(true);
    expect(existsSync(join(state, "locks"))).toBe(true);
    expect(existsSync(join(h.vtcHome, "upstream"))).toBe(false);
  });
});

describe("VTC builds VTC (the project is bs-vtc itself)", () => {
  it("records its own run, and bs-vtc's own name is no project secret; the home path still is", async () => {
    let request: Parameters<EvidenceRecorder["capture"]>[0] | undefined;
    const inner = fakeRecorder();
    const recorder: EvidenceRecorder = {
      renderGateReport: (r) => inner.renderGateReport(r),
      capture: (r) => {
        request = r;
        return inner.capture(r);
      },
    };
    const h = harness({ automation: { evidence: recorder, hosting: "attach" } });
    const ctx: ProjectContext = {
      ...h.ctx,
      repoRoot: h.checkout,
      repo: UPSTREAM,
      identity: {
        repo: UPSTREAM,
        remoteUrl: `git@github.com:${UPSTREAM}.git`,
        repoRoot: "/Users/bason/Documents/bason-labs/bs-vtc",
        homeDir: "/Users/bason",
      },
    };
    const fp = autoFingerprint({ kind: "config", subject: "max_rounds" });
    const outcome = await h.upstream.openPullRequest(
      {
        target: "upstream",
        kind: "config",
        fingerprint: fp,
        summary: "raise the bs-vtc review round cap",
        slots: { summary: "The bs-vtc run on bason-labs hit the cap." },
        source: {
          changes: [{ path: "roles/x.yaml", bytes: new TextEncoder().encode("max_rounds: 4\n") }],
          message: "cap",
        },
        report: projectUpstreamReport({
          kind: "config",
          fingerprint: fp,
          vtcVersion: "0.4.0",
          occurrences: 1,
          firstSeen: "2026-10-15T00:00:00Z",
          lastSeen: "2026-10-15T00:00:00Z",
        }),
        specVerifier: "none",
        evidence: {
          plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
          snapshot: {
            routes: { "/api/runs/R7/status": { title: "bs-vtc engine" } },
            events: [{ run: "R7", seq: 1 }],
          },
          gateReport: {} as never,
        },
      },
      ctx,
    );
    expect(outcome).toMatchObject({ status: "pr" });
    expect(request?.shots.some((s) => s.path.startsWith("/lookback/?evidence=upstream"))).toBe(
      false,
    );
    expect(request?.denyText).not.toContain("bs-vtc");
    expect(request?.denyText).not.toContain("bason-labs");
    expect(request?.denyText).toContain("/Users/bason");
    expect(request?.denyText).toContain("sk-live-payroll-SECRET-1234");
    expect(h.github.state.prs[0]?.title).toBe("vtc(config): raise the bs-vtc review round cap");
    // The home path still fails closed.
    expect(
      await h.upstream.openPullRequest(
        {
          target: "upstream",
          kind: "config",
          fingerprint: "1111111111111111",
          summary: "see /Users/bason/notes",
          slots: {},
          source: { changes: [], message: "x" },
          report: projectUpstreamReport({
            kind: "config",
            fingerprint: "1111111111111111",
            vtcVersion: "0.4.0",
            occurrences: 1,
            firstSeen: "2026-10-15T00:00:00Z",
            lastSeen: "2026-10-15T00:00:00Z",
          }),
          specVerifier: "none",
          evidence: {
            plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
            snapshot: { routes: {}, events: [] },
            gateReport: {} as never,
          },
        },
        ctx,
      ),
    ).toMatchObject({ status: "skipped", reason: "privacy" });
  });
});
