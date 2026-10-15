/** The upstream module end to end with in-memory fakes (AD-27; D-cc: no real gh, git or GitHub). */
import {
  type AutomationRunRef,
  type StartInput,
  effectivePromptSha,
  engineerProfileLockedSection,
  splitRolePrompt,
  type EvidenceRecorder,
  type PromptProposal,
  type ReplayResult,
  ROLE_DENIED_VTC,
} from "@vtc/shared";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoFingerprint,
  projectUpstreamReport,
  UPSTREAM_EVIDENCE_RUN,
  UPSTREAM_REPLAY_PATH,
  upstreamStateDir,
  type AutomationFact,
  type AutoPrInput,
  type ProjectContext,
} from "../../src/upstream/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { fakeRecorder } from "./fakes.js";
import { BASE_SHA, defect, harness, PROJECT, types, UPSTREAM, type Harness } from "./harness.js";

afterEach(cleanupDirs);

describe("raising upstream issues", () => {
  it("records a first defect occurrence and raises the issue when it recurs", async () => {
    const h = harness();
    expect(await h.upstream.report(defect(), h.ctx)).toMatchObject({ status: "recorded" });
    const opened = await h.upstream.report(defect(), h.ctx);
    expect(opened).toMatchObject({ status: "issue", action: "opened" });
    const [issue] = h.github.state.issues;
    expect(issue?.repo).toBe(UPSTREAM);
    // its VTC frame locates it: VTC fixes it itself on the bs-vtc checkout (reading 216)
    expect(issue?.labels).toEqual(["vtc:auto", "vtc:kind/defect", "vtc:fixable"]);
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
      "vtc:fixable",
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
    const fact = defect({ mode: "globex-tuned" });
    await h.upstream.report(fact, h.ctx);
    expect(await h.upstream.report(fact, h.ctx)).toMatchObject({
      status: "skipped",
      reason: "privacy",
    });
    expect(h.github.state.issues).toHaveLength(0);
    const skip = h.events.find((e) => e.type === "automation.skipped");
    expect(JSON.stringify(skip)).not.toMatch(/globex|SECRET/i);
  });

  it("sends a model id that is not public as custom: an inference-profile ARN's account id never leaves", async () => {
    const h = harness();
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
    const fact = defect({ errorClass: "engine.crash", model: arn });
    await h.upstream.report(fact, h.ctx);
    expect(await h.upstream.report(fact, h.ctx)).toMatchObject({ status: "issue" });
    const body = JSON.stringify(h.github.state.issues);
    expect(body).not.toMatch(/123456789012|arn:aws/);
    expect(body).toMatch(/custom/);
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

describe("a fixable issue becomes an automatic run (D-bv, D-cd; AD-27 rule 2)", () => {
  type Started = { input: StartInput; ref: AutomationRunRef };
  const recorder = () => {
    const runs: Started[] = [];
    return {
      runs,
      startRun: (input: StartInput, ref: AutomationRunRef): Promise<void> => {
        runs.push({ input, ref });
        return Promise.resolve();
      },
    };
  };
  const problem = (
    over: Partial<Extract<AutomationFact, { type: "project_problem" }>> = {},
  ): AutomationFact => ({
    type: "project_problem",
    kind: "ci_failure",
    ruleId: `post_merge_ci/${"a".repeat(40)}`,
    title: "Required checks red after merge aaaaaaaaaaaa",
    detail: "the required checks on the base are red after merge aaaaaaaaaaaa",
    run: "R7",
    at: "2026-10-15T11:00:00Z",
    ...over,
  });

  it("starts the run for a fixable project issue once it opens, with the issue as its spec", async () => {
    const started = recorder();
    const h = harness({ startRun: started.startRun });
    const outcome = await h.upstream.report(problem(), h.ctx);
    expect(outcome).toMatchObject({ status: "issue", action: "opened", number: 1 });
    expect(started.runs).toHaveLength(1);
    const [run] = started.runs;
    expect(run?.ref).toEqual({
      kind: "ci_failure",
      fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) as string,
      target: { kind: "project", repo: PROJECT },
      issue: 1,
    });
    expect(run?.input).toMatchObject({ track: "quick_fix", repo: "existing", risk_hints: [] });
    expect(run?.input.request).toContain(`${PROJECT}#1`);
    expect(run?.input.request).toContain("Required checks red after merge");
    // seen again: a comment on the open issue, never a second run
    h.clock.now = new Date("2026-10-16T13:00:00Z");
    expect(await h.upstream.report(problem(), h.ctx)).toMatchObject({ status: "issue" });
    expect(started.runs).toHaveLength(1);
  });

  it("starts none for a parked task (VTC could not resolve it), nor while automation.prs is off", async () => {
    const started = recorder();
    const h = harness({ startRun: started.startRun });
    await h.upstream.report(problem({ kind: "parked", ruleId: "parked/stuck/R7/T-4" }), h.ctx);
    expect(started.runs).toEqual([]);
    const off = harness({ startRun: started.startRun });
    const ctx: ProjectContext = {
      ...off.ctx,
      state: () => {
        const now = off.ctx.state();
        return { ...now, settings: { ...now.settings, prs: false } };
      },
    };
    expect(await off.upstream.report(problem(), ctx)).toMatchObject({ status: "issue" });
    expect(started.runs).toEqual([]);
  });

  it("an upstream item starts a run only on the bs-vtc checkout itself (VTC builds VTC)", async () => {
    const advisory: AutomationFact = {
      type: "security_advisory",
      advisoryId: "GHSA-aaaa-bbbb-cccc",
      package: "zod",
      at: "2026-10-15T11:00:00Z",
    };
    const elsewhere = recorder();
    const project = harness({ startRun: elsewhere.startRun });
    expect(await project.upstream.report(advisory, project.ctx)).toMatchObject({
      status: "issue",
    });
    // the issue is in bs-vtc; this project's engine cannot build bs-vtc
    expect(elsewhere.runs).toEqual([]);
    const self = recorder();
    const own = harness({ startRun: self.startRun, self: true });
    expect(await own.upstream.report(advisory, own.ctx)).toMatchObject({ status: "issue" });
    expect(self.runs.map((r) => r.ref.target)).toEqual([{ kind: "upstream", repo: UPSTREAM }]);
    expect(self.runs[0]?.input.request).toContain("GHSA-aaaa-bbbb-cccc");
  });
});

describe("VTC builds VTC: which engine starts the fix run (reading 216)", () => {
  type Started = { input: StartInput; ref: AutomationRunRef };
  const recorder = () => {
    const runs: Started[] = [];
    return {
      runs,
      startRun: (input: StartInput, ref: AutomationRunRef): Promise<void> => {
        runs.push({ input, ref });
        return Promise.resolve();
      },
    };
  };
  /** A crash as engine core records it: the VTC frames only, root-relative. */
  const crash = (over: Partial<Extract<AutomationFact, { type: "vtc_defect" }>> = {}) =>
    defect({
      errorClass: "incident.crash",
      role: undefined,
      host: undefined,
      model: undefined,
      stack: "    at Engine.spawn (packages/engine/src/core/engine.ts:900:11)",
      ...over,
    });
  const advisory: AutomationFact = {
    type: "security_advisory",
    advisoryId: "GHSA-aaaa-bbbb-cccc",
    package: "zod",
    at: "2026-10-15T11:00:00Z",
  };

  it("a crash's VTC frames make its defect fixable: labelled, and fixed on the checkout", async () => {
    const self = recorder();
    const own = harness({ startRun: self.startRun, self: true });
    await own.upstream.report(crash(), own.ctx);
    expect(await own.upstream.report(crash(), own.ctx)).toMatchObject({
      status: "issue",
      action: "opened",
    });
    expect(own.github.state.issues[0]?.labels).toEqual([
      "vtc:auto",
      "vtc:kind/defect",
      "vtc:fixable",
    ]);
    expect(own.github.state.issues[0]?.body).toContain("engine/core/engine:Engine.spawn");
    expect(self.runs.map((r) => r.ref.kind)).toEqual(["defect"]);
    // a defect with no VTC frame cannot be located: an issue, no label, no run
    const other = recorder();
    const h = harness({ startRun: other.startRun, self: true });
    await h.upstream.report(
      crash({ stack: undefined, errorClass: "adapter.parse_failure" }),
      h.ctx,
    );
    await h.upstream.report(
      crash({ stack: undefined, errorClass: "adapter.parse_failure" }),
      h.ctx,
    );
    expect(h.github.state.issues[0]?.labels).toEqual(["vtc:auto", "vtc:kind/defect"]);
    expect(other.runs).toEqual([]);
  });

  it("starts no upstream run on a clone that is not the configured checkout, or with none set", async () => {
    const started = recorder();
    // the remote is bs-vtc, but the run would build in another clone than the PR's checkout
    const clone = harness({ startRun: started.startRun });
    const ctx: ProjectContext = { ...clone.ctx, repo: UPSTREAM };
    expect(await clone.upstream.report(advisory, ctx)).toMatchObject({ status: "issue" });
    const unset = harness({
      startRun: started.startRun,
      automation: { upstream: { repo: UPSTREAM, share: true } },
    });
    expect(await unset.upstream.report(advisory, { ...unset.ctx, repo: UPSTREAM })).toMatchObject({
      status: "issue",
    });
    expect(started.runs).toEqual([]);
  });

  it("knows the checkout by its real path, whatever its spelling", async () => {
    for (const spelling of ["link", "slash"] as const) {
      const started = recorder();
      const h = harness({ startRun: started.startRun, self: true });
      const repoRoot =
        spelling === "slash"
          ? `${h.checkout}/`
          : ((): string => {
              const link = join(tempDir("vtc-link-"), "bs-vtc");
              symlinkSync(h.checkout, link);
              return link;
            })();
      expect(await h.upstream.report(advisory, { ...h.ctx, repoRoot })).toMatchObject({
        status: "issue",
      });
      expect(started.runs).toHaveLength(1);
    }
  });

  it("a PR built on the checkout under another spelling records the run's own replay", async () => {
    let request: Parameters<EvidenceRecorder["capture"]>[0] | undefined;
    const inner = fakeRecorder();
    const recorder: EvidenceRecorder = {
      renderGateReport: (r) => inner.renderGateReport(r),
      capture: (r) => {
        request = r;
        return inner.capture(r);
      },
    };
    const h = harness({ automation: { evidence: recorder, hosting: "attach" }, self: true });
    const fp = autoFingerprint({
      kind: "security",
      advisoryId: "GHSA-aaaa-bbbb-cccc",
      package: "zod",
    });
    const outcome = await h.upstream.openPullRequest(
      {
        target: "upstream",
        kind: "security",
        fingerprint: fp,
        summary: "bump zod",
        slots: { summary: "Bumps zod." },
        source: { pushedHead: "7".repeat(40) },
        report: projectUpstreamReport({
          kind: "security",
          fingerprint: fp,
          vtcVersion: "0.4.0",
          occurrences: 1,
          firstSeen: "2026-10-15T00:00:00Z",
          lastSeen: "2026-10-15T00:00:00Z",
        }),
        specVerifier: "pass",
        evidence: {
          plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
          snapshot: { routes: { "/api/runs/R7/status": { title: "bump" } }, events: [] },
          gateReport: {} as never,
        },
      },
      { ...h.ctx, repoRoot: `${h.checkout}/` },
    );
    expect(outcome).toMatchObject({ status: "pr", evidence: "complete" });
    expect(request?.shots.some((s) => s.path.includes(UPSTREAM_EVIDENCE_RUN))).toBe(false);
    expect(request?.shots.some((s) => s.path.includes("run=R7"))).toBe(true);
  });

  it("the checkout's engine picks up the fixable issues another project's daemon opened", async () => {
    const project = harness();
    await project.upstream.report(crash(), project.ctx);
    await project.upstream.report(crash(), project.ctx);
    await project.upstream.report(advisory, project.ctx);
    // not fixable: no VTC frame
    await project.upstream.report(
      crash({ stack: undefined, errorClass: "engine.stuck_loop" }),
      project.ctx,
    );
    await project.upstream.report(
      crash({ stack: undefined, errorClass: "engine.stuck_loop" }),
      project.ctx,
    );
    expect(project.github.state.issues.map((i) => i.number)).toEqual([1, 2, 3]);
    // a project's engine cannot build bs-vtc: it picks up nothing
    const nobody = recorder();
    const elsewhere = harness({ shared: project, startRun: nobody.startRun });
    expect(await elsewhere.upstream.pickup(elsewhere.ctx)).toEqual([]);
    expect(nobody.runs).toEqual([]);

    const self = recorder();
    const own = harness({ shared: project, clone: true, self: true, startRun: self.startRun });
    const asked = await own.upstream.pickup(own.ctx);
    expect(asked.map((r) => [r.kind, r.issue])).toEqual([
      ["defect", 1],
      ["security", 2],
    ]);
    expect(self.runs.map((r) => r.ref.target)).toEqual([
      { kind: "upstream", repo: UPSTREAM },
      { kind: "upstream", repo: UPSTREAM },
    ]);
    // the issue is the spec: its title and body, as the project's daemon wrote them
    expect(self.runs[0]?.input.request).toContain(`${UPSTREAM}#1`);
    expect(self.runs[0]?.input.request).toContain("engine/core/engine:Engine.spawn");
    expect(self.runs[1]?.input.request).toContain("GHSA-aaaa-bbbb-cccc");
    expect(self.runs[0]?.input).toMatchObject({ track: "quick_fix", repo: "existing" });
  });

  it("picks up no issue a human muted or closed, none with an open PR, and none while off", async () => {
    const project = harness();
    await project.upstream.report(advisory, project.ctx);
    await project.upstream.report(
      { ...advisory, advisoryId: "GHSA-dddd-eeee-ffff", package: "vite" },
      project.ctx,
    );
    await project.upstream.report(
      { ...advisory, advisoryId: "GHSA-gggg-hhhh-iiii", package: "react" },
      project.ctx,
    );
    project.github.human(1, { label: "vtc:muted" });
    project.github.human(2, { close: "completed" });
    const self = recorder();
    const own = harness({ shared: project, clone: true, self: true, startRun: self.startRun });
    const third = project.github.state.issues.find((i) => i.number === 3);
    const fp = third?.marker?.fp ?? "";
    // a PR already answers #3 (another installation's run)
    project.github.state.prs.push({
      number: 9,
      url: "https://github.com/bason-labs/bs-vtc/pull/9",
      headRefName: `vtc/auto/security/${fp.slice(0, 8)}`,
      headSha: "9".repeat(40),
      isDraft: true,
      state: "open",
      labels: ["vtc:auto", "vtc:kind/security"],
      marker: { v: 1, kind: "security", fp },
      title: "vtc(security): bump react",
      body: "",
      base: "main",
      repo: UPSTREAM,
      attached: [],
      comments: [],
      branchDeleted: false,
    });
    expect(await own.upstream.pickup(own.ctx)).toEqual([]);
    project.github.state.prs = [];
    own.setContext({ paused: true });
    expect(await own.upstream.pickup(own.ctx)).toEqual([]);
    own.setContext({ paused: false });
    const off: ProjectContext = {
      ...own.ctx,
      state: () => {
        const now = own.ctx.state();
        return { ...now, settings: { ...now.settings, prs: false } };
      },
    };
    expect(await own.upstream.pickup(off)).toEqual([]);
    expect(self.runs).toEqual([]);
    expect((await own.upstream.pickup(own.ctx)).map((r) => r.issue)).toEqual([3]);
  });

  it("on the checkout, a recurrence of an open fixable issue asks for its run too", async () => {
    const project = harness();
    await project.upstream.report(advisory, project.ctx);
    const self = recorder();
    const own = harness({ shared: project, clone: true, self: true, startRun: self.startRun });
    own.clock.now = new Date("2026-10-16T13:00:00Z");
    expect(await own.upstream.report(advisory, own.ctx)).toMatchObject({
      status: "issue",
      number: 1,
    });
    expect(self.runs.map((r) => r.ref.issue)).toEqual([1]);
  });

  it("points a new agent's run at the role scaffold", async () => {
    const self = recorder();
    const own = harness({ startRun: self.startRun, self: true });
    const outcome = await own.upstream.report(
      {
        type: "improvement",
        kind: "new_agent",
        subject: "engineer_ml",
        role: "engineer_ml",
        metrics: { failures: 4 },
        at: "2026-10-15T11:00:00Z",
      },
      own.ctx,
    );
    expect(outcome).toMatchObject({ status: "issue", action: "opened" });
    expect(self.runs[0]?.input.request).toContain("scaffoldRole");
  });
});

const PROMPT = `<!-- vtc:locked -->
# Implementer

Locked core: never touch files outside the task's scope.

<!-- vtc:editable -->
Prefer small commits.
Run the tests before you finish.
`;

/** The prompt identity Lookback measured: `PROMPT`'s sections, as the replay's baseline. */
const PROMPT_SHA = ((): string => {
  const split = splitRolePrompt(PROMPT);
  if (!split.ok) throw new Error("PROMPT does not split");
  return effectivePromptSha(split.locked, split.editable);
})();

const replay = (over: Partial<ReplayResult> = {}): ReplayResult => ({
  v: 1,
  proposal: "implementer-steps",
  role: "implementer",
  host: "codex",
  baseline: PROMPT_SHA,
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
    effective_sha256: PROMPT_SHA,
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

  it("records the Lookback view of the upstream-safe snapshot: the replay and the role's scorecards, never the project's run (reading 212(3))", async () => {
    const seen: { paths: string[]; status: Record<string, number> } = { paths: [], status: {} };
    const inner = fakeRecorder();
    const recorder: EvidenceRecorder = {
      renderGateReport: (request) => inner.renderGateReport(request),
      capture: async (request) => {
        seen.paths = [...new Set(request.shots.map((s) => s.path))];
        for (const rel of [UPSTREAM_REPLAY_PATH, ".vtc/lookback/scorecards/index.json"]) {
          const url = `/api/runs/${UPSTREAM_EVIDENCE_RUN}/artifacts?${new URLSearchParams({ path: rel }).toString()}`;
          seen.status[rel] = (await fetch(new URL(url, request.origin))).status;
        }
        return inner.capture(request);
      },
    };
    const h = harness({ automation: { evidence: recorder } });
    withCheckout(h);
    const card = {
      v: 1 as const,
      prompt: {
        role: "implementer",
        host: "codex" as const,
        locked_sha256: "1".repeat(64),
        editable_sha256: "2".repeat(64),
        effective_sha256: PROMPT_SHA,
      },
      grader_bundle_sha: "c".repeat(64),
      window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" },
      metrics: { tokens_per_success: { value: 41000, ci_low: null, ci_high: null, n: 15 } },
      breakdown: [],
      written_at: "2026-10-14T00:00:00.000Z",
    };
    expect(
      await h.upstream.openLookbackPr({ replay: replay(), proposal, scorecards: [card] }, h.ctx),
    ).toMatchObject({ status: "pr" });
    expect(seen.paths).toEqual([`/lookback/?run=${UPSTREAM_EVIDENCE_RUN}&evidence=upstream`]);
    expect(seen.status).toEqual({
      [UPSTREAM_REPLAY_PATH]: 200,
      ".vtc/lookback/scorecards/index.json": 200,
    });
  });

  it("opens no PR when the default branch's prompt is not the replay's baseline: its diff would revert a merged change (stale_baseline)", async () => {
    const h = harness();
    withCheckout(h);
    // a later Lookback PR of the role merged meanwhile: the editable section moved on
    h.files.set(
      "roles/implementer/prompt.md",
      PROMPT.replace("Prefer small commits.", "Prefer small, reviewed commits."),
    );
    expect(await h.upstream.openLookbackPr({ replay: replay(), proposal }, h.ctx)).toMatchObject({
      status: "skipped",
      reason: "stale_baseline",
    });
    expect(h.github.state.prs).toHaveLength(0);
    expect(h.plumbing.commits).toHaveLength(0);
    expect(h.events).toEqual([
      expect.objectContaining({
        type: "automation.skipped",
        payload: expect.objectContaining({ reason: "stale_baseline", kind: "lookback" }) as object,
      }),
    ]);
  });

  it("measures an engineer profile's baseline as Lookback does: the Engineer's whole prompt opens its locked section", async () => {
    const h = harness();
    const ENGINEER =
      "<!-- vtc:locked -->\n# Engineer\n\nShared contract.\n\n<!-- vtc:editable -->\nTest first.\n";
    const PROFILE =
      "<!-- vtc:locked -->\n# Backend\n\nContract-first endpoints.\n\n<!-- vtc:editable -->\nPrefer small commits.\n";
    h.files.set("roles/engineer/prompt.md", ENGINEER);
    h.files.set("roles/engineer_backend/prompt.md", PROFILE);
    h.files.set(
      "roles/engineer_backend/role.yaml",
      "id: engineer_backend\nkind: engineer_profile\n",
    );
    h.files.set("roles/CHANGELOG.md", "# Role prompt changes\n");
    const e = splitRolePrompt(ENGINEER);
    const p = splitRolePrompt(PROFILE);
    if (!e.ok || !p.ok) throw new Error("fixtures do not split");
    const baseline = effectivePromptSha(engineerProfileLockedSection(e, p.locked), p.editable);
    const backend = {
      ...proposal,
      id: "backend-steps",
      base: { ...proposal.base, role: "engineer_backend", effective_sha256: baseline },
      editable: "Plan the steps first.\nPrefer small commits.",
    } as PromptProposal;
    const ran = replay({ proposal: "backend-steps", role: "engineer_backend", baseline });
    expect(
      await h.upstream.openLookbackPr({ replay: ran, proposal: backend }, h.ctx),
    ).toMatchObject({ status: "pr" });
    // a changed Engineer prompt is a new version of every profile: that replay is stale
    h.files.set("roles/engineer/prompt.md", ENGINEER.replace("Test first.", "Test first, always."));
    expect(
      await h.upstream.openLookbackPr(
        { replay: { ...ran, finished_at: "2026-10-16T10:00:00Z" }, proposal: backend },
        h.ctx,
      ),
    ).toMatchObject({ status: "skipped", reason: "stale_baseline" });
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
        for (const path of [
          "/api/runs/R7/status",
          "/api/evidence/upstream",
          "/api/health",
          `/api/runs/${UPSTREAM_EVIDENCE_RUN}/events`,
        ]) {
          probes[path] = (await fetch(new URL(path, request.origin))).status;
        }
        // reading 212(3): the dashboard's own routes of the synthetic run, and every shot waits
        // for its data, so an empty page fails the capture
        expect(
          request.shots.every((s) =>
            s.path.startsWith(`/lookback/?run=${UPSTREAM_EVIDENCE_RUN}&evidence=upstream`),
          ),
        ).toBe(true);
        expect(request.shots.every((s) => s.waitFor !== undefined)).toBe(true);
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
    expect(probes).toEqual({
      "/api/runs/R7/status": 404,
      "/api/evidence/upstream": 404,
      "/api/health": 200,
      [`/api/runs/${UPSTREAM_EVIDENCE_RUN}/events`]: 200,
    });
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

  it("raises 'evidence capture failed' when the evidence branch cannot be published for any other reason (no remote, no auth)", async () => {
    const h = harness();
    const push = h.plumbing.push.bind(h.plumbing);
    h.plumbing.push = (remote, sha, dst) =>
      dst === "refs/heads/vtc-evidence"
        ? Promise.reject(new Error("fatal: Authentication failed for 'https://github.com/'"))
        : push(remote, sha, dst);
    expect(await h.upstream.openPullRequest(prInput(), h.ctx)).toMatchObject({
      status: "skipped",
      reason: "evidence_failed",
    });
    expect(h.github.state.prs).toHaveLength(0);
    expect(h.github.state.issues.map((i) => i.title)).toEqual([
      expect.stringMatching(/evidence/i) as string,
    ]);
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
