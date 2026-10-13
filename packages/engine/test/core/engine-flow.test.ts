/**
 * The build loop end to end (§4.2, §6.1–6.7): front half → plan → per-task pipelines driven
 * through next()/submit() → merge queue (Level 2: push to a local bare remote, draft PR) →
 * Final Review gates → release → done; then a replay of the log rebuilds the same state.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEventLog, StatusResultSchema, NextResultSchema } from "@vtc/shared";
import { cleanupDirs, git } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  spawns,
  throughPlan,
  verdictPass,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

describe("engine: the happy path, Level 2", () => {
  it("takes two dependent tasks from plan to a ready PR and finishes the run", async () => {
    const h = createHarness();
    let actions = await throughPlan(h, [draft("T-1"), draft("T-2", { covers: ["REQ-2"], after: ["T-1"] })]);
    const status = h.engine.status({});
    expect(status.run.phase).toBe("build");
    expect(status.features[0]).toMatchObject({ id: "F-1", title: "Password reset", tasks: ["T-1", "T-2"], budget_usd: 10 });
    expect(status.tasks_by_status).toEqual({ ready: 1, waiting_dependency: 1 });

    // T-1: QA author → base-fail check → Engineer → gates → Spec-Verifier → merge queue
    const qa = only(actions, "qa");
    expect(qa).toMatchObject({ mode: "author", task: "T-1", agent: "vtc-qa-author", background: true });
    expect(readFileSync(join(h.repo, qa.pack), "utf8")).toContain("## Intent contract");
    await authorTests(h, qa);
    const baseCheck = h.gates.requests.find((r) => r.reason === "base_fail_check");
    expect(baseCheck).toMatchObject({ expect: "fail", tests: ["[REQ-1.AC-1] works"] });
    actions = (await h.engine.next({}, CLAUDE)).actions;
    const engineer = only(actions, "engineer");
    expect(h.engine.status({}).tasks_by_status.building).toBe(1);
    await build(h, engineer);
    const round = h.gates.requests.find((r) => r.reason === "round");
    expect(round?.protected.map((p) => p.path).sort()).toEqual(["tests/acceptance/t-1.test.ts", "vitest.config.ts"]);
    expect(round?.include_hidden).toBe(true);
    actions = (await h.engine.next({}, CLAUDE)).actions;
    const verifier = only(actions, "spec_verifier");
    expect(verifier.subject).toBe("REQ-1.AC-1");
    await verdictPass(h, verifier, "src/t-1/impl.ts");
    await h.engine.settle();
    expect(git(h.repo, "log", "--oneline", "vtc/F-1").split("\n").length).toBeGreaterThan(1);
    expect(git(h.remote, "rev-parse", "vtc/F-1")).toBe(git(h.repo, "rev-parse", "vtc/F-1"));
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ done: 1 });
    expect(h.engine.status({}).features[0]?.pr).toMatchObject({ draft: true, state: "open" });
    expect(existsSync(join(h.repo, ".vtc/evidence/T-1/bundle.json"))).toBe(true);

    // T-2 starts only now (its dependency is merged) and branches from the integration branch
    actions = (await h.engine.next({}, CLAUDE)).actions;
    const qa2 = only(actions, "qa");
    expect(qa2.task).toBe("T-2");
    await authorTests(h, qa2, "REQ-2.AC-1");
    const engineer2 = only((await h.engine.next({}, CLAUDE)).actions, "engineer");
    expect(existsSync(join(h.repo, ".vtc/state/worktrees/T-2/src/t-1/impl.ts"))).toBe(true);
    await build(h, engineer2);
    const verifier2 = only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");
    await verdictPass(h, verifier2, "src/t-2/impl.ts");
    await h.engine.settle();

    // Final Review gates on the integrated branch, release, retro
    expect(h.gates.requests.some((r) => r.reason === "final_review" && r.scope === "full")).toBe(true);
    const done = await h.engine.next({}, CLAUDE);
    expect(NextResultSchema.parse(done).actions).toEqual([{ type: "done", summary: expect.stringContaining("summary.md") as unknown }]);
    const final = StatusResultSchema.parse(h.engine.status({}));
    expect(final.run.phase).toBe("retro");
    expect(final.run.finished_at).toBeDefined();
    expect(final.features[0]).toMatchObject({ status: "ready_to_ship", pr: { draft: false } });
    expect(h.prs.calls.at(-1)).toBe("ready vtc/F-1");
    expect(existsSync(join(h.repo, ".vtc/evidence/F-1/bundle.json"))).toBe(true);
    expect(readFileSync(join(h.repo, ".vtc/tasks/T-1.md"), "utf8")).toContain("<intent-contract>");
    expect(h.spawned).toEqual([]);

    // the log replays to the same state (AD-7 rule 5)
    const log = parseEventLog(readFileSync(join(h.repo, `.vtc/runs/${final.run.id}/events.jsonl`), "utf8"));
    expect(log.invalidLines).toEqual([]);
    const reopened = h.reopen();
    expect(reopened.status({ run: final.run.id })).toEqual(final);
    h.release();
  }, 60_000);
});

describe("engine: tool contract (AD-4 rule 1)", () => {
  it("rejects unknown, duplicate and stale actions, and results that do not conform", async () => {
    const h = createHarness();
    await h.engine.start({ request: "Idea", track: "feature", repo: "existing", has_ui: false, risk_hints: [] }, CLAUDE);
    const carto = only((await h.engine.next({}, CLAUDE)).actions, "repo_cartographer");
    const unknown = await h.engine.submit({ kind: "result", action_id: "a-99", result: { role: "ba", exit: "done", summary: "x", verdicts: [], findings: [], questions: [], artifacts: [], claims: [] } }, CLAUDE);
    expect(unknown).toMatchObject({ accepted: false, rejection: { reason: "unknown_action" } });
    const wrongRole = await h.engine.submit({ kind: "result", action_id: carto.action_id, result: { role: "ba", exit: "done", summary: "x", verdicts: [], findings: [], questions: [], artifacts: [], claims: [] } }, CLAUDE);
    expect(wrongRole).toMatchObject({ accepted: false, rejection: { reason: "dispatch_mismatch" } });
    const stale = await h.engine.submit({ kind: "result", action_id: carto.action_id, result: { role: "repo_cartographer", exit: "done", summary: "x", verdicts: [], findings: [], questions: [], artifacts: [], claims: [] } }, CLAUDE);
    expect(stale).toMatchObject({ accepted: false, rejection: { reason: "stale_action" } });
    const again = only(wrongRole.actions, "repo_cartographer");
    expect(again.prompt).toContain("rejected (dispatch_mismatch)");
    const missing = await h.engine.submit({ kind: "result", action_id: again.action_id, result: { role: "repo_cartographer", exit: "done", summary: "x", verdicts: [], findings: [], questions: [], artifacts: [{ type: "repo_map", path: ".vtc/research/nope.md" }], claims: [] } }, CLAUDE);
    expect(missing).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    const third = only(missing.actions, "repo_cartographer");
    const undeclared = await h.engine.submit({ kind: "result", action_id: third.action_id, result: { role: "repo_cartographer", exit: "built", summary: "x", verdicts: [], findings: [], questions: [], artifacts: [], claims: [] } }, CLAUDE);
    expect(undeclared).toMatchObject({ accepted: false, rejection: { reason: "undeclared_exit" } });
    const log = readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8");
    expect(log.match(/"type":"role\.rejected"/g)).toHaveLength(3);
    h.release();
  });
  it("refuses a gate approval whose artifact changed since it was shown (§6.2)", async () => {
    const h = createHarness();
    await h.engine.start({ request: "Fix", track: "quick_fix", repo: "existing", has_ui: false, risk_hints: [] }, CLAUDE);
    const ba = only((await h.engine.next({}, CLAUDE)).actions, "ba");
    const { writeFile } = await import("../helpers/repo.js");
    writeFile(h.repo, ".vtc/spec/spec.md", "# spec\n\n## REQ-1 x\n");
    const { submitResult } = await import("../helpers/engine-harness.js");
    const architect = only((await submitResult(h, ba, { exit: "done", artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }] })).actions, "architect");
    writeFile(h.repo, ".vtc/architecture/spine.md", "# spine\n");
    const actions = (await submitResult(h, architect, { exit: "done", artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }] })).actions;
    const gate = actions.find((a) => a.type === "approve_gate");
    expect(gate).toMatchObject({ gates: ["G1", "G2"] });
    if (gate?.type !== "approve_gate") throw new Error("no gate");
    writeFile(h.repo, ".vtc/spec/spec.md", "# spec changed\n");
    await expect(h.engine.approve({ gates: ["G1", "G2"], decision: "approve", frozen: gate.artifacts, waived_facts: [] }, CLAUDE)).rejects.toThrow(/not shown/);
    expect(spawns((await h.engine.next({}, CLAUDE)).actions)).toEqual([]);
    h.release();
  });
});
