/**
 * Automatic runs (AD-27 rule 2; D-cd, D-bw, H-7; spine §5 readings 187, 191 and 198): a normal run
 * started from an automatic issue, marked `run.started.automation`. Its issue is the spec, so the
 * human gates G1 and G2 are skipped (the engine records them approved), the Spec Verifier reads
 * the issue, it never runs at merge Level 3, and every gate, review and risk rule still applies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoBranchName,
  MERGE_LEVEL_LEDGER,
  TaskPackSchema,
  type AutomationRunRef,
  type LeadAction,
  type StartInput,
} from "@vtc/shared";
import { cleanupDirs, git, writeFile } from "../helpers/repo.js";
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
  spineFor,
  submitResult,
  threatModel,
  verdictPass,
  workdir,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 40_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  actor: string;
  role?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

const ISSUE: AutomationRunRef = {
  kind: "ci_failure",
  fingerprint: "0123456789abcdef",
  target: { kind: "project", repo: "acme/app" },
  issue: 42,
};

const REQUEST: StartInput = {
  request: "Fix the post-merge CI failure (#42)\n\nThe login test fails on main since F-1 merged.",
  track: "feature",
  repo: "existing",
  has_ui: false,
  risk_hints: [],
};

/**
 * DISCOVER, SPECIFY and DESIGN done as the roles would; returns the Planner's dispatch, or none
 * when the run stops before PLAN. `spine` writes the Architect's n-th spine (0-based).
 */
const drive = async (
  h: Harness,
  spine: (n: number) => string = () => spineFor(SPEC_ONE),
): Promise<{ planner: SpawnAction | undefined; seen: LeadAction[] }> => {
  const seen: LeadAction[] = [];
  let actions = (await h.engine.next({}, CLAUDE)).actions;
  seen.push(...actions);
  const carto = only(actions, "repo_cartographer");
  writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
  actions = (
    await submitResult(h, carto, {
      exit: "done",
      artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
    })
  ).actions;
  seen.push(...actions);
  const ba = only(actions, "ba");
  writeFile(workdir(ba), ".vtc/spec/spec.md", SPEC_ONE);
  actions = (
    await submitResult(h, ba, {
      exit: "done",
      artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
    })
  ).actions;
  seen.push(...actions);
  const pending = spawns(actions);
  const done = new Set<string>();
  let planner: SpawnAction | undefined;
  let architect = 0;
  for (let step = pending.shift(); step !== undefined; step = pending.shift()) {
    if (done.has(step.action_id)) continue;
    done.add(step.action_id);
    if (step.role === "planner") {
      planner = step;
      continue;
    }
    if (step.role === "security") actions = await threatModel(h, step);
    else {
      writeFile(workdir(step), ".vtc/architecture/spine.md", spine(architect));
      architect += 1;
      actions = (
        await submitResult(h, step, {
          exit: "done",
          artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
        })
      ).actions;
    }
    seen.push(...actions);
    pending.push(...spawns(actions));
  }
  return { planner, seen };
};

const frontHalf = async (h: Harness): Promise<{ planner: SpawnAction; seen: LeadAction[] }> => {
  const { planner, seen } = await drive(h);
  if (planner === undefined) throw new Error(`no planner: ${JSON.stringify(seen.at(-1))}`);
  return { planner, seen };
};

/** A spine that maps no requirement to a component: the DESIGN check fails. */
const UNMAPPED_SPINE = "# spine\n\nNo requirement map yet.\n";

