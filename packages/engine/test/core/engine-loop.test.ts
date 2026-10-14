/**
 * The loop controller, parking and escalation, budgets, write scope, usage limits and the kill
 * switch, each driven through next()/submit() on a real repo (§6.3–6.9, §11, AD-8, AD-17).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EscalationListSchema, type LeadAction } from "@vtc/shared";
import { ALL_FIXTURE_ROLES, FIXTURE_LENS_DB } from "../fixtures/roles.js";
import { cleanupDirs, git, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  spawns,
  submitResult,
  throughPlan,
  verdictPass,
  workdir,
  worktreeOf,
  SPEC_ONE,
  toolFinding,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

// Whole engine flows on a real repo spawn a few hundred git processes per test: under turbo's
// parallel load the 5 s default is too tight, so they get room on a loaded machine. A real hang
// still fails, and no assertion changes.
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanupDirs);

/** Plan, author T-1's tests, and return the Engineer's first dispatch. */
const toEngineer = async (h: Harness, drafts = [draft("T-1")]): Promise<SpawnAction> => {
  const actions = await throughPlan(h, drafts, SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  return only((await h.engine.next({}, CLAUDE)).actions, "engineer");
};

const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CLAUDE)).actions;
const taskOf = (h: Harness, id: string) => {
  const status = h.engine.status({});
  return { status, parked: status.parked.find((p) => p.task === id) };
};
const eventsOf = (h: Harness): { type: string; data: Record<string, unknown>; task?: string }[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown>; task?: string });
const statusChanges = (h: Harness, id = "T-1") =>
  eventsOf(h)
    .filter((e) => e.type === "task.status_changed" && e.task === id)
    .map((e) => `${e.data.to as string}@${String(e.data.round as number)}`);

