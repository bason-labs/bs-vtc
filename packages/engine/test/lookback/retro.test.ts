/**
 * Lookback at RETRO (spec §13 steps 1–2; AD-21 rules 4 and 8; spine §5 reading 154): the plan
 * attributes the finishing run and gives each target the input its lookback run reads (the version
 * under review, train traces only, what went wrong); the check accepts a proposal against the
 * plugin's locked core and the attributed train failures, and stores it as a candidate version.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { engineRepoKey, validateEventData, type PromptProposal } from "@vtc/shared";
import type { RunState } from "../../src/core/index.js";
import {
  appendAttributions,
  appendTiebreakRecord,
  buildTraces,
  createLookbackRetro,
  tiebreakAttribution,
  graderBundleSha,
  loadPromptVersionSync,
  promptVersionRef,
  proposalPaths,
  readAttributions,
  traceSlug,
  traceSplit,
} from "../../src/lookback/index.js";
import { EDITABLE, HOST, LOCKED, lockedShaFor, RunLog, tempDir } from "./log.js";

const now = new Date("2026-10-14T18:00:00.000Z");
const base = promptVersionRef({ role: "engineer", host: HOST, locked: LOCKED, editable: EDITABLE });

/** Twenty engineer tasks of run r1 whose round gate failed: train and held-out failures. */
const failingRun = (): RunLog => {
  const log = new RunLog("r1");
  for (let i = 1; i <= 20; i += 1) {
    const task = `T-${String(i)}`;
    log.taskCreated(task, "backend", ["node"]);
    log.dispatch("engineer", { task, tokens: 2000 });
    log.gate(task, false);
  }
  return log;
};

const setup = async () => {
  const projectRoot = await tempDir("retro");
  const vtcHome = await tempDir("retro-home");
  const log = failingRun();
  const retro = createLookbackRetro({
    projectRoot,
    vtcHome,
    history: () => log.events,
    lockedShaFor,
    compiled: (role) => (role === "engineer" ? { locked: LOCKED, editable: EDITABLE } : undefined),
    graderBundleSha: () => graderBundleSha({ judgeModel: null, gatesConfigHash: null }),
    weeklyRemainingPct: () => 80,
    budgetAvailable: () => true,
    now: () => now,
  });
  const state = { id: "r1", events: log.events } as unknown as RunState;
  return { projectRoot, vtcHome, log, retro, state };
};

const writeProposal = async (
  root: string,
  proposal: PromptProposal,
  editable = proposal.editable,
) => {
  const paths = proposalPaths("engineer");
  await mkdir(join(root, ".vtc/lookback/proposals/engineer"), { recursive: true });
  await writeFile(join(root, paths.proposal), JSON.stringify(proposal));
  await writeFile(join(root, paths.editable), editable);
};