describe("automatic runs (AD-27 rule 2)", () => {
  it("marks the run with its issue and skips G1 and G2: the engine approves them, no approve_gate reaches the Lead", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { seen } = await frontHalf(h);
    expect(seen.filter((a) => a.type === "approve_gate")).toEqual([]);
    const log = events(h);
    expect(log.find((e) => e.type === "run.started")?.data.automation).toEqual(ISSUE);
    const approvals = log.filter((e) => e.type === "gate.approved");
    expect(approvals.map((e) => [e.actor, e.data.gates])).toEqual([
      ["engine", ["G1"]],
      ["engine", ["G2"]],
    ]);
    expect(String(approvals[0]?.data.note)).toMatch(/issue #42 is its spec/);
    // what was approved was shown first, as for a human gate
    expect(log.filter((e) => e.type === "gate.requested")).toHaveLength(2);
    expect(h.engine.status({}).run.phase).toBe("plan");
    await h.release();
  });

  it("never approves a failed DESIGN check: the engine rejects G2 with the check's problems, and the Architect fixes it", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { planner, seen } = await drive(h, (n) =>
      n === 0 ? UNMAPPED_SPINE : spineFor(SPEC_ONE),
    );
    expect(planner).toBeDefined();
    expect(seen.filter((a) => a.type === "approve_gate")).toEqual([]);
    const log = events(h);
    const rejected = log.filter((e) => e.type === "gate.rejected");
    expect(rejected.map((e) => [e.actor, e.data.gates])).toEqual([["engine", ["G2"]]]);
    expect(String(rejected[0]?.data.note)).toMatch(
      /the DESIGN check failed: REQ-1 is mapped to no component/,
    );
    // the Architect ran again with the engine's note
    const architects = spawns(seen).filter((a) => a.role === "architect");
    expect(architects).toHaveLength(2);
    expect(architects[1]?.prompt).toMatch(
      /The engine rejected the gate: automatic run: the DESIGN check failed/,
    );
    // the G2 the engine approved is the one whose check passed
    const approvals = log.filter((e) => e.type === "gate.approved");
    expect(approvals.map((e) => [e.actor, e.data.gates])).toEqual([
      ["engine", ["G1"]],
      ["engine", ["G2"]],
    ]);
    expect(h.engine.status({}).run.phase).toBe("plan");
    await h.release();
  });

  it("leaves a DESIGN check that keeps failing for the human after its own bounded rejections", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { planner, seen } = await drive(h, () => UNMAPPED_SPINE);
    expect(planner).toBeUndefined();
    const log = events(h);
    expect(log.filter((e) => e.type === "gate.rejected").map((e) => e.actor)).toEqual([
      "engine",
      "engine",
    ]);
    expect(log.filter((e) => e.type === "gate.approved").map((e) => e.data.gates)).toEqual([
      ["G1"],
    ]);
    const gate = seen.findLast((a) => a.type === "approve_gate");
    expect(gate).toMatchObject({ type: "approve_gate", gates: ["G2"] });
    expect(h.engine.status({}).run.phase).toBe("g2");
    await h.release();
  });

  it("never runs at merge Level 3: a Level-3 project starts the automatic run at Level 2 with no Level-3 preflight", async () => {
    const h = createHarness({ project: { merge_level: 3 }, level3: true });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const log = events(h);
    expect(log.find((e) => e.type === "run.started")?.data.merge_level).toBe(2);
    expect(log.filter((e) => e.type === "merge.preflight")).toEqual([]);
    expect(h.engine.status({}).run.merge_level_effective).toBe(2);
    await h.release();
  });

  it("keeps a ledger downgrade below 2", async () => {
    const h = createHarness({ project: { merge_level: 3 }, level3: true });
    writeFile(
      h.repo,
      MERGE_LEVEL_LEDGER,
      `${JSON.stringify({ v: 1, at: "2026-10-13T08:00:00.000Z", kind: "downgrade", cap: 1, reason: "human", detail: "x" })}\n`,
    );
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    expect(events(h).find((e) => e.type === "run.started")?.data.merge_level).toBe(1);
    await h.release();
  });

  it("a run the human asked for keeps its human gates", async () => {
    const h = createHarness();
    await h.engine.start(REQUEST, CLAUDE);
    const actions = (await h.engine.next({}, CLAUDE)).actions;
    const carto = only(actions, "repo_cartographer");
    writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
    const ba = only(
      (
        await submitResult(h, carto, {
          exit: "done",
          artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
        })
      ).actions,
      "ba",
    );
    writeFile(workdir(ba), ".vtc/spec/spec.md", SPEC_ONE);
    const after = (
      await submitResult(h, ba, {
        exit: "done",
        artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
      })
    ).actions;
    expect(after.some((a) => a.type === "approve_gate")).toBe(true);
    expect(events(h).find((e) => e.type === "run.started")?.data.automation).toBeUndefined();
    await h.release();
  });

  it("pushes only to its vtc/auto branch and opens no unlabelled, evidence-less PR (AD-27 rules 1, 2, 3 and 6, H-8)", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { planner } = await frontHalf(h);
    const planned = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1")] as never,
    });
    if (!planned.accepted) throw new Error("plan rejected");
    await h.engine.settle();
    await authorTests(h, only((await h.engine.next({}, CLAUDE)).actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    const verifier = only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");
    await verdictPass(h, verifier, "src/t-1/impl.ts");
    await h.engine.settle();
    await passFinalReview(h);
    await h.engine.next({}, CLAUDE);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    const branch = autoBranchName(ISSUE.kind, ISSUE.fingerprint);
    expect(branch).toBe("vtc/auto/ci_failure/01234567");
    // the work is on the remote under the automatic branch only, never vtc/F-n
    const heads = git(h.remote, "for-each-ref", "--format=%(refname)", "refs/heads/")
      .trim()
      .split("\n");
    expect(heads.sort()).toEqual(["refs/heads/main", `refs/heads/${branch}`]);
    const integration = h.engine.status({}).features[0]?.integration_branch ?? "";
    expect(git(h.remote, "rev-parse", `refs/heads/${branch}`).trim()).toBe(
      git(h.repo, "rev-parse", integration).trim(),
    );
    const pushes = events(h).filter((e) => e.type === "branch.pushed");
    expect(pushes.length).toBeGreaterThan(0);
    // the events name the integration branch whose head went to the automatic one
    for (const e of pushes) expect(e.data.branch).toBe(integration);
    // no PR through the Level-2 seam: its draft PR is the upstream module's, labelled and with
    // evidence; until then the merged task is in no open PR
    expect(h.prs.calls).toEqual([]);
    expect(h.engine.status({}).features[0]?.pr).toBeUndefined();
    const statuses = events(h)
      .filter((e) => e.type === "task.status_changed")
      .map((e) => e.data.to);
    expect(statuses.at(-1)).toBe("merged");
    expect(statuses).not.toContain("done");
    await h.release();
  });

  it("records a refused push when its vtc/auto branch moved on the remote (never forced)", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    const branch = autoBranchName(ISSUE.kind, ISSUE.fingerprint);
    // a human's commit on the automatic branch, which VTC's work does not contain
    git(h.repo, "commit", "--quiet", "--allow-empty", "-m", "human");
    git(h.repo, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    const human = git(h.repo, "rev-parse", "HEAD").trim();
    git(h.repo, "reset", "--quiet", "--hard", "HEAD~1");
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { planner } = await frontHalf(h);
    const planned = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1")] as never,
    });
    if (!planned.accepted) throw new Error("plan rejected");
    await h.engine.settle();
    await authorTests(h, only((await h.engine.next({}, CLAUDE)).actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    const verifier = only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");
    await verdictPass(h, verifier, "src/t-1/impl.ts");
    await h.engine.settle();
    const failed = events(h).filter((e) => e.type === "branch.push_failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.data.detail).toContain(`push to ${branch}`);
    expect(git(h.remote, "rev-parse", `refs/heads/${branch}`).trim()).toBe(human);
    expect(h.prs.calls).toEqual([]);
    await h.release();
  });

  it("the Spec Verifier reads the issue (the run's request), and every gate still runs", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { planner } = await frontHalf(h);
    const planned = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1")] as never,
    });
    if (!planned.accepted) throw new Error("plan rejected");
    await h.engine.settle();
    const actions = (await h.engine.next({}, CLAUDE)).actions;
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    const verifier = only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");
    const pack = TaskPackSchema.parse(
      JSON.parse(readFileSync(join(h.repo, verifier.pack.replace(/\.md$/, ".json")), "utf8")),
    );
    const run = h.engine.status({}).run.id;
    expect(pack.inputs).toContainEqual({ type: "request", path: `.vtc/runs/${run}/request.md` });
    // the base-fail check and the round's gates ran as for any run
    expect(h.gates.requests.map((r) => r.reason)).toEqual(
      expect.arrayContaining(["base_fail_check", "round"]),
    );
    await h.release();
  });
});
