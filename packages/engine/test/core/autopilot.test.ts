/**
 * Autopilot (spine §5 reading 271), with synthetic data only: the owner asked to give VTC a task
 * and review only its PR. On an autopilot run the engine answers the questions it may decide with
 * their recommended option and approves the quick fix's combined G1+G2, and leaves what it may
 * never decide alone for the human.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { HostOutcome, LeadAction, Question } from "@vtc/shared";
import type { CallContext } from "../../src/core/index.js";
import { autopilotPrSection } from "../../src/core/autopilot.js";
import { humanLabels } from "../../src/lookback/attribution.js";
import { loadRuns } from "../../src/core/run-store.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  only,
  spawns,
  spineFor,
  submitResult,
  threatModel,
  workdir,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const SPEC = "# Spec\n\n## REQ-1 Order total\n\n- REQ-1.AC-1: the total shows on checkout\n";

const question = (over: Partial<Question> = {}): Question => ({
  question: "Web only, or the native apps too?",
  options: [
    { id: "web", label: "Web only", effect: "clarify" },
    { id: "both", label: "Web and native", effect: "clarify" },
  ],
  recommended: "web",
  evidence: [{ type: "spec_ref", ref: "REQ-1.AC-1" }],
  ...over,
});

const startQuickFix = async (h: Harness, autopilot?: boolean) => {
  await h.engine.start(
    {
      request: "Show the order total on checkout",
      track: "quick_fix",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
      ...(autopilot === undefined ? {} : { autopilot }),
    },
    CLAUDE,
  );
  const ba = only((await h.engine.next({}, CLAUDE)).actions, "ba");
  writeFile(workdir(ba), ".vtc/spec/order-total.md", SPEC);
  return submitResult(h, ba, {
    exit: "done",
    artifacts: [{ type: "spec", path: ".vtc/spec/order-total.md" }],
    questions: [question()],
  });
};

/** Runs DESIGN's roles as they come; returns the actions after the last. */
const runDesign = async (
  h: Harness,
  first: readonly LeadAction[],
): Promise<readonly LeadAction[]> => {
  let actions = first;
  const seen = new Set<string>();
  const pending: SpawnAction[] = [];
  const collect = (list: readonly LeadAction[]): void => {
    for (const a of spawns(list))
      if (!seen.has(a.action_id)) {
        seen.add(a.action_id);
        pending.push(a);
      }
  };
  collect(actions);
  for (let step = pending.shift(); step !== undefined; step = pending.shift()) {
    if (step.role === "planner") break;
    if (step.role === "security") actions = await threatModel(h, step);
    else {
      writeFile(workdir(step), ".vtc/architecture/spine.md", spineFor(SPEC));
      actions = (
        await submitResult(h, step, {
          exit: "done",
          artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
        })
      ).actions;
    }
    collect(actions);
  }
  return actions;
};