describe("loop controller through the engine (§6.3 step 9)", () => {
  it("sends a failed gate straight back to the Engineer with no reviewer, then parks as stuck", async () => {
    const h = createHarness();
    let engineer = await toEngineer(h);
    h.gates.queue("round", "fail", "fail");
    await build(h, engineer);
    expect(statusChanges(h).slice(-2)).toEqual(["verifying@1", "fixing@2"]);
    let actions = await next(h);
    expect(spawns(actions).map((a) => a.role)).toEqual(["engineer"]);
    engineer = only(actions, "engineer");
    const pack = readFileSync(join(h.repo, engineer.pack), "utf8");
    expect(pack).toContain("Gate tests (L2) failed");
    expect(engineer.resume).toBeUndefined();
    await build(h, engineer, "export const x = 2;\n");
    // the same gate fingerprint again: weighted severity did not drop → stuck
    const { parked } = taskOf(h, "T-1");
    expect(parked).toEqual({ task: "T-1", reason: "stuck" });
    actions = await next(h);
    expect(actions.find((a) => a.type === "ask_human")).toEqual({
      type: "ask_human",
      escalations: ["E-1"],
    });
    const escalations = EscalationListSchema.parse(h.engine.escalations({})).escalations;
    expect(escalations[0]).toMatchObject({
      reason: "stuck",
      task: "T-1",
      recommended: "hint",
      blocks: ["T-1"],
    });
    await h.release();
  });

  it("an identical diff is stuck; a hint resumes the same round with the answer in the pack", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    h.gates.queue("round", "fail");
    await build(h, engineer);
    const second = only(await next(h), "engineer");
    // submits without changing anything: identical tree
    await submitResult(h, second, { exit: "built" });
    await h.engine.settle();
    expect(taskOf(h, "T-1").parked?.reason).toBe("stuck");
    const answered = await h.engine.answer(
      {
        escalation: "E-1",
        answer: { option: "hint", text: "check the expiry", who_should_have_caught: "qa" },
      },
      CLAUDE,
    );
    const resumed = only(answered.actions, "engineer");
    expect(statusChanges(h).at(-1)).toBe("fixing@2");
    expect(readFileSync(join(h.repo, resumed.pack), "utf8")).toContain("hint: check the expiry");
    await h.release();
  });

  it("a hint after QA got stuck re-runs QA author with the hint, never the Engineer", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    let qa = only(actions, "qa");
    // three QA author results rejected in a row (no acceptance tests named): stuck
    for (let i = 0; i < 3; i += 1) {
      const out = await submitResult(h, qa, { exit: "done" });
      expect(out.accepted).toBe(false);
      await h.engine.settle();
      if (i < 2) qa = only(out.actions, "qa");
    }
    expect(taskOf(h, "T-1").parked?.reason).toBe("stuck");
    const escalation = EscalationListSchema.parse(h.engine.escalations({})).escalations.find(
      (e) => e.id === "E-1",
    );
    // the option names the role that got stuck
    expect(escalation?.options.find((o) => o.id === "hint")?.label).toMatch(/^Give QA a hint/);
    const answered = await h.engine.answer(
      {
        escalation: "E-1",
        answer: {
          option: "hint",
          text: "tests go under tests/acceptance/",
          who_should_have_caught: "qa",
        },
      },
      CLAUDE,
    );
    expect(spawns(answered.actions).map((a) => a.role)).toEqual(["qa"]);
    const resumed = only(answered.actions, "qa");
    expect(resumed.mode).toBe("author");
    expect(readFileSync(join(h.repo, resumed.pack), "utf8")).toContain(
      "hint: tests go under tests/acceptance/",
    );
    expect(statusChanges(h).at(-1)).toBe("ready@0");
    await h.release();
  });

  it("a rejected QA result leaves nothing on the task branch, so the Engineer is never charged for it", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const qa = only(actions, "qa");
    const tree = worktreeOf(h, "T-1");
    const before = git(tree, "rev-parse", "HEAD");
    // QA writes its test outside the acceptance globs: rejected for write scope
    writeFile(tree, "test/acceptance/t-1.test.ts", 'test("[REQ-1.AC-1] works", () => {});\n');
    const out = await submitResult(h, qa, {
      exit: "done",
      acceptance_tests: ["[REQ-1.AC-1] works"],
      artifacts: [{ type: "acceptance_test", path: "test/acceptance/t-1.test.ts" }],
    });
    expect(out.accepted).toBe(false);
    expect(out.rejection?.reason).toBe("write_scope");
    await h.engine.settle();
    // the branch is where it was, and the rejected file is gone from the worktree
    expect(git(tree, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(tree, "test/acceptance/t-1.test.ts"))).toBe(false);
    // QA retries within scope; the Engineer's write scope sees only its own writes
    await authorTests(h, only(out.actions, "qa"));
    const engineer = only(await next(h), "engineer");
    const built = await build(h, engineer);
    expect(built.accepted).toBe(true);
    await h.release();
  });

  it("parks at the round cap (risk low = 3) and escalates the Engineer's tier from round 3", async () => {
    const h = createHarness();
    let engineer = await toEngineer(h, [draft("T-1", { risk: "low" })]);
    expect(engineer.prompt).toContain("model sonnet");
    // each round fails with fewer, lighter findings: never stuck, so the cap ends the loop
    h.gates.queue(
      "round",
      { fail: [toolFinding("a", "medium"), toolFinding("b", "medium")] },
      { fail: [toolFinding("c", "medium")] },
      { fail: [toolFinding("d", "low")] },
    );
    for (const round of [1, 2, 3]) {
      writeFile(
        worktreeOf(h, "T-1"),
        `src/t-1/r${String(round)}.ts`,
        `export const r = ${String(round)};\n`,
      );
      expect((await submitResult(h, engineer, { exit: "built" })).accepted).toBe(true);
      await h.engine.settle();
      if (round < 3) {
        expect(statusChanges(h).at(-1)).toBe(`fixing@${String(round + 1)}`);
        engineer = only(await next(h), "engineer");
      }
    }
    expect(engineer.prompt).toContain("model opus");
    expect(engineer.resume).toBeUndefined();
    expect(taskOf(h, "T-1").parked).toEqual({ task: "T-1", reason: "cap" });
    expect(statusChanges(h).at(-1)).toBe("parked@3");
    await h.release();
  });
});

