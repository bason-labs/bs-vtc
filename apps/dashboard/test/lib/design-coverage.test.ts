import { describe, expect, it } from "vitest";
import { DESIGN_COVERAGE_ESCALATION_OPTIONS, DESIGN_COVERAGE_LOOP } from "@vtc/shared";
import {
  COVERAGE_ESCALATION_OPTIONS,
  coverageLoop,
  type CoverageLoopView,
} from "@/lib/design-coverage";
import { gateRequests, pendingGate } from "@/lib/human-gates";
import { topicsForEvent } from "@/lib/api/topics";
import { firstSample, sampleEvent, variant } from "../golden-samples";

/**
 * The G2 coverage loop (H-13; spine §5 reading 237): each DESIGN check before G2 is logged as
 * `design.coverage_checked`, and Flow Studio shows the loop's status from them.
 */
const MAX = DESIGN_COVERAGE_LOOP.maxRounds;

const gappy = {
  reqs_without_component: ["REQ-5"],
  reqs_without_screen: ["REQ-4"],
  screens_without_req: ["orphan"],
  components_unregistered: ["date-picker"],
  ok: false,
};
const complete = {
  reqs_without_component: [],
  reqs_without_screen: [],
  screens_without_req: [],
  components_unregistered: [],
  ok: true,
};

const check = (seq: number, data: Record<string, unknown>) =>
  sampleEvent(seq, "design.coverage_checked", { max_rounds: MAX, ...data });

const fixing = (seq: number, n: number, report: object = gappy) =>
  check(seq, {
    check: n,
    report,
    outcome: "fixing",
    redispatched: ["architect", "designer"],
  });

const submitted = (seq: number, role: "architect" | "designer") =>
  sampleEvent(
    seq,
    "role.submitted",
    { action_id: `a-${String(seq)}`, exit: "done", findings: 0, questions: 0, session_ref: null },
    {
      actor: "role",
      role,
      prompt_sha: "4".repeat(64),
      host: "claude-code",
      model: "claude-sonnet-5",
      tokens: { in: 1, out: 1, cache_r: 0, cache_w: 0 },
      cost_usd: 0.1,
    },
  );

const loop = (events: Parameters<typeof coverageLoop>[0]): CoverageLoopView => {
  const view = coverageLoop(events);
  if (view === null) throw new Error("no coverage loop");
  return view;
};

