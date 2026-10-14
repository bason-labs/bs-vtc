/**
 * The Visual QA judge (spec §7.5 step 6, §6.7a step 5, §9.1; spine §5 reading 92, §7 "Visual QA
 * not attached"): once the deterministic visual step rendered a UI round's screens, the engine
 * attaches three Visual QA calls fed the step's report and render evidence, and a 2-of-3 vote per
 * criterion decides; `unchecked` never passes. A round whose visual step did not render (skipped:
 * no browser) attaches no judge. Final Review step 5 judges every screen of the feature the same
 * way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VISUAL_SKIPPED_NO_BROWSER,
  type GateReport,
  type GateRunRequest,
  type VisualSummary,
} from "@vtc/shared";
import { reviewersFor, VISUAL_QA } from "../../src/core/router.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  SPEC_ONE,
  spawns,
  submitResult,
  throughPlan,
  verdictPass,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

const SCREENS = [
  "version: 1",
  "screens:",
  "  - id: reset-request",
  "    route: /reset",
  "    states: [empty]",
  "    reqs: [REQ-1]",
  "",
].join("\n");

const ROUND_REPORT = ".vtc/evidence/T-1/gates/1/visual/report.json";
const FINAL_REPORT = ".vtc/evidence/F-1/gates/1/visual/report.json";
const SHOT = ".vtc/evidence/T-1/gates/1/visual/reset-390.png";

const summary = (over: Partial<VisualSummary>): VisualSummary => ({
  status: "pass",
  report: ROUND_REPORT,
  counts: {
    renders: 2,
    unreached: 0,
    axe_violations: 0,
    axe_incomplete: 0,
    style_mismatches: 0,
    diffs_over_budget: 0,
    token_lint: 0,
    detector: 0,
  },
  findings: [],
  ...over,
});

interface Line {
  type: string;
  feature?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

/** The `type: path` lines of a pack's Inputs section. */
const inputsOf = (h: Harness, action: SpawnAction): string[] =>
  (readFileSync(join(h.repo, action.pack), "utf8").split("## Inputs\n")[1] ?? "")
    .split("\n## ")[0]
    ?.trim()
    .split("\n")
    .map((l) => l.replace(/^- /, "")) ?? [];

/** A frontend task of a UI run, built; its round's visual step reports `round`. */
const builtUiTask = async (
  h: Harness,
  round: VisualSummary,
  final: VisualSummary = summary({ report: FINAL_REPORT }),
): Promise<SpawnAction[]> => {
  h.gates.reshape((request: GateRunRequest, report: GateReport): GateReport => {
    if (request.reason === "round") return { ...report, visual: round };
    if (request.reason === "final_review") return { ...report, visual: final };
    return report;
  });
  const actions = await throughPlan(h, [draft("T-1", { discipline: "frontend" })], SPEC_ONE, {
    screens: SCREENS,
  });
  await authorTests(h, only(actions, "qa"));
  await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
  writeFile(h.repo, SHOT, "png");
  return spawns((await h.engine.next({}, CLAUDE)).actions);
};

const judge = (
  h: Harness,
  action: SpawnAction,
  verdicts: readonly { subject: string; verdict: "pass" | "fail" | "unchecked" }[],
) =>
  submitResult(h, action, {
    exit: "done",
    ...(action.feature !== undefined && action.task === undefined
      ? { feature: action.feature }
      : {}),
    verdicts: verdicts.map((v) => ({
      ...v,
      question_type: "structure_content",
      evidence: [{ type: "screenshot", ref: SHOT }],
    })),
  });

type Plan = readonly { subject: string; verdict: "pass" | "fail" | "unchecked" }[];

/** A feature-level reviewer's passing verdict (Final Review steps 3–4). */
const featurePass = (h: Harness, action: SpawnAction) =>
  submitResult(h, action, {
    exit: "done",
    feature: action.feature,
    verdicts: [
      {
        subject: action.subject ?? "F-1",
        verdict: "pass",
        evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
      },
    ],
  });