describe("write scope (§6.3 step 4) and protected files (§7.3)", () => {
  it("rejects a write outside files_scope as a test-integrity hit and starts a fix round", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    writeFile(worktreeOf(h, "T-1"), "lib/elsewhere.ts", "x\n");
    const out = await build(h, engineer);
    expect(out).toMatchObject({
      accepted: false,
      rejection: { reason: "write_scope", issues: ["out_of_scope_write: lib/elsewhere.ts"] },
    });
    expect(statusChanges(h).at(-1)).toBe("fixing@2");
    expect(
      eventsOf(h).some(
        (e) =>
          e.type === "finding.recorded" &&
          (e.data.finding as { category: string }).category === "test_integrity",
      ),
    ).toBe(true);
    // the second violation in another round fires §7.6 rule 8
    const again = only(out.actions, "engineer");
    writeFile(worktreeOf(h, "T-1"), "tests/acceptance/t-1.test.ts", "tampered\n");
    const second = await build(h, again);
    // the first round's stray file was discarded with its rejected result (reading 86)
    expect(existsSync(join(worktreeOf(h, "T-1"), "lib/elsewhere.ts"))).toBe(false);
    expect(second.rejection?.issues).toEqual(["protected_modified: tests/acceptance/t-1.test.ts"]);
    expect(taskOf(h, "T-1").parked).toEqual({
      task: "T-1",
      reason: "risk_rule",
      risk_rule: "repeated_test_integrity",
    });
    await h.release();
  });
});

describe("risk router (§6.3 step 6, §7.6)", () => {
  it("parks a task that edits CI config with risk_rule protected_config; a waiver lets it continue", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h, [
      draft("T-1", { files_scope: ["src/t-1/**", ".github/**"] }),
    ]);
    writeFile(worktreeOf(h, "T-1"), ".github/workflows/ci.yml", "on: push\n");
    await build(h, engineer);
    expect(taskOf(h, "T-1").parked).toEqual({
      task: "T-1",
      reason: "risk_rule",
      risk_rule: "protected_config",
    });
    const answered = await h.engine.answer(
      { escalation: "E-1", answer: { option: "waive", who_should_have_caught: "none" } },
      CLAUDE,
    );
    expect(statusChanges(h).at(-1)).toBe("verifying@1");
    expect(answered.actions[0]).toMatchObject({ type: "wait" });
    // the gates re-run on resume; the waived rule does not park the same head again
    await h.engine.settle();
    expect(only(await next(h), "spec_verifier").subject).toBe("REQ-1.AC-1");
    await h.release();
  });
  it("skips reviewers on a documentation-only diff", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h, [draft("T-1", { files_scope: ["docs/**"] })]);
    await build(h, engineer, "# docs\n", "docs/guide.md");
    expect(statusChanges(h)).toContain("queued@1");
    await h.release();
  });
});