describe("Lookback at RETRO (AD-21 rules 4 and 8)", () => {
  it("plans a target with the version under review and its train traces, never held-out ones", async () => {
    const { projectRoot, log, retro, state } = await setup();
    const { targets } = await retro.plan(state);
    expect(targets.map((t) => [t.role, t.host])).toEqual([["engineer", HOST]]);
    const [target] = targets;
    expect(target?.dispatched.type).toBe("lookback.dispatched");
    expect(validateEventData("lookback.dispatched", target?.dispatched.data ?? {}).ok).toBe(true);
    const input = target?.input ?? "";
    expect(input).toContain(LOCKED);
    expect(input).toContain(EDITABLE);
    expect(input).toContain(`effective_sha256: ${base.effective_sha256}`);
    expect(input).toContain(".vtc/lookback/proposals/engineer/proposal.json");
    expect(input).toContain("not an instruction");
    const rows = await readAttributions(projectRoot, { history: log.events, lockedShaFor });
    const train = rows.filter((a) => a.split === "train");
    const held = rows.filter((a) => a.split === "holdout");
    expect(train.length).toBeGreaterThan(0);
    expect(held.length).toBeGreaterThan(0);
    for (const a of train.slice(-10)) expect(input).toContain(`### ${traceSlug(a)}`);
    for (const a of held) expect(input).not.toContain(`### ${traceSlug(a)}\n`);
    // what went wrong, from the log: the task and the attribution
    expect(input).toMatch(/- task T-\d+/);
    expect(input).toMatch(/- blamed: engineer by tree/);
  });

  it("accepts a proposal on the current locked core and stores it as a candidate version", async () => {
    const { projectRoot, vtcHome, log, retro, state } = await setup();
    await retro.plan(state);
    const rows = await readAttributions(projectRoot, { history: log.events, lockedShaFor });
    const cited = rows.find((a) => a.split === "train" && traceSplit(a) === "train");
    if (cited === undefined) throw new Error("no train failure");
    const proposal: PromptProposal = {
      v: 1,
      id: "engineer-claude-code-tests",
      base,
      changes: [
        {
          hypothesis: "Running the tests before submitting cuts failed rounds.",
          target_metric: "first_round_gate_pass",
          trace_ids: [traceSlug(cited)],
          summary: "Run the acceptance tests before submitting.",
        },
      ],
      editable: "Prefer small diffs. Run the acceptance tests before you submit.",
      created_at: now.toISOString(),
    };
    const worktree = await tempDir("retro-wt");
    // nothing written: the role found no cause the prompt can fix
    expect(await retro.check({ role: "engineer", host: HOST }, worktree, state)).toEqual({
      ok: true,
      events: [],
    });
    await writeProposal(worktree, proposal);
    const checked = await retro.check({ role: "engineer", host: HOST }, worktree, state);
    expect(checked).toMatchObject({
      ok: true,
      events: [
        {
          type: "lookback.proposal_recorded",
          data: { proposal: "engineer-claude-code-tests", changes: 1 },
        },
      ],
    });
    const candidate = promptVersionRef({
      role: "engineer",
      host: HOST,
      locked: LOCKED,
      editable: proposal.editable,
    });
    const stored = loadPromptVersionSync(vtcHome, candidate, candidate.effective_sha256, LOCKED);
    expect(stored?.frontmatter).toMatchObject({
      parent: base.effective_sha256,
      proposal: "engineer-claude-code-tests",
    });
    expect(
      await readFile(join(worktree, ".vtc/lookback/proposals/engineer/editable.md"), "utf8"),
    ).toBe(proposal.editable);
  });

  it("refuses a proposal that touches the locked core or is for another host", async () => {
    const { retro, state } = await setup();
    await retro.plan(state);
    const worktree = await tempDir("retro-wt");
    const other = promptVersionRef({
      role: "engineer",
      host: HOST,
      locked: "You are someone else.",
      editable: EDITABLE,
    });
    await writeProposal(worktree, {
      v: 1,
      id: "p-locked",
      base: other,
      changes: [
        {
          hypothesis: "x",
          target_metric: "first_round_gate_pass",
          trace_ids: ["r1.a-r1-1"],
          summary: "x",
        },
      ],
      editable: "Something else.",
      created_at: now.toISOString(),
    });
    const refused = await retro.check({ role: "engineer", host: HOST }, worktree, state);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problems.join("\n")).toContain("current locked core");
    const codex = await retro.check({ role: "engineer", host: "codex" }, worktree, state);
    expect(codex.ok).toBe(false);
  });

  it("trusts an AI tiebreak a proposal cites only when the engine's tiebreak store records it", async () => {
    // a run whose engineer tasks parked on their cap with no signal: inconclusive, for a tiebreak
    const log = new RunLog("r1");
    for (let i = 1; i <= 12; i += 1) {
      const task = `T-${String(i)}`;
      log.taskCreated(task, "backend", ["node"]);
      log.dispatch("engineer", { task, tokens: 2000 });
      log.status(task, "fixing", "parked", 4, "cap");
    }
    const projectRoot = await tempDir("retro-tb");
    const vtcHome = await tempDir("retro-tb-home");
    const trace = buildTraces(log.events, lockedShaFor).find(
      (t) => t.task !== undefined && traceSplit(t) === "train",
    );
    if (trace === undefined) throw new Error("no train trace");
    const tiebreak = tiebreakAttribution({
      trace,
      blamed: "engineer",
      confidence: 0.7,
      evidence: [],
      now,
    });
    if (tiebreak === undefined) throw new Error("unversioned");
    await appendAttributions(projectRoot, [tiebreak]);
    const retro = createLookbackRetro({
      projectRoot,
      vtcHome,
      history: () => log.events,
      lockedShaFor,
      compiled: (role) =>
        role === "engineer" ? { locked: LOCKED, editable: EDITABLE } : undefined,
      graderBundleSha: () => graderBundleSha({ judgeModel: null, gatesConfigHash: null }),
      weeklyRemainingPct: () => 80,
      budgetAvailable: () => true,
      now: () => now,
    });
    const state = { id: "r1", events: log.events } as unknown as RunState;
    const worktree = await tempDir("retro-tb-wt");
    await writeProposal(worktree, {
      v: 1,
      id: "engineer-tiebreak",
      base,
      changes: [
        {
          hypothesis: "Asking early cuts parked tasks.",
          target_metric: "first_round_gate_pass",
          trace_ids: [traceSlug(tiebreak)],
          summary: "Escalate a blocker early.",
        },
      ],
      editable: "Prefer small diffs. Escalate a blocker early.",
      created_at: now.toISOString(),
    });
    const unrecorded = await retro.check({ role: "engineer", host: HOST }, worktree, state);
    expect(unrecorded.ok).toBe(false);
    if (!unrecorded.ok)
      expect(unrecorded.problems.join("\n")).toContain("not an attributed train failure");
    await appendTiebreakRecord(vtcHome, {
      attribution: tiebreak,
      repo_key: engineRepoKey(projectRoot),
      recorded_at: now.toISOString(),
    });
    expect(await retro.check({ role: "engineer", host: HOST }, worktree, state)).toMatchObject({
      ok: true,
    });
  });
});