describe("coverageLoop (design.coverage_checked, H-13)", () => {
  it("is null before any coverage check", () => {
    expect(coverageLoop([firstSample("run.started")])).toBeNull();
  });

  it("shows a fixing check: the round, the roles re-dispatched and every gap list", () => {
    const view = loop([fixing(40, 1)]);
    expect(view.state).toMatchObject({ id: "fixing", tone: "warn", live: true });
    expect(view.check).toBe(1);
    expect(view.maxRounds).toBe(MAX);
    expect(view.fixRounds).toBe(`1 of ${String(MAX)}`);
    expect(view.headline).toBe(`Check 1 found gaps: fix round 1 of ${String(MAX)} is running`);
    expect(view.redispatched).toEqual(["Architect", "Designer"]);
    expect(view.gaps.map((g) => [g.id, g.items])).toEqual([
      ["reqs_without_component", ["REQ-5"]],
      ["reqs_without_screen", ["REQ-4"]],
      ["screens_without_req", ["orphan"]],
      ["components_unregistered", ["date-picker"]],
    ]);
    expect(view.uncovered).toEqual(["REQ-4", "REQ-5"]);
    expect(view.park).toBeNull();
  });

  it("is checking again once every re-dispatched role has submitted its fix", () => {
    const architectOnly = loop([fixing(40, 1), submitted(41, "architect")]);
    expect(architectOnly.state.id).toBe("fixing");
    const view = loop([fixing(40, 1), submitted(41, "architect"), submitted(42, "designer")]);
    expect(view.state).toMatchObject({ id: "checking", live: true });
    expect(view.headline).toBe(`Fix round 1 of ${String(MAX)} is in: check 2 is running`);
    // A submit before the check does not count.
    expect(
      loop([submitted(39, "architect"), submitted(38, "designer"), fixing(40, 1)]).state.id,
    ).toBe("fixing");
  });

  it("shows a complete check, with the loop's checks oldest first", () => {
    const view = loop([
      fixing(40, 1),
      check(43, { check: 2, report: complete, outcome: "complete" }),
    ]);
    expect(view.state).toMatchObject({ id: "complete", tone: "ok" });
    expect(view.state.live).toBeUndefined();
    expect(view.headline).toBe("Check 2: every requirement is covered, so G2 follows");
    expect(view.gaps).toEqual([]);
    expect(view.redispatched).toEqual([]);
    expect(view.checks.map((c) => [c.check, c.outcome.label, c.gaps])).toEqual([
      [1, "Fixing gaps", 4],
      [2, "Complete", 0],
    ]);
  });

  it("names the park reason, the uncovered REQs and the escalation when the loop parks", () => {
    const cap = loop([
      check(44, {
        check: MAX + 1,
        report: { ...complete, reqs_without_component: ["REQ-9"], ok: false },
        outcome: "parked",
        park_reason: "cap",
        escalation: "E-4",
      }),
    ]);
    expect(cap.state).toMatchObject({ id: "parked", tone: "danger" });
    expect(cap.fixRounds).toBe(`${String(MAX)} of ${String(MAX)}`);
    expect(cap.park).toEqual({
      reason: `the cap of ${String(MAX)} fix rounds was reached`,
      escalation: "E-4",
      answered: false,
    });
    expect(cap.uncovered).toEqual(["REQ-9"]);
    expect(cap.headline).toBe(
      `Check ${String(MAX + 1)}: parked, the cap of ${String(MAX)} fix rounds was reached`,
    );
    const stuck = loop([
      fixing(40, 1),
      check(45, { check: 2, report: gappy, outcome: "parked", park_reason: "stuck" }),
    ]);
    expect(stuck.park).toEqual({
      reason: "stuck: the same gaps remained after a fix round",
      escalation: null,
      answered: false,
    });
    expect(stuck.fixRounds).toBe(`1 of ${String(MAX)}`);
  });

  it("knows when the human answered the loop's escalation", () => {
    const parked = check(44, {
      check: 2,
      report: gappy,
      outcome: "parked",
      park_reason: "stuck",
      escalation: "E-4",
    });
    const answered = sampleEvent(45, "escalation.answered", {
      escalation: "E-4",
      answer: {
        option: "change_spec",
        text: "REQ-5 moves to a later release",
        who_should_have_caught: "architect",
      },
    });
    expect(loop([parked]).park?.answered).toBe(false);
    expect(loop([parked, answered]).park?.answered).toBe(true);
  });

  it("names the escalation's options from the contract", () => {
    expect(Object.keys(COVERAGE_ESCALATION_OPTIONS).sort()).toEqual(
      [...DESIGN_COVERAGE_ESCALATION_OPTIONS].sort(),
    );
  });

  it("shows only the newest loop: a new loop starts at check 1", () => {
    const view = loop([
      fixing(40, 1),
      check(41, {
        check: 2,
        report: gappy,
        outcome: "parked",
        park_reason: "stuck",
        escalation: "E-2",
      }),
      fixing(50, 1, {
        ...gappy,
        reqs_without_screen: [],
        screens_without_req: [],
        components_unregistered: [],
      }),
    ]);
    expect(view.state.id).toBe("fixing");
    expect(view.checks.map((c) => c.seq)).toEqual([50]);
    expect(view.gaps.map((g) => g.id)).toEqual(["reqs_without_component"]);
  });

  it("shows a screens.yaml problem as a gap", () => {
    const view = loop([
      check(40, {
        check: 1,
        report: { ...complete, screens_problem: "screens.yaml is missing", ok: false },
        outcome: "fixing",
        redispatched: ["designer"],
      }),
    ]);
    expect(view.screensProblem).toBe("screens.yaml is missing");
    expect(view.redispatched).toEqual(["Designer"]);
  });

  it("stops pulsing once the run finished", () => {
    const view = loop([fixing(40, 1), sampleEvent(60, "run.finished", { outcome: "aborted" })]);
    expect(view.state.id).toBe("fixing");
    expect(view.state.live).toBeUndefined();
  });

  it("marks the gates view stale on a coverage check", () => {
    expect(topicsForEvent(fixing(40, 1))).toContain("gates");
  });

  it("marks the gates view stale when the human answers an escalation", () => {
    const answered = sampleEvent(44, "escalation.answered", {
      escalation: "E-4",
      answer: {
        option: "instruct_architect",
        text: "Map REQ-5 to AD-3",
        who_should_have_caught: "architect",
      },
    });
    expect(topicsForEvent(answered)).toEqual(expect.arrayContaining(["escalations", "gates"]));
  });
});

describe("G2 appears only after a complete coverage check (H-13)", () => {
  const g2 = variant(firstSample("gate.requested"), 50);

  it("keeps a G2 asked after a complete check waiting", () => {
    const events = [
      fixing(40, 1),
      check(43, { check: 2, report: complete, outcome: "complete" }),
      g2,
    ];
    expect(pendingGate(events)?.seq).toBe(50);
  });

  it("no longer offers a G2 once the coverage loop runs again after it", () => {
    const events = [g2, fixing(55, 1)];
    expect(pendingGate(events)).toBeNull();
    expect(gateRequests(events)[0]?.outcome.id).toBe("superseded");
  });
});