describe("reviewers and triage (§6.3 steps 7–8)", () => {
  it("routes a reviewer's finding back to the Engineer and discards findings whose evidence does not resolve", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    await build(h, engineer);
    const verifier = only(await next(h), "spec_verifier");
    const out = await submitResult(h, verifier, {
      exit: "done",
      verdicts: [
        {
          subject: "REQ-1.AC-1",
          verdict: "fail",
          evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
        },
      ],
      findings: [
        {
          rule_id: "expiry",
          category: "correctness",
          kind: "implementation_deviation",
          title: "No expiry check",
          confidence: 0.9,
          location: { path: "src/t-1/impl.ts", symbol: "x" },
          evidence: { type: "file_line", ref: "src/t-1/impl.ts:1" },
          claimed_severity: "critical",
        },
        {
          rule_id: "ghost",
          category: "correctness",
          kind: "implementation_deviation",
          title: "Made up",
          confidence: 0.9,
          location: { path: "src/t-1/ghost.ts" },
          evidence: { type: "file_line", ref: "src/t-1/ghost.ts:9" },
        },
      ],
    });
    expect(out.accepted).toBe(true);
    await h.engine.settle();
    const recorded = eventsOf(h)
      .filter((e) => e.type === "finding.recorded")
      .map(
        (e) => e.data.finding as { title: string; status: string; severity: string; route: string },
      );
    expect(recorded.map((f) => [f.title, f.status, f.severity, f.route])).toEqual([
      ["No expiry check", "open", "medium", "patch"],
      ["Made up", "discarded", "medium", "patch"],
    ]);
    expect(statusChanges(h).at(-1)).toBe("fixing@2");
    expect(spawns(await next(h)).map((a) => a.role)).toEqual(["engineer"]);
    await h.release();
  });
  it("rejects a verdict whose evidence does not resolve (claim_check)", async () => {
    const h = createHarness();
    await build(h, await toEngineer(h));
    const verifier = only(await next(h), "spec_verifier");
    const out = await verdictPass(h, verifier, "src/t-1/missing.ts");
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "claim_check" } });
    await h.release();
  });
  it("a secret parks at once as committed_secret (§7.6 rule 1)", async () => {
    const h = createHarness();
    await build(h, await toEngineer(h));
    const verifier = only(await next(h), "spec_verifier");
    await submitResult(h, verifier, {
      exit: "done",
      verdicts: [
        {
          subject: "REQ-1.AC-1",
          verdict: "fail",
          evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
        },
      ],
      findings: [
        {
          rule_id: "secret",
          category: "secret",
          kind: "implementation_deviation",
          title: "Key in code",
          confidence: 1,
          location: { path: "src/t-1/impl.ts" },
          evidence: { type: "file_line", ref: "src/t-1/impl.ts:1" },
        },
      ],
    });
    await h.engine.settle();
    expect(taskOf(h, "T-1").parked).toEqual({
      task: "T-1",
      reason: "risk_rule",
      risk_rule: "committed_secret",
    });
    await h.release();
  });
});

describe("parking blocks only dependents (§6.5, D5) and concurrency (§6.6)", () => {
  it("starts at most `concurrency` tasks and keeps others running while one is parked", async () => {
    const h = createHarness({ project: { concurrency: 2 } });
    const actions = await throughPlan(h, [
      draft("T-1"),
      draft("T-2", { covers: ["REQ-2"] }),
      draft("T-3", { covers: ["REQ-1"], after: ["T-1"] }),
      draft("T-4", { covers: ["REQ-2"] }),
    ]);
    expect(spawns(actions).map((a) => `${a.role}:${a.task ?? ""}`)).toEqual(["qa:T-1", "qa:T-2"]);
    expect(h.engine.status({}).tasks_by_status).toMatchObject({
      ready: 2,
      waiting_dependency: 1,
      draft: 1,
    });
    const [a1, a2] = spawns(actions);
    await authorTests(h, a1!);
    // T-1's QA is blocked by a question → park blocked; T-2 continues
    const eng1 = only(await next(h), "engineer");
    await submitResult(h, eng1, {
      exit: "blocked",
      question: {
        question: "Which hash?",
        options: [
          { id: "sha", label: "SHA-256", effect: "clarify" },
          { id: "argon", label: "Argon2", effect: "clarify" },
        ],
        recommended: "sha",
        evidence: [{ type: "spec_ref", ref: "REQ-1.AC-1" }],
      },
    });
    expect(taskOf(h, "T-1").parked?.reason).toBe("blocked");
    const escalation = h.engine.escalations({}).escalations[0];
    expect(escalation?.blocks).toEqual(["T-1", "T-3"]);
    await authorTests(h, a2!, "REQ-2.AC-1");
    const after = await next(h);
    expect(spawns(after).map((a) => `${a.role}:${a.task ?? ""}`)).toEqual([
      "engineer:T-2",
      "qa:T-4",
    ]);
    expect(h.engine.status({}).tasks_by_status.waiting_dependency).toBe(1);
    await h.release();
  });
});

