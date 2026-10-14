/**
 * RETRO (§6.1; spec §13 steps 1–2; spine AD-21 rules 4 and 8, §5 reading 154): after the release
 * and before `run.finished`, the engine runs the lookback role for every target the wired Lookback
 * returns, one at a time, reading the input the engine wrote; it checks the role's proposal on
 * submit (a refusal is a rejection, three skip the target) and finishes the run once every target
 * is settled. Without Lookback, with no target, or when its planning fails, the run finishes at once.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDraft, LookbackRetro, LookbackTargetRef } from "../../src/core/index.js";
import { ALL_FIXTURE_ROLES, FIXTURE_LOOKBACK } from "../fixtures/roles.js";
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
  workdir,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

const PROPOSAL = ".vtc/lookback/proposals/engineer/proposal.json";
const EDITABLE = ".vtc/lookback/proposals/engineer/editable.md";

const dispatched = (role: string): EventDraft => ({
  type: "lookback.dispatched",
  actor: "engine",
  data: { target_role: role, target_host: "claude-code", train_failures: 5 },
});

const recorded: EventDraft = {
  type: "lookback.proposal_recorded",
  actor: "engine",
  data: { proposal: "p-1", path: PROPOSAL, changes: 1 },
};

/** A Lookback fake: `targets` from the plan, `verdicts` from each check in turn. */
const fakeLookback = (
  targets: readonly string[],
  verdicts: Awaited<ReturnType<LookbackRetro["check"]>>[] = [],
  plan?: () => Promise<never>,
) => {
  const plans: string[] = [];
  const checks: { target: LookbackTargetRef; root: string }[] = [];
  const retro: LookbackRetro = {
    plan: async (state) => {
      plans.push(state.id);
      if (plan !== undefined) return plan();
      return {
        targets: targets.map((role) => ({
          role,
          host: "claude-code" as const,
          dispatched: dispatched(role),
          input: `# Lookback input: ${role}\n`,
        })),
      };
    },
    check: (target, root) => {
      checks.push({ target, root });
      return Promise.resolve(verdicts.shift() ?? { ok: true, events: [] });
    },
  };
  return { retro, plans, checks };
};

/** One task delivered at Level 1: the release starts RETRO. Returns the Lead's pending spawns. */
const toRetro = async (h: Harness): Promise<SpawnAction[]> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
  await verdictPass(
    h,
    only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
    "src/t-1/impl.ts",
  );
  await h.engine.settle();
  const after = spawns(await passFinalReview(h));
  await h.engine.settle();
  return [...after, ...spawns((await h.engine.next({}, CLAUDE)).actions)];
};

const propose = (h: Harness, action: SpawnAction) => {
  writeFile(workdir(action), PROPOSAL, '{"v":1}\n');
  writeFile(workdir(action), EDITABLE, "Write the failing test first.\n");
  return submitResult(h, action, {
    exit: "done",
    artifacts: [
      { type: "prompt_proposal", path: PROPOSAL },
      { type: "prompt_proposal", path: EDITABLE },
    ],
  });
};

const harness = () =>
  createHarness({ project: { merge_level: 1 }, roles: [...ALL_FIXTURE_ROLES, FIXTURE_LOOKBACK] });

describe("RETRO: the lookback role before run.finished (AD-21 rules 4 and 8)", () => {
  it("runs the lookback role on its input, records an accepted proposal, then finishes", async () => {
    const h = harness();
    const fake = fakeLookback(["engineer"], [{ ok: true, events: [recorded] }]);
    h.engine.setLookbackRetro(fake.retro);
    const pending = await toRetro(h);
    const run = h.engine.status({}).run;
    expect(run).toMatchObject({ phase: "retro" });
    expect(run.finished_at).toBeUndefined();
    expect(fake.plans).toEqual([run.id]);
    const input = `.vtc/runs/${run.id}/lookback-1.md`;
    expect(readFileSync(join(h.repo, input), "utf8")).toBe("# Lookback input: engineer\n");
    expect(events(h).filter((e) => e.type === "lookback.dispatched")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ target_role: "engineer" }) as unknown,
      }),
    ]);
    const lookback = only(pending, "lookback");
    expect(lookback.prompt).toContain("engineer on claude-code");
    expect(readFileSync(join(h.repo, lookback.pack), "utf8")).toContain(`traces: ${input}`);
    const out = await propose(h, lookback);
    expect(out.accepted).toBe(true);
    await h.engine.settle();
    // the check read the proposal in the role's own worktree, before it reached the checkout
    expect(fake.checks).toEqual([
      {
        target: expect.objectContaining({ role: "engineer", host: "claude-code" }) as unknown,
        root: workdir(lookback),
      },
    ]);
    expect(events(h).filter((e) => e.type === "lookback.proposal_recorded")).toHaveLength(1);
    expect(existsSync(join(h.repo, PROPOSAL))).toBe(true);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a refused proposal is a rejection the role answers; three skip the target", async () => {
    const h = harness();
    const refused = { ok: false as const, problems: ["cites held-out trace r1.a-2"] };
    const fake = fakeLookback(["engineer", "qa"], [refused, refused, refused]);
    h.engine.setLookbackRetro(fake.retro);
    let action = only(await toRetro(h), "lookback");
    for (let i = 0; i < 3; i += 1) {
      const out = await propose(h, action);
      expect(out).toMatchObject({
        accepted: false,
        rejection: { reason: "claim_check", issues: ["cites held-out trace r1.a-2"] },
      });
      await h.engine.settle();
      action = only(
        [...spawns(out.actions), ...spawns((await h.engine.next({}, CLAUDE)).actions)],
        "lookback",
      );
      if (i < 2) {
        expect(action.prompt).toContain("engineer on claude-code");
        expect(action.prompt).toMatch(/previous proposal was refused/);
      }
    }
    // the engineer target was skipped; the qa target is next
    expect(action.prompt).toContain("qa on claude-code");
    expect(h.engine.status({}).run.finished_at).toBeUndefined();
    // a role that finds no cause the prompt can fix writes nothing and is accepted
    expect((await submitResult(h, action, { exit: "done" })).accepted).toBe(true);
    await h.engine.settle();
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    expect(spawns((await h.engine.next({}, CLAUDE)).actions)).toEqual([]);
    await h.release();
  });

  it("no target, or a plan that fails, finishes the run at once; the failure is a notice", async () => {
    const quiet = harness();
    const none = fakeLookback([]);
    quiet.engine.setLookbackRetro(none.retro);
    await toRetro(quiet);
    expect(none.plans).toHaveLength(1);
    expect(quiet.engine.status({}).run.finished_at).toBeDefined();
    await quiet.release();

    const broken = harness();
    const failing = fakeLookback([], [], () =>
      Promise.reject(new Error("attributions unreadable")),
    );
    broken.engine.setLookbackRetro(failing.retro);
    await toRetro(broken);
    expect(broken.engine.status({}).run.finished_at).toBeDefined();
    expect(broken.engine.notices.join("\n")).toContain("attributions unreadable");
    await broken.release();
  });

  it("without Lookback wired the release finishes the run as before", async () => {
    const h = harness();
    await toRetro(h);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    expect(events(h).some((e) => e.type === "lookback.dispatched")).toBe(false);
    await h.release();
  });
});