/**
 * Answers every reviewer the engine hands out (`first`, then each `next`) until three Visual QA
 * calls were judged: call i gets `plans[i]`, every other reviewer passes. Returns the judges.
 */
const drain = async (
  h: Harness,
  first: readonly SpawnAction[],
  plans: readonly Plan[],
): Promise<{ judges: SpawnAction[]; rest: SpawnAction[] }> => {
  const judges: SpawnAction[] = [];
  const queue = [...first];
  for (let turn = 0; turn < 20 && judges.length < plans.length; turn += 1) {
    while (queue.length > 0 && judges.length < plans.length) {
      const action = queue.shift()!;
      const answer =
        action.role === "visual_qa"
          ? await judge(h, action, plans[judges.length] ?? [])
          : action.task === undefined
            ? await featurePass(h, action)
            : await verdictPass(h, action, "src/t-1/impl.ts");
      if (!answer.accepted) throw new Error(JSON.stringify(answer));
      if (action.role === "visual_qa") judges.push(action);
      queue.push(...spawns(answer.actions));
    }
    if (judges.length >= plans.length) break;
    await h.engine.settle();
    queue.push(...spawns((await h.engine.next({}, CLAUDE)).actions));
    if (queue.length === 0) break;
  }
  return { judges, rest: queue };
};

const allPass: Plan = [{ subject: "V1", verdict: "pass" }];

describe("the Visual QA judge on UI rounds (§7.5 step 6)", () => {
  it("is attached: the router adds three calls once the round's visual step rendered", () => {
    expect(VISUAL_QA.attached).toBe(true);
    const task = {
      id: "T-1",
      risk: "med" as const,
      risk_tags: [],
      discipline: "frontend" as const,
      covers: ["REQ-1"],
    };
    const run = { has_ui: true, risk_hints: [] };
    expect(
      reviewersFor(task, run, [], { visual: true }).filter((s) => s.role === "visual_qa"),
    ).toHaveLength(3);
    // no rendered screens (no visual step, or skipped with no browser): no judge
    expect(reviewersFor(task, run, []).filter((s) => s.role === "visual_qa")).toHaveLength(0);
    // a backend task of a UI run has no screens
    expect(
      reviewersFor({ ...task, discipline: "backend" }, run, [], { visual: true }).filter(
        (s) => s.role === "visual_qa",
      ),
    ).toHaveLength(0);
  });

  it("dispatches three calls fed the round's visual report and renders; a 2-of-3 fail is a finding", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const reviewers = await builtUiTask(h, summary({}));
    expect(reviewers.some((r) => r.role === "visual_qa")).toBe(true);
    const { judges } = await drain(h, reviewers, [
      [
        { subject: "V1", verdict: "pass" },
        { subject: "V4", verdict: "fail" },
      ],
      [
        { subject: "V1", verdict: "fail" },
        { subject: "V4", verdict: "fail" },
      ],
      [
        { subject: "V1", verdict: "pass" },
        { subject: "V4", verdict: "pass" },
      ],
    ]);
    expect(judges).toHaveLength(3);
    for (const j of judges) {
      expect(j.task).toBe("T-1");
      expect(inputsOf(h, j)).toEqual(
        expect.arrayContaining([
          `visual_report: ${ROUND_REPORT}`,
          "screenshots: .vtc/evidence/T-1/gates/1/visual",
        ]),
      );
      expect(j.prompt).toContain(ROUND_REPORT);
    }
    // V4 failed in two of three calls; V1 in only one
    const visual = events(h)
      .filter((e) => e.type === "finding.recorded")
      .map((e) => e.data.finding as { source_name: string })
      .filter((f) => f.source_name === "visual_qa");
    expect(visual).toHaveLength(1);
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ fixing: 1 });
    await h.release();
  });

  it("an unchecked criterion in two calls blocks the pass", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const reviewers = await builtUiTask(h, summary({}));
    await drain(h, reviewers, [
      [{ subject: "V4", verdict: "unchecked" }],
      [{ subject: "V4", verdict: "unchecked" }],
      [{ subject: "V4", verdict: "pass" }],
    ]);
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ fixing: 1 });
    expect(
      events(h).some(
        (e) =>
          e.type === "finding.recorded" &&
          (e.data.finding as { source_name: string }).source_name === "visual_qa",
      ),
    ).toBe(true);
    await h.release();
  });

  it("a skipped visual step (no browser) attaches no judge: the note stands", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const reviewers = await builtUiTask(
      h,
      summary({ status: "skipped", skipped_reason: VISUAL_SKIPPED_NO_BROWSER, report: null }),
    );
    expect(reviewers.map((r) => r.role)).toEqual(["spec_verifier"]);
    await h.release();
  });
});