describe("milestone commits of the git-tracked .vtc/ files (spec §6.8, reading 90)", () => {
  it("commits the run's log and documents at G1/G2, and leaves the user's own changes alone", async () => {
    const h = createHarness();
    writeFile(h.repo, "README.md", "# my own edit\n");
    git(h.repo, "add", "README.md"); // staged by the user, not committed by the engine
    await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await h.engine.settle();
    const run = h.engine.status({}).run.id;
    const subjects = git(h.repo, "log", "--format=%s").split("\n");
    expect(subjects).toEqual(
      expect.arrayContaining([`vtc: ${run} G1 approved`, `vtc: ${run} G2 approved`]),
    );
    const filesOf = (grep: string): string[] =>
      git(
        h.repo,
        "show",
        "--name-only",
        "--format=",
        git(h.repo, "log", "--format=%H", "--grep", grep, "-1"),
      ).split("\n");
    expect(filesOf("G1 approved").some((f) => f.startsWith(".vtc/spec/"))).toBe(true);
    const files = filesOf("G2 approved");
    expect(files).toContain(`.vtc/runs/${run}/events.jsonl`);
    expect(files.some((f) => f.startsWith(".vtc/state/"))).toBe(false);
    expect(files).not.toContain("README.md");
    // the user's staged change is still staged, still theirs
    expect(git(h.repo, "diff", "--cached", "--name-only")).toBe("README.md");
    await h.release();
  });
});

describe("task and feature ids another clone took (spine §5 reading 89)", () => {
  it("skips T-n / F-n that a fetched remote branch or a committed plan file already uses", async () => {
    const h = createHarness();
    // a teammate's pushed work, as this clone's fetch saw it: their integration branch and a
    // committed plan file on the default branch
    const head = git(h.repo, "rev-parse", "HEAD");
    git(h.repo, "update-ref", "refs/remotes/origin/vtc/F-1", head);
    git(h.repo, "update-ref", "refs/remotes/origin/vtc/T-1", head);
    writeFile(h.repo, ".vtc/tasks/T-3.md", "---\nid: T-3\n---\n");
    git(h.repo, "add", ".vtc/tasks/T-3.md");
    git(h.repo, "commit", "-q", "-m", "teammate plan");
    await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const status = h.engine.status({});
    expect(status.features.map((f) => f.id)).toEqual(["F-2"]);
    expect(Object.keys(h.engine.status({}).tasks_by_status).length).toBeGreaterThan(0);
    const created = eventsOf(h).filter((e) => e.type === "task.created");
    expect(created.map((e) => e.task)).toEqual(["T-4"]);
    await h.release();
  });
});

describe("role-written .vtc/ documents are checked for secrets (AD-18 rule 1)", () => {
  it("rejects a front-half result that quotes a secret, and nothing reaches the checkout", async () => {
    const h = createHarness();
    await h.engine.start(
      { request: "Idea", track: "feature", repo: "existing", has_ui: false, risk_hints: [] },
      CLAUDE,
    );
    const carto = only(await next(h), "repo_cartographer");
    const map = ".vtc/research/repo-map/map.md";
    writeFile(workdir(carto), map, "# map\n\nThe .env sets AWS_KEY=AKIAABCDEFGHIJKLMNOP\n");
    const out = await submitResult(h, carto, {
      exit: "done",
      artifacts: [{ type: "repo_map", path: map }],
    });
    expect(out.accepted).toBe(false);
    expect(out.rejection?.reason).toBe("write_scope");
    expect(out.rejection?.issues.join("\n")).toMatch(/map\.md .*secret/);
    // the secret is not in the user's checkout, and the issue does not repeat it
    expect(existsSync(join(h.repo, map))).toBe(false);
    expect(JSON.stringify(out)).not.toContain("AKIAABCDEFGHIJKLMNOP");
    await h.release();
  });
});