describe("autopilot (reading 271)", { timeout: 60_000 }, () => {
  it("answers the BA's question, approves G1+G2 and lists both for the PR", async () => {
    const h = createHarness();
    const out = await startQuickFix(h, true);
    expect(out.accepted).toBe(true);
    const actions = await runDesign(h, out.actions);
    expect(actions.some((a) => a.type === "ask_human" || a.type === "approve_gate")).toBe(false);
    expect(only(actions, "planner")).toBeDefined();
    const status = h.engine.status({});
    expect(status.run.phase).toBe("plan");
    expect(status.open_escalations).toBe(0);
    expect(status.autopilot).toEqual({ decisions: 2 });
    const [run] = loadRuns(h.repo);
    const [escalation] = run!.state.escalations.values();
    expect(escalation?.answer).toMatchObject({ option: "web", who_should_have_caught: "none" });
    const section = autopilotPrSection(run!.state);
    expect(section).toContain("Web only, or the native apps too? → Web only");
    expect(section).toContain("**G1+G2** approved `.vtc/spec/order-total.md`");
    // the engine's choice is not a human's attribution label
    expect(humanLabels(run!.state.events)).toEqual([]);
    const answered = run!.state.events.find((e) => e.type === "escalation.answered");
    expect(answered?.actor).toBe("engine");
    await h.release();
  });

  it("is on for every run when the project says so, and a run may turn it off", async () => {
    const on = createHarness({ project: { autopilot: true } });
    await startQuickFix(on);
    expect(on.engine.status({}).autopilot).toBeDefined();
    await on.release();
    const off = createHarness({ project: { autopilot: true } });
    const out = await startQuickFix(off, false);
    expect(off.engine.status({}).autopilot).toBeUndefined();
    expect(out.actions.some((a) => a.type === "ask_human")).toBe(true);
    await off.release();
  });

  it("without autopilot the human still answers and approves", async () => {
    const h = createHarness();
    const out = await startQuickFix(h);
    expect(out.actions.some((a) => a.type === "ask_human")).toBe(true);
    const actions = await runDesign(h, out.actions);
    expect(actions.some((a) => a.type === "approve_gate")).toBe(true);
    expect(actions.some((a) => a.type === "ask_human")).toBe(true);
    expect(h.engine.status({}).run.phase).toBe("g2");
    expect(h.engine.status({}).autopilot).toBeUndefined();
    await h.release();
  });

  it("leaves a question whose recommended option would drop the work for the human", async () => {
    const h = createHarness();
    const out = await startQuickFix(h, true);
    expect(out.accepted).toBe(true);
    // a second question whose recommendation drops the work: the human's call
    const architect = only(out.actions, "architect");
    writeFile(workdir(architect), ".vtc/architecture/spine.md", spineFor(SPEC));
    const after = await submitResult(h, architect, {
      exit: "done",
      artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
      questions: [
        question({
          question: "Drop the change?",
          options: [
            { id: "drop", label: "Drop it", effect: "drop" },
            { id: "keep", label: "Keep it", effect: "clarify" },
          ],
          recommended: "drop",
        }),
      ],
    });
    const security = spawns(out.actions).filter((a) => a.role === "security");
    const actions = await runDesign(h, [...security, ...after.actions]);
    expect(actions.some((a) => a.type === "ask_human")).toBe(true);
    expect(h.engine.escalations({}).escalations.map((e) => e.question)).toEqual([
      "Drop the change?",
    ]);
    // the BA's question was autopilot's; the gate waits while the human's question is open
    expect(h.engine.status({}).autopilot).toEqual({ decisions: 1 });
    expect(h.engine.status({}).run.phase).not.toBe("plan");
    await h.release();
  });

  it("caps the run at merge Level 2: it never merges into the default branch on its own", async () => {
    const h = createHarness({ project: { merge_level: 3 }, level3: true });
    await startQuickFix(h, true);
    expect(h.engine.status({}).run.merge_level_effective).toBe(2);
    await h.release();
  });
});

describe("next on an autopilot run with a Codex Lead (reading 271)", { timeout: 30_000 }, () => {
  const CODEX: CallContext = { host: "codex" };
  /** Every role keeps working until the engine stops it. */
  const working = (): Promise<HostOutcome> => new Promise<HostOutcome>(() => undefined);
  const begin = async (h: Harness, autopilot: boolean) => {
    await h.engine.start(
      {
        request: "Show the order total on checkout",
        track: "quick_fix",
        repo: "existing",
        has_ui: false,
        risk_hints: [],
        autopilot,
      },
      CODEX,
    );
    await h.engine.next({}, CODEX);
  };

  it("holds a wait on its own background roles, so the Lead needs no 'continue'", async () => {
    const h = createHarness({ codex: { headless: working }, nextWaitMs: 300 });
    await begin(h, true);
    const before = Date.now();
    const out = await h.engine.next({}, CODEX);
    expect(Date.now() - before).toBeGreaterThanOrEqual(250);
    expect(out.actions.map((a) => a.type)).toEqual(["wait"]);
    await h.engine.pause({});
    await h.release();
  });

  it("answers at once without autopilot", async () => {
    const h = createHarness({ codex: { headless: working }, nextWaitMs: 5_000 });
    await begin(h, false);
    const before = Date.now();
    const out = await h.engine.next({}, CODEX);
    expect(Date.now() - before).toBeLessThan(2_000);
    expect(out.actions.map((a) => a.type)).toEqual(["wait"]);
    await h.engine.pause({});
    await h.release();
  });
});
