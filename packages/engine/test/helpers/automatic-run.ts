/**
 * Driving an automatic run (AD-27 rule 2; `Engine.startAutomatic`) through the engine harness:
 * its issue, its request, the front half (DISCOVER, SPECIFY, DESIGN, with G1 and G2 approved by
 * the engine) and the whole run to its release.
 */
import type { AutomationRunRef, LeadAction, StartInput } from "@vtc/shared";
import {
  authorTests,
  build,
  CLAUDE,
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
} from "./engine-harness.js";
import { writeFile } from "./repo.js";

export const ISSUE: AutomationRunRef = {
  kind: "ci_failure",
  fingerprint: "0123456789abcdef",
  target: { kind: "project", repo: "acme/app" },
  issue: 42,
};

export const REQUEST: StartInput = {
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
export const drive = async (
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

export const frontHalf = async (
  h: Harness,
): Promise<{ planner: SpawnAction; seen: LeadAction[] }> => {
  const { planner, seen } = await drive(h);
  if (planner === undefined) throw new Error(`no planner: ${JSON.stringify(seen.at(-1))}`);
  return { planner, seen };
};
/**
 * The whole automatic run with one task, through Final Review to its release (at merge Level 2 its
 * work is pushed to its `vtc/auto` branch) and RETRO.
 */
export const driveToRelease = async (h: Harness): Promise<void> => {
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
};