describe("budget controller (§11, §7.6 rule 13)", () => {
  it("parks a task at 100% of its budget after the current turn; a human raise resumes it", async () => {
    const h = createHarness({ project: { budgets: { task_usd: { S: 1.5, M: 1, L: 15 } } } });
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    const engineer = only(await next(h), "engineer");
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "x\n");
    const out = await submitResult(h, engineer, { exit: "built" }, 1.25);
    expect(out.accepted).toBe(true);
    await h.engine.settle();
    expect(taskOf(h, "T-1").parked?.reason).toBe("budget");
    const tasks = h.engine.status({});
    // the run's spend counts the front half's four runs too (0.4), not only the task's 1.35
    expect(tasks.budget.spent_usd).toBeCloseTo(1.75);
    await h.engine.answer(
      { escalation: "E-1", answer: { option: "raise-2x", who_should_have_caught: "planner" } },
      CLAUDE,
    );
    expect(
      eventsOf(h)
        .filter((e) => e.type === "budget.updated" && e.task === "T-1")
        .at(-1)?.data,
    ).toMatchObject({ budget_usd: 2 });
    expect(statusChanges(h).at(-1)).toBe("verifying@1");
    await h.release();
  });
  it("charges what a rejected result cost to its task and the run (§11)", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const before = h.engine.status({}).budget.spent_usd;
    const out = await submitResult(h, only(actions, "qa"), { exit: "done" }, 0.25);
    expect(out.accepted).toBe(false);
    const rejected = eventsOf(h).findLast((e) => e.type === "role.rejected") as unknown as {
      cost_usd?: number;
      tokens?: unknown;
    };
    expect(rejected.cost_usd).toBe(0.25);
    expect(rejected.tokens).toMatchObject({ in: 100, out: 50 });
    expect(h.engine.status({}).budget.spent_usd).toBeCloseTo(before + 0.25);
    expect(
      eventsOf(h)
        .filter((e) => e.type === "budget.updated" && e.task === "T-1")
        .at(-1)?.data,
    ).toMatchObject({ spent_usd: 0.25 });
    await h.release();
  });
  it("counts front-half role runs in the run's spend, before any feature exists", async () => {
    const h = createHarness();
    await h.engine.start(
      { request: "Idea", track: "feature", repo: "existing", has_ui: false, risk_hints: [] },
      CLAUDE,
    );
    const carto = only(await next(h), "repo_cartographer");
    writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
    const out = await submitResult(
      h,
      carto,
      { exit: "done", artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }] },
      0.4,
    );
    expect(out.accepted).toBe(true);
    expect(h.engine.status({}).budget.spent_usd).toBeCloseTo(0.4);
    await h.release();
  });
  it("leaves an unpriced run unknown, never $0", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const out = await submitResult(
      h,
      only(actions, "qa"),
      { exit: "done", acceptance_tests: ["t"], artifacts: [] },
      null,
    );
    expect(out.accepted).toBe(true);
    const submitted = eventsOf(h)
      .filter((e) => e.type === "role.submitted")
      .at(-1) as unknown as { cost_usd: unknown };
    expect(submitted.cost_usd).toBeNull();
    await h.release();
  });
});