/** The task's round judged clean, merged; returns Final Review's first reviewers. */
const toFinalReview = async (
  h: Harness,
  final: VisualSummary = summary({ report: FINAL_REPORT }),
): Promise<SpawnAction[]> => {
  const reviewers = await builtUiTask(h, summary({}), final);
  const { rest } = await drain(h, reviewers, [allPass, allPass, allPass]);
  await h.engine.settle();
  return [...rest, ...spawns((await h.engine.next({}, CLAUDE)).actions)];
};

describe("Final Review step 5: Visual QA on full user journeys (§6.7a)", () => {
  it("judges every screen of the feature with three calls; a passing vote passes step 5", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const final = await toFinalReview(h);
    const { judges } = await drain(h, final, [
      [{ subject: "V1", verdict: "pass" }],
      [{ subject: "V1", verdict: "fail" }],
      [{ subject: "V1", verdict: "pass" }],
    ]);
    expect(judges).toHaveLength(3);
    for (const j of judges) {
      expect([j.feature, j.task, j.subject]).toEqual(["F-1", undefined, undefined]);
      expect(inputsOf(h, j)).toEqual(expect.arrayContaining([`visual_report: ${FINAL_REPORT}`]));
      expect(j.prompt).toContain("Final Review step 5");
    }
    const step5 = events(h)
      .filter((e) => e.type === "final_review.step_finished" && e.data.step === 5)
      .map((e) => e.data.status);
    // the deterministic part first, then the judge's vote
    expect(step5).toEqual(["pass", "pass"]);
    expect(h.engine.status({}).features[0]?.status).toBe("ready_to_ship");
    await h.release();
  });

  it("a 2-of-3 failing vote fails step 5 and sends the feature to a fix round", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const final = await toFinalReview(h);
    await drain(h, final, [
      [{ subject: "V3", verdict: "fail" }],
      [{ subject: "V3", verdict: "fail" }],
      [{ subject: "V3", verdict: "pass" }],
    ]);
    const step5 = events(h)
      .filter((e) => e.type === "final_review.step_finished" && e.data.step === 5)
      .at(-1)?.data;
    expect(step5).toMatchObject({ step: 5, status: "fail" });
    expect(h.engine.status({}).features[0]?.status).not.toBe("ready_to_ship");
    await h.release();
  });

  it("a feature whose step 5 did not render gets no judge", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const final = await toFinalReview(
      h,
      summary({ status: "skipped", skipped_reason: VISUAL_SKIPPED_NO_BROWSER, report: null }),
    );
    expect(final.map((r) => r.role)).toEqual(["spec_verifier", "security"]);
    for (const r of final) await featurePass(h, r);
    await h.engine.settle();
    expect(spawns((await h.engine.next({}, CLAUDE)).actions)).toEqual([]);
    expect(h.engine.status({}).features[0]?.status).toBe("ready_to_ship");
    await h.release();
  });
});
