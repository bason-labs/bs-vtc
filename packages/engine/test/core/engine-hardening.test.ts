/**
 * Fix round 1 of engine core, each driven through next()/submit() on a real repo: phase-role
 * writes are verified and the run's config is frozen (AD-7 rule 7, AD-8); the merge queue merges
 * the gated commit only (AD-8 rules 4 and 14); engine-created tasks, waived parks and
 * out-of-scope claimers all reach the merge (§6.3, §6.5, §6.7a); §11 shares; flaky re-runs;
 * hosts that cannot run roles; symlinks planted where the engine writes.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engineRepoKey, HIDDEN_TESTS, type LeadAction } from "@vtc/shared";
import { cleanupDirs, git, tempDir, writeFile } from "../helpers/repo.js";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  spawns,
  SPEC_ONE,
  submitResult,
  throughPlan,
  verdictPass,
  workdir,
  worktreeOf,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CLAUDE)).actions;
const events = (h: Harness): { type: string; data: Record<string, unknown>; task?: string }[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown>; task?: string });
const statusOf = (h: Harness, id: string): string | undefined =>
  events(h)
    .filter((e) => e.type === "task.status_changed" && e.task === id)
    .map((e) => e.data.to as string)
    .at(-1);
const toEngineer = async (h: Harness, drafts = [draft("T-1")]): Promise<SpawnAction> => {
  const actions = await throughPlan(h, drafts, SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  return only(await next(h), "engineer");
};
const start = (h: Harness) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CLAUDE,
  );
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error("condition never held");
};

describe("phase roles in their own worktree, the run's config frozen (spine §5 readings 20, 21)", () => {
  it("rejects a phase role's writes outside its paths; the user's checkout never sees them", async () => {
    const h = createHarness({ project: { concurrency: 2 } });
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    const dir = workdir(carto);
    expect(dir).toBe(join(h.repo, ".vtc/state/worktrees", `R-${h.engine.status({}).run.id}-a-1`));
    writeFile(dir, ".vtc/research/repo-map/map.md", "# map\n");
    writeFile(dir, "src/backdoor.ts", "export const x = 1;\n");
    writeFile(dir, ".vtc/tasks/T-9.md", "forged plan\n");
    const out = await submitResult(h, carto, {
      exit: "done",
      artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
    });
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    const issues = (out.rejection?.issues ?? []).join("\n");
    expect(issues).toContain("src/backdoor.ts was written outside the role's write paths");
    expect(issues).toContain(".vtc/tasks/T-9.md was written where only the engine writes");
    expect(existsSync(join(h.repo, "src/backdoor.ts"))).toBe(false);
    expect(existsSync(join(h.repo, ".vtc/research/repo-map/map.md"))).toBe(false);
    // the worktree is gone; the step is simply re-dispatched (the checkout was never touched)
    expect(existsSync(dir)).toBe(false);
    expect(h.engine.status({}).run.paused).toBe(false);
    const again = only(out.actions, "repo_cartographer");
    writeFile(workdir(again), ".vtc/research/repo-map/map.md", "# map\n");
    const accepted = await submitResult(h, again, {
      exit: "done",
      artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
    });
    expect(accepted.accepted).toBe(true);
    expect(readFileSync(join(h.repo, ".vtc/research/repo-map/map.md"), "utf8")).toBe("# map\n");
    await h.release();
  });
  it("records a config change as an incident and keeps the run's config, without pausing", async () => {
    const h = createHarness({ project: { concurrency: 2 } });
    await start(h);
    only(await next(h), "repo_cartographer");
    writeFile(h.repo, ".vtc/project.yaml", '{"version": 1, "concurrency": 3, "merge_level": 3}\n');
    await next(h);
    expect(h.engine.config()).toMatchObject({ concurrency: 2, merge_level: 2 });
    expect(h.engine.status({}).run.paused).toBe(false);
    const incidents = events(h).filter(
      (e) => e.type === "incident.recorded" && e.data.kind === "config_changed",
    );
    expect(incidents).toHaveLength(1);
    expect(JSON.stringify(incidents)).toContain("keeps the config it started with");
    await next(h); // said once per change
    expect(
      events(h).filter((e) => e.type === "incident.recorded" && e.data.kind === "config_changed"),
    ).toHaveLength(1);
    // a restart keeps the frozen config (from the kept copy)
    await h.engine.settle();
    const engine = h.reopen();
    Object.assign(h, { engine });
    expect(engine.config()).toMatchObject({ concurrency: 2, merge_level: 2 });
    expect(engine.status({}).run.paused).toBe(false);
    await h.release();
  });
  it("merges a phase role's writes anywhere in its own paths; the user's own edits never count", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
    writeFile(workdir(carto), ".vtc/research/repo-map/notes/extra.md", "notes\n");
    // the user keeps working in the checkout meanwhile
    writeFile(h.repo, "src/mine.ts", "export const mine = 1;\n");
    const out = await submitResult(h, carto, {
      exit: "done",
      artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
    });
    expect(out.accepted).toBe(true);
    expect(readFileSync(join(h.repo, ".vtc/research/repo-map/notes/extra.md"), "utf8")).toBe(
      "notes\n",
    );
    expect(readFileSync(join(h.repo, "src/mine.ts"), "utf8")).toBe("export const mine = 1;\n");
    expect(h.engine.status({}).run.paused).toBe(false);
    // the next role sees the documents of the ones before it
    const ba = only(out.actions, "ba");
    expect(readFileSync(join(workdir(ba), ".vtc/research/repo-map/map.md"), "utf8")).toBe(
      "# map\n",
    );
    await h.release();
  });
  it("never overwrites a file the user changed while the role worked", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# the role's map\n");
    writeFile(h.repo, ".vtc/research/repo-map/map.md", "# the user's map\n");
    const out = await submitResult(h, carto, {
      exit: "done",
      artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
    });
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "out_of_order" } });
    expect(readFileSync(join(h.repo, ".vtc/research/repo-map/map.md"), "utf8")).toBe(
      "# the user's map\n",
    );
    expect(h.engine.status({}).run.paused).toBe(true);
    // the role's work is kept on its branch for the human
    expect(existsSync(workdir(carto))).toBe(true);
    await h.release();
  });
});

describe("the merge queue merges exactly what was verified (AD-8 rules 4 and 14)", () => {
  it("a reviewer's commit in the task worktree is rejected and the branch reset", async () => {
    const h = createHarness();
    await build(h, await toEngineer(h));
    const built = git(h.repo, "rev-parse", "vtc/T-1");
    const verifier = only(await next(h), "spec_verifier");
    writeFile(worktreeOf(h, "T-1"), "src/t-1/sneaky.ts", "unreviewed\n");
    git(worktreeOf(h, "T-1"), "add", "--all");
    git(worktreeOf(h, "T-1"), "commit", "--quiet", "-m", "reviewer commit");
    const out = await verdictPass(h, verifier, "src/t-1/impl.ts");
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    expect(git(h.repo, "rev-parse", "vtc/T-1")).toBe(built);
    expect(existsSync(join(worktreeOf(h, "T-1"), "src/t-1/sneaky.ts"))).toBe(false);
    await h.release();
  });
  it("merges the gated commit even when the task branch moves while the gates run", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    await build(h, await toEngineer(h));
    const verifier = only(await next(h), "spec_verifier");
    const release = h.gates.hold();
    await verdictPass(h, verifier, "src/t-1/impl.ts");
    await until(() => h.gates.requests.some((r) => r.reason === "merge_queue"));
    writeFile(worktreeOf(h, "T-1"), "src/t-1/late.ts", "unverified\n");
    git(worktreeOf(h, "T-1"), "add", "--all");
    git(worktreeOf(h, "T-1"), "commit", "--quiet", "-m", "late commit");
    release();
    await h.engine.settle();
    const gated = h.gates.requests.find((r) => r.reason === "merge_queue")?.head ?? "";
    const merge = events(h).find((e) => e.type === "merge.completed");
    const commit = (merge?.data.commit as string | undefined) ?? "";
    expect(git(h.repo, "rev-parse", `${commit}^2`)).toBe(gated);
    expect(git(h.repo, "ls-tree", "-r", "--name-only", "vtc/F-1")).not.toContain("late.ts");
    expect(statusOf(h, "T-1")).toBe("done");
    await h.release();
  });
});

describe("every task can reach the merge (§6.3, §6.5, §6.7a)", () => {
  it("Final Review's integration-fix task, which no reviewer is attached to, merges", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    await build(h, await toEngineer(h));
    h.gates.queue("final_review", "fail");
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    await authorTests(h, only(await next(h), "qa"));
    const fix = only(await next(h), "engineer");
    expect(fix.task).toBe("T-2");
    await build(h, fix);
    await h.engine.settle();
    expect(statusOf(h, "T-2")).toBe("done");
    const status = h.engine.status({});
    expect(status.tasks_by_status).toEqual({ done: 2 });
    expect(status.run.finished_at).toBeDefined();
    await h.release();
    // two whole task lifecycles on a real repo: about 3 s alone, near 5 s under `pnpm verify`'s load
  }, 20_000);
  it("a waived stuck park sends the built head to the merge queue", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const engineer = await toEngineer(h);
    h.gates.queue("round", "fail");
    await build(h, engineer);
    await build(h, only(await next(h), "engineer")); // the same tree: stuck
    expect(h.engine.status({}).parked).toEqual([{ task: "T-1", reason: "stuck" }]);
    const escalation = h.engine.escalations({}).escalations.find((e) => e.task === "T-1");
    await h.engine.answer(
      {
        escalation: escalation?.id ?? "",
        answer: { option: "waive", who_should_have_caught: "none" },
      },
      CLAUDE,
    );
    await h.engine.settle();
    expect(statusOf(h, "T-1")).toBe("done");
    expect(events(h).some((e) => e.type === "merge.completed" && e.task === "T-1")).toBe(true);
    await h.release();
  });
  it("an Engineer whose out-of-scope claim was accepted still builds and merges", async () => {
    const h = createHarness({
      project: { merge_level: 1 },
      files: { "lib/shared.ts": "export const broken = true;\n" },
    });
    const engineer = await toEngineer(h);
    h.gates.queue("fault_repro", "fail");
    const claim = await submitResult(h, engineer, {
      exit: "out_of_scope_fault",
      fault: {
        path: "lib/shared.ts",
        line: 1,
        evidence: { type: "file_line", ref: "lib/shared.ts:1" },
        detail: "the shared helper is broken",
      },
    });
    expect(claim.accepted).toBe(true);
    await h.engine.settle();
    const again = [...spawns(claim.actions), ...spawns(await next(h))].find(
      (a) => a.role === "engineer" && a.task === "T-1",
    );
    if (again === undefined) throw new Error("expected T-1's Engineer");
    await build(h, again);
    const verifier = spawns(await next(h)).find(
      (a) => a.role === "spec_verifier" && a.task === "T-1",
    );
    if (verifier === undefined) throw new Error("expected T-1's Spec-Verifier");
    await verdictPass(h, verifier, "src/t-1/impl.ts");
    await h.engine.settle();
    expect(["merged", "done"]).toContain(statusOf(h, "T-1"));
    expect(
      events(h).some(
        (e) => e.type === "finding.status_changed" && e.task === "T-1" && e.data.to === "resolved",
      ),
    ).toBe(true);
    await h.release();
  });
});

describe("§11 shares within a task", () => {
  it("parks a task whose Engineer spent more than 45% of its budget", async () => {
    const h = createHarness({ project: { budgets: { task_usd: { S: 1, M: 1, L: 1 } } } });
    const engineer = await toEngineer(h);
    h.gates.queue("round", "fail");
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    await submitResult(h, engineer, { exit: "built" }, 0.5);
    await h.engine.settle();
    await next(h);
    expect(h.engine.status({}).parked).toEqual([{ task: "T-1", reason: "budget" }]);
    expect(JSON.stringify(h.engine.escalations({}))).toContain("45% share");
    await h.release();
  });
  it("drops the reviewers one tier once they spent more than 25%", async () => {
    const spec = [
      "# Password reset",
      "",
      "## REQ-1 Reset token store",
      "",
      "- REQ-1.AC-1: Given a reset request When a token is issued Then only its hash is stored.",
      "- REQ-1.AC-2: Given a stored token When it is read Then it is never logged.",
      "",
    ].join("\n");
    // the shipped Spec Verifier already runs at the low tier; at mid it has a tier to drop
    const h = createHarness({
      project: { concurrency: 1, budgets: { task_usd: { S: 1, M: 1, L: 1 } } },
      roles: ALL_FIXTURE_ROLES.map((r) =>
        r.id === "spec_verifier"
          ? {
              ...r,
              models: {
                "claude-code": { tier: "mid", effort: "medium" },
                codex: { tier: "mid", effort: "medium" },
              },
            }
          : r,
      ),
    });
    const actions = await throughPlan(h, [draft("T-1")], spec);
    await authorTests(h, only(actions, "qa"));
    await build(h, only(await next(h), "engineer"));
    const first = only(await next(h), "spec_verifier");
    const out = await submitResult(
      h,
      first,
      {
        exit: "done",
        verdicts: [
          {
            subject: first.subject ?? "",
            verdict: "pass",
            evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
          },
        ],
      },
      0.3,
    );
    expect(only(out.actions, "spec_verifier").subject).not.toBe(first.subject);
    const models = events(h)
      .filter(
        (e) => e.type === "role.dispatched" && (e as { role?: string }).role === "spec_verifier",
      )
      .map((e) => (e as unknown as { model: string }).model);
    expect(models).toEqual(["sonnet", "haiku"]);
    await h.release();
  });
});

describe("gates and hosts", () => {
  it("re-runs a round whose only failures are flaky once (§6.3 step 8)", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    h.gates.queue("round", "flaky");
    await build(h, engineer);
    expect(h.gates.requests.filter((r) => r.reason === "round")).toHaveLength(2);
    expect(statusOf(h, "T-1")).toBe("verifying");
    expect(only(await next(h), "spec_verifier").task).toBe("T-1");
    await h.release();
  });
  it("a flaky failure that repeats goes back to the Engineer", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    h.gates.queue("round", "flaky", "flaky");
    await build(h, engineer);
    expect(h.gates.requests.filter((r) => r.reason === "round")).toHaveLength(2);
    expect(statusOf(h, "T-1")).toBe("fixing");
    await h.release();
  });
  it("pauses with the reason when the host cannot run role subagents", async () => {
    const h = createHarness({
      project: { hosts: { dispatch: "headless_allowed" } },
      capabilities: { subagents: false, backgroundSubagents: false },
    });
    await start(h);
    const actions = await next(h);
    expect(spawns(actions)).toEqual([]);
    expect(h.engine.status({}).run.paused).toBe(true);
    expect(actions[0]).toMatchObject({ type: "wait" });
    expect(JSON.stringify(events(h).filter((e) => e.type === "run.paused"))).toContain(
      "no role subagents",
    );
    expect(h.spawned).toEqual([]);
    await h.release();
  });
});

describe("symlinks planted where the engine writes or copies (AD-18)", () => {
  it("never writes a plan file through a symlink", async () => {
    const h = createHarness();
    const outside = tempDir("vtc-outside-");
    writeFileSync(join(outside, "victim.txt"), "original\n");
    mkdirSync(join(h.repo, ".vtc/tasks"), { recursive: true });
    symlinkSync(join(outside, "victim.txt"), join(h.repo, ".vtc/tasks/T-1.md"));
    await throughPlan(h, [draft("T-1")], SPEC_ONE);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("original\n");
    expect(lstatSync(join(h.repo, ".vtc/tasks/T-1.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(h.repo, ".vtc/tasks/T-1.md"), "utf8")).toContain("T-1");
    await h.release();
  });
  it("moves hidden tests without following QA's symlinks", async () => {
    const h = createHarness();
    const outside = tempDir("vtc-outside-");
    writeFileSync(join(outside, "secret.txt"), "private\n");
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const staging = join(h.repo, HIDDEN_TESTS.stagingDir, "T-1");
    writeFile(staging, "hidden.test.ts", "test('hidden', () => {});\n");
    symlinkSync(join(outside, "secret.txt"), join(staging, "leak.test.ts"));
    await authorTests(h, only(actions, "qa"));
    const target = join(h.deps.vtcHome, HIDDEN_TESTS.homeDir, engineRepoKey(h.repo), "T-1");
    expect(readdirSync(target)).toEqual(["hidden.test.ts"]);
    expect(existsSync(staging)).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("private\n");
    await h.release();
  });
});