describe("usage limits and auto-resume in plugin-only mode (§6.9, AD-17)", () => {
  it("interrupts the step, schedules the timer, waits, then re-dispatches resuming the session", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const failed = await h.engine.submit(
      {
        kind: "failure",
        action_id: engineer.action_id,
        outcome: {
          kind: "limit",
          session_ref: { host: "claude-code", id: "sess-9" },
          resets_at: "2026-10-13T13:00:00.000Z",
          window: "five_hour",
          model: null,
          message: "limit",
          tokens: null,
          cost_usd: 0.4,
        },
      },
      CLAUDE,
    );
    expect(failed.accepted).toBe(true);
    expect(statusChanges(h).at(-1)).toBe("interrupted@1");
    expect(h.scheduled.at?.toISOString()).toBe("2026-10-13T13:01:30.000Z");
    expect(failed.actions).toEqual([
      {
        type: "wait",
        reason: expect.stringContaining("usage limit") as unknown,
        until: "2026-10-13T13:01:30.000Z",
      },
    ]);
    expect(h.engine.status({}).usage).toMatchObject({
      interrupted_tasks: ["T-1"],
      auto_resume_at: "2026-10-13T13:01:30.000Z",
    });
    h.advance(5 * 3600_000);
    const resumed = only(await next(h), "engineer");
    expect(resumed.resume).toEqual({ host: "claude-code", id: "sess-9" });
    expect(statusChanges(h).at(-1)).toBe("building@1");
    expect(eventsOf(h).some((e) => e.type === "run.resumed" && e.data.auto === true)).toBe(true);
    expect(h.spawned).toEqual([]);
    await h.release();
  });
  it("re-reads usage after the reset and backs off while the host is still limited", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    await h.engine.submit(
      {
        kind: "failure",
        action_id: engineer.action_id,
        outcome: {
          kind: "limit",
          session_ref: null,
          resets_at: null,
          window: null,
          model: null,
          message: "limit",
          tokens: null,
          cost_usd: null,
        },
      },
      CLAUDE,
    );
    h.advance(20 * 60_000);
    h.engine.ingestUsage({
      host: "claude-code",
      source: "statusline",
      windows: [
        {
          kind: "five_hour",
          label: "five_hour",
          window_minutes: 300,
          used_pct: 100,
          resets_at: "2026-10-13T11:00:00.000Z",
        },
      ],
      model_limits: [],
      updated_at: h.clock.toISOString(),
    });
    const waiting = await next(h);
    expect(waiting[0]).toMatchObject({ type: "wait", until: "2026-10-13T11:01:30.000Z" });
    await h.release();
  });
  it("a lost sign-in pauses the run; an error re-dispatches the step", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const errored = await h.engine.submit(
      {
        kind: "failure",
        action_id: engineer.action_id,
        outcome: { kind: "error", message: "crash", retryable: true, tokens: null, cost_usd: null },
      },
      CLAUDE,
    );
    const again = only(errored.actions, "engineer");
    const auth = await h.engine.submit(
      {
        kind: "failure",
        action_id: again.action_id,
        outcome: { kind: "auth", message: "signed out" },
      },
      CLAUDE,
    );
    expect(h.engine.status({}).run.paused).toBe(true);
    expect(auth.actions[0]).toMatchObject({
      type: "wait",
      reason: expect.stringContaining("paused") as unknown,
    });
    await h.release();
  });
});

describe("kill switch and resume (§6.7 guardrails, AD-4)", () => {
  it("pause stops dispatching and merging; resume supersedes stale role runs", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    expect(await h.engine.pause({})).toMatchObject({ paused: true });
    expect((await next(h))[0]).toMatchObject({ type: "wait" });
    const resumed = await h.engine.resume({});
    expect(resumed.paused).toBe(false);
    const late = await submitResult(h, engineer, { exit: "built" });
    expect(late).toMatchObject({ accepted: false, rejection: { reason: "stale_action" } });
    expect(spawns(late.actions).map((a) => a.role)).toEqual(["engineer"]);
    await h.release();
  });
});

describe("change requests (§6.2)", () => {
  it("opens a CR as an escalation and re-freezes the artifact when approved", async () => {
    const h = createHarness();
    await throughPlan(h, [draft("T-1")], SPEC_ONE);
    writeFile(
      h.repo,
      ".vtc/spec/spec.md",
      `${readFileSync(join(h.repo, ".vtc/spec/spec.md"), "utf8")}\n- REQ-1.AC-2: More.\n`,
    );
    const cr = await h.engine.changeRequest({
      artifact: "spec",
      summary: "Add AC-2",
      detail: "Users asked for it",
    });
    expect(cr.escalation).toBe("E-1");
    const before = h.engine.status({}).run.gates.G1.frozen[0]?.sha256;
    await h.engine.answer(
      { escalation: "E-1", answer: { option: "approve", who_should_have_caught: "ba" } },
      CLAUDE,
    );
    const after = h.engine.status({}).run.gates.G1.frozen[0]?.sha256;
    expect(after).not.toBe(before);
    expect(eventsOf(h).map((e) => e.type)).toEqual(
      expect.arrayContaining(["change_request.opened", "change_request.decided"]),
    );
    await h.release();
  });
});

