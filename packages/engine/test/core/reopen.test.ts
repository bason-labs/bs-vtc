/**
 * Final Review routing (spec §6.7a "Routing findings"; spine §5 readings 139 and 150): a finding
 * one merged (not yet done) task owns reopens that task (`merged` → `fixing`) for a fix round with
 * its own specialist, in its preserved worktree rebased onto the integrated head; a finding no
 * single task owns, or one on a `done` task, still becomes an integration-fix task.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canTransitionTask } from "../../src/core/machines.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  passFinalReview,
  SPEC_ONE,
  spawns,
  submitResult,
  throughPlan,
  verdictPass,
  worktreeOf,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 40_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  task?: string;
  feature?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** One task merged on a Level-2 run (merged tasks stay `merged` until the feature ships). */
const toFinalReview = async (h: Harness): Promise<SpawnAction[]> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
  await verdictPass(
    h,
    only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
    "src/t-1/impl.ts",
  );
  await h.engine.settle();
  return spawns((await h.engine.next({}, CLAUDE)).actions);
};

const review = (h: Harness, action: SpawnAction, verdict: "pass" | "fail", cite: string) =>
  submitResult(h, action, {
    exit: "done",
    feature: action.feature,
    verdicts: [
      { subject: action.subject ?? "F-1", verdict, evidence: [{ type: "file_line", ref: cite }] },
    ],
  });

describe("Final Review reopens the owning task (§6.7a; readings 139, 150)", () => {
  it("allows merged → fixing (never done → anything)", () => {
    expect(canTransitionTask("merged", "fixing")).toBe(true);
    expect(canTransitionTask("done", "fixing")).toBe(false);
  });

  it("a finding the merged task owns reopens it in its worktree, rebased onto the integrated head", async () => {
    const h = createHarness();
    // no open PR yet (gh failed): at Level 2 the merged task is not done (§6.4)
    h.prs.upsertDraft = () => Promise.reject(new Error("gh: not signed in"));
    const [verifier, security] = await toFinalReview(h);
    expect(h.engine.status({}).run.merge_level_effective).toBe(2);
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ merged: 1 });
    expect(h.engine.status({}).features[0]?.status).toBe("final_review");
    await review(h, verifier!, "fail", "src/t-1/impl.ts:1");
    await review(h, security!, "pass", "src/t-1/impl.ts:1");
    await h.engine.settle();
    const status = h.engine.status({});
    expect(status.features[0]).toMatchObject({ status: "fixing", round: 1 });
    // no integration-fix task: the owner itself reopened, keeping its own round
    expect(events(h).filter((e) => e.type === "task.created")).toHaveLength(1);
    const reopened = events(h).find(
      (e) =>
        e.type === "task.status_changed" &&
        e.task === "T-1" &&
        e.data.from === "merged" &&
        e.data.to === "fixing",
    );
    expect(reopened?.data.round).toBe(1);
    const finding = events(h).findLast((e) => e.type === "finding.recorded" && e.task === "T-1")
      ?.data.finding as { feature?: string; location: { path: string } };
    expect(finding).toMatchObject({ feature: "F-1", location: { path: "src/t-1/impl.ts" } });
    // the preserved worktree now sits at the integrated head, which is the task's new baseline
    const integrated = git(h.repo, "rev-parse", "vtc/F-1");
    const assigned = events(h).findLast(
      (e) => e.type === "task.workspace_assigned" && e.task === "T-1",
    );
    expect(assigned?.data).toMatchObject({
      worktree: ".vtc/state/worktrees/T-1",
      baseline_revision: integrated,
    });
    expect(git(worktreeOf(h, "T-1"), "rev-parse", "HEAD")).toBe(integrated);
    // the same specialist gets the fix round with the finding
    const engineer = only((await h.engine.next({}, CLAUDE)).actions, "engineer");
    expect(engineer.task).toBe("T-1");
    expect(engineer.prompt).toContain(worktreeOf(h, "T-1"));
    expect(readFileSync(join(h.repo, engineer.pack), "utf8")).toContain(
      "F-1: verdict fail (src/t-1/impl.ts)",
    );
    // the fix goes back through its round and the merge queue; Final Review runs again and passes
    await build(h, engineer, "export const x = 2;\n");
    const verify = spawns((await h.engine.next({}, CLAUDE)).actions);
    for (const r of verify) await verdictPass(h, r, "src/t-1/impl.ts");
    await h.engine.settle();
    expect(h.engine.status({}).features[0]?.status).toBe("final_review");
    await passFinalReview(h);
    await h.engine.settle();
    expect(h.engine.status({}).features[0]?.status).toMatch(/ready_to_ship|shipped/);
    await h.release();
  });

  it("a finding on a done task (in the open PR) becomes an integration-fix task naming it", async () => {
    const h = createHarness();
    const [verifier, security] = await toFinalReview(h);
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ done: 1 });
    await review(h, verifier!, "fail", "src/t-1/impl.ts:1");
    await review(h, security!, "pass", "src/t-1/impl.ts:1");
    await h.engine.settle();
    const created = events(h).filter((e) => e.type === "task.created");
    expect(created).toHaveLength(2);
    expect(created[1]?.data.task).toMatchObject({
      origin: "integration_fix",
      title: expect.stringContaining("Final Review fix for T-1") as unknown,
      files_scope: ["src/t-1/**"],
    });
    await h.release();
  });

  it("a finding no single task owns still becomes an integration-fix task", async () => {
    const h = createHarness();
    writeFile(h.repo, "docs/ops.md", "# ops\nline\n");
    git(h.repo, "add", "docs/ops.md");
    git(h.repo, "commit", "-q", "-m", "ops doc");
    const [verifier, security] = await toFinalReview(h);
    await review(h, verifier!, "fail", "docs/ops.md:1");
    await review(h, security!, "pass", "src/t-1/impl.ts:1");
    await h.engine.settle();
    expect(h.engine.status({}).features[0]).toMatchObject({ status: "fixing", round: 1 });
    expect(
      events(h).some(
        (e) => e.type === "task.created" && JSON.stringify(e.data).includes("integration_fix"),
      ),
    ).toBe(true);
    expect(
      events(h).some(
        (e) => e.type === "task.status_changed" && e.task === "T-1" && e.data.to === "fixing",
      ),
    ).toBe(false);
    await h.release();
  });
});