describe("Tier-2 lens reviewers (§5.3, reading 92)", () => {
  it("attaches the lens a planner risk tag names as its own reviewer node, and waits for it", async () => {
    const h = createHarness({ roles: [...ALL_FIXTURE_ROLES, FIXTURE_LENS_DB] });
    const engineer = await toEngineer(h, [draft("T-1", { risk_tags: ["migration"] })]);
    await build(h, engineer);
    const reviewers = spawns(await next(h));
    expect(reviewers.map((a) => a.role).sort()).toEqual(["lens_db", "spec_verifier"]);
    const lens = only(reviewers, "lens_db");
    expect(lens.subject).toBe("T-1");
    await verdictPass(h, only(reviewers, "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    // the round waits for the lens too
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ verifying: 1 });
    await verdictPass(h, lens, "src/t-1/impl.ts");
    await h.engine.settle();
    expect(h.engine.status({}).tasks_by_status.verifying ?? 0).toBe(0);
    await h.release();
  });
});

describe("Level 1 and Final Review fixes (§6.4, §6.7a)", () => {
  it("at Level 1 a merged task is done; a failing Final Review opens an integration-fix task", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const engineer = await toEngineer(h);
    await build(h, engineer);
    h.gates.queue("final_review", "fail");
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    const status = h.engine.status({});
    expect(status.tasks_by_status).toMatchObject({ done: 1 });
    expect(status.features[0]).toMatchObject({ status: "fixing", round: 1, tasks: ["T-1", "T-2"] });
    expect(status.run.phase).toBe("build");
    expect(h.prs.calls).toEqual([]);
    const fix = only(await next(h), "qa");
    expect(fix.task).toBe("T-2");
    await h.release();
  });

  it("names the owning task of a Final Review finding and gives the fix its discipline and scope", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const engineer = await toEngineer(h, [draft("T-1", { discipline: "frontend" })]);
    await build(h, engineer);
    h.gates.queue("final_review", { fail: [toolFinding("null-deref", "high", "src/t-1/impl.ts")] });
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    const created = eventsOf(h)
      .filter((e) => e.type === "task.created")
      .map(
        (e) =>
          e.data.task as { id: string; discipline: string; files_scope: string[]; title: string },
      );
    const fix = created.find((t) => t.id === "T-2");
    expect(fix).toMatchObject({ discipline: "frontend", files_scope: ["src/t-1/**"] });
    expect(fix?.title).toMatch(/T-1/);
    await h.release();
  });

  it("parks the feature on a risky Final Review finding instead of a fix round", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const engineer = await toEngineer(h);
    await build(h, engineer);
    const leak = { ...toolFinding("hardcoded-key", "critical"), category: "secret" as const };
    h.gates.queue("final_review", { fail: [leak] });
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    const status = h.engine.status({});
    expect(status.features[0]).toMatchObject({ status: "parked", tasks: ["T-1"] });
    const opened = EscalationListSchema.parse(h.engine.escalations({})).escalations.at(-1);
    expect(opened).toMatchObject({ reason: "risk_rule", risk_rule: "committed_secret" });
    await h.release();
  });

  it("parks the feature as stuck when a Final Review finding survives a fix round", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const engineer = await toEngineer(h);
    await build(h, engineer);
    const same = toolFinding("off-by-one", "medium", "src/t-1/impl.ts");
    h.gates.queue("final_review", { fail: [same] }, { fail: [same] });
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    expect(h.engine.status({}).features[0]).toMatchObject({ status: "fixing", round: 1 });
    // the integration fix runs its course and merges; Final Review finds the same thing again
    await authorTests(h, only(await next(h), "qa"));
    await build(h, only(await next(h), "engineer"), "export const y = 2;\n", "src/t-1/fix.ts");
    await h.engine.settle();
    const status = h.engine.status({});
    expect(status.features[0]).toMatchObject({ status: "parked" });
    const opened = EscalationListSchema.parse(h.engine.escalations({})).escalations.at(-1);
    expect(opened).toMatchObject({ reason: "stuck" });
    await h.release();
  });
});
