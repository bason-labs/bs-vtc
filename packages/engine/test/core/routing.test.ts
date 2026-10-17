/**
 * D-cm (H-9; spine §5 reading 218) and D-cu (reading 241): the start tier of a producer run (the
 * Engineer family, QA author) follows the task's difficulty; a reviewer starts on its own tier,
 * raised one tier on a high-risk task for Security verify and the cross-family reviewer. A test per
 * rule.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_TABLE,
  routedStartTier,
  RoutingTableSchema,
  taskRiskClass,
  type ModelTier,
  type RoutingConfig,
  type RoutingTable,
  type TierHint,
} from "@vtc/shared";
import { routeTier, ruleTier, startTier, type RouteInput } from "../../src/core/routing.js";
import { routedStartTier as lookbackStartTier } from "../../src/lookback/index.js";

const task = (
  size: "S" | "M" | "L",
  over: {
    risk?: "low" | "med" | "high";
    risk_tags?: string[];
    tier_hint?: TierHint;
  } = {},
): NonNullable<RouteInput["task"]> => ({
  size,
  risk: over.risk ?? "low",
  risk_tags: over.risk_tags ?? [],
  ...(over.tier_hint === undefined ? {} : { tier_hint: over.tier_hint }),
});

/**
 * D-cm's table as decided (reading 218(2)): the rule tests route with it, since
 * `DEFAULT_ROUTING_TABLE`'s tiers move through reviewed D-cn routing PRs that change
 * `tier-routing.ts` only (reading 233).
 */
const DCM: RoutingTable = {
  v: 1,
  by_size: { S: "low", M: "mid", L: "top" },
  tagged_floor: "mid",
  high_floor: "top",
  high_risk_tags: ["auth", "payments", "data", "security", "migration"],
};

const input = (
  t: RouteInput["task"],
  over: Partial<Omit<RouteInput, "task">> & { routing?: RoutingConfig } = {},
): RouteInput => ({
  role: over.role ?? "engineer",
  ...(over.mode === undefined ? {} : { mode: over.mode }),
  ...(t === undefined ? {} : { task: t }),
  roleTier: over.roleTier ?? ("top" satisfies ModelTier),
  ...(over.crossFamily === undefined ? {} : { crossFamily: over.crossFamily }),
  ...(over.routing === undefined ? {} : { config: { routing: over.routing } }),
  table: over.table ?? DCM,
});

describe("startTier: the routing table (D-cm)", () => {
  it("routes with DEFAULT_ROUTING_TABLE when no table is given", () => {
    for (const size of ["S", "M", "L"] as const)
      for (const t of [
        task(size),
        task(size, { risk_tags: ["perf"] }),
        task(size, { risk: "high" }),
      ])
        expect(startTier({ role: "engineer", task: t, roleTier: "top" }).tier).toBe(
          routedStartTier(DEFAULT_ROUTING_TABLE, "engineer", size, taskRiskClass(t)),
        );
  });

  it("starts an S task with no risk tag on Low", () => {
    expect(startTier(input(task("S")))).toEqual({ tier: "low", reason: "rule", clamped: false });
  });

  it("starts a tagged S task on Mid", () => {
    expect(startTier(input(task("S", { risk_tags: ["perf"] })))).toEqual({
      tier: "mid",
      reason: "rule",
      clamped: false,
    });
  });

  it("starts an M task on Mid and an L task on Top", () => {
    expect(startTier(input(task("M"))).tier).toBe("mid");
    expect(startTier(input(task("L"))).tier).toBe("top");
  });

  it("starts any task with a high-risk tag on Top", () => {
    for (const tag of DEFAULT_ROUTING_TABLE.high_risk_tags)
      expect(startTier(input(task("S", { risk_tags: [tag] }))).tier).toBe("top");
  });

  it("starts a risk-high task on Top even without a tag; risk med alone is no tag", () => {
    expect(startTier(input(task("S", { risk: "high" }))).tier).toBe("top");
    expect(startTier(input(task("S", { risk: "med" }))).tier).toBe("low");
  });

  it("routes every Engineer profile and QA author by the table (D-cu)", () => {
    for (const [role, mode] of [
      ["engineer", undefined],
      ["engineer_frontend", undefined],
      ["qa", "author"],
    ] as const)
      expect(
        startTier(
          input(task("L"), { role, roleTier: "low", ...(mode === undefined ? {} : { mode }) }),
        ),
      ).toEqual({ tier: "top", reason: "rule", clamped: false });
  });

  it("applies a role's own table cells, cell by cell", () => {
    const table = RoutingTableSchema.parse({
      ...DCM,
      roles: { engineer: { by_size: { M: "low" }, tagged_floor: "low" } },
    });
    expect(ruleTier(task("M"), "engineer", table)).toBe("low");
    // the cells it does not name stay the shared ones
    expect(ruleTier(task("L"), "engineer", table)).toBe("top");
    expect(ruleTier(task("S", { risk_tags: ["perf"] }), "engineer", table)).toBe("low");
    expect(ruleTier(task("S", { risk_tags: ["auth"] }), "engineer", table)).toBe("top");
    // another role keeps the shared rule
    expect(ruleTier(task("M"), "qa", table)).toBe("mid");
    expect(startTier(input(task("M"), { table })).tier).toBe("low");
  });
});

describe("startTier: reviewers start on their own tier (D-cu, reading 241)", () => {
  const REVIEWERS = [
    ["qa", "judge"],
    ["spec_verifier", undefined],
    ["security", "verify"],
    ["visual_qa", undefined],
    ["lens_accessibility", undefined],
  ] as const;
  const who = (role: string, mode: string | undefined) => ({
    role,
    ...(mode === undefined ? {} : { mode }),
  });

  it("starts every reviewer on its role.yaml tier whatever the task's size or tags, reason role", () => {
    for (const [role, mode] of REVIEWERS)
      for (const roleTier of ["low", "mid", "top"] as const)
        for (const t of [task("S"), task("L"), task("S", { risk_tags: ["perf"] })])
          expect(startTier(input(t, { ...who(role, mode), roleTier }))).toEqual({
            tier: roleTier,
            reason: "role",
            clamped: false,
          });
  });

  it("ignores the Planner's hint and a table override for a reviewer", () => {
    const table = RoutingTableSchema.parse({
      ...DCM,
      roles: { spec_verifier: { by_size: { M: "top" } } },
    });
    expect(
      startTier(
        input(task("M", { tier_hint: { tier: "top", reason: "concurrency" } }), {
          role: "spec_verifier",
          roleTier: "low",
          table,
        }),
      ),
    ).toEqual({ tier: "low", reason: "role", clamped: false });
  });

  it("raises Security verify one tier on a high-risk task, reason rule, at most Top", () => {
    const security = who("security", "verify");
    for (const t of [task("S", { risk: "high" }), task("M", { risk_tags: ["auth"] })]) {
      expect(startTier(input(t, { ...security, roleTier: "low" }))).toEqual({
        tier: "mid",
        reason: "rule",
        clamped: false,
      });
      expect(startTier(input(t, { ...security, roleTier: "mid" })).tier).toBe("top");
      expect(startTier(input(t, { ...security, roleTier: "top" }))).toEqual({
        tier: "top",
        reason: "rule",
        clamped: false,
      });
    }
    // a merely tagged task, or Security in design mode, keeps the role tier
    expect(
      startTier(input(task("S", { risk_tags: ["perf"] }), { ...security, roleTier: "mid" })),
    ).toEqual({ tier: "mid", reason: "role", clamped: false });
  });

  it("raises the cross-family reviewer on a high-risk task, never the same-host QA judge or the Spec Verifier", () => {
    const high = task("M", { risk: "high" });
    const judge = who("qa", "judge");
    expect(startTier(input(high, { ...judge, roleTier: "mid", crossFamily: true }))).toEqual({
      tier: "top",
      reason: "rule",
      clamped: false,
    });
    expect(startTier(input(high, { ...judge, roleTier: "mid" }))).toEqual({
      tier: "mid",
      reason: "role",
      clamped: false,
    });
    for (const crossFamily of [false, true])
      expect(
        startTier(input(high, { role: "spec_verifier", roleTier: "low", crossFamily })),
      ).toEqual({ tier: "low", reason: "role", clamped: false });
  });

  it("clamps a reviewer's start to routing.min_tier / max_tier", () => {
    expect(
      startTier(
        input(task("S", { risk: "high" }), {
          ...who("security", "verify"),
          roleTier: "mid",
          routing: { max_tier: "mid" },
        }),
      ),
    ).toEqual({ tier: "mid", reason: "rule", clamped: true });
    expect(
      startTier(
        input(task("S"), { role: "spec_verifier", roleTier: "low", routing: { min_tier: "mid" } }),
      ),
    ).toEqual({ tier: "mid", reason: "role", clamped: true });
  });
});

describe("startTier: the Planner's hint (D-cm)", () => {
  it("replaces the rule's tier, logged as planner_hint", () => {
    const hint: TierHint = { tier: "top", reason: "concurrency" };
    expect(startTier(input(task("S", { tier_hint: hint })))).toEqual({
      tier: "top",
      reason: "planner_hint",
      clamped: false,
    });
    expect(
      startTier(input(task("L", { tier_hint: { tier: "low", reason: "mechanical" } }))).tier,
    ).toBe("low");
  });

  it("never lowers a high-risk task below its high floor (reading 218(2))", () => {
    const low: TierHint = { tier: "low", reason: "mechanical" };
    for (const [role, mode] of [
      ["engineer", undefined],
      ["qa", "author"],
    ] as const) {
      const who = { role, ...(mode === undefined ? {} : { mode }) };
      expect(startTier(input(task("S", { risk_tags: ["auth"], tier_hint: low }), who))).toEqual({
        tier: "top",
        reason: "planner_hint",
        clamped: true,
      });
      expect(startTier(input(task("S", { risk: "high", tier_hint: low }), who)).tier).toBe("top");
    }
    // a role's own high floor bounds its hint instead
    const table = RoutingTableSchema.parse({
      ...DCM,
      roles: { engineer: { high_floor: "mid" } },
    });
    expect(
      startTier(
        input(task("S", { risk_tags: ["payments"], tier_hint: low }), {
          role: "engineer",
          table,
        }),
      ),
    ).toEqual({ tier: "mid", reason: "planner_hint", clamped: true });
    // a hint on a merely tagged task still lowers it
    expect(startTier(input(task("S", { risk_tags: ["perf"], tier_hint: low })))).toEqual({
      tier: "low",
      reason: "planner_hint",
      clamped: false,
    });
    // a hint at or above the floor is not moved; max_tier still bounds the floored hint
    expect(
      startTier(
        input(
          task("S", { risk_tags: ["auth"], tier_hint: { tier: "top", reason: "concurrency" } }),
        ),
      ),
    ).toEqual({ tier: "top", reason: "planner_hint", clamped: false });
    expect(
      startTier(
        input(task("S", { risk_tags: ["auth"], tier_hint: low }), { routing: { max_tier: "mid" } }),
      ),
    ).toEqual({ tier: "mid", reason: "planner_hint", clamped: true });
  });
});

describe("startTier: the project's min/max and QA author's floor (D-cm)", () => {
  it("clamps the rule into routing.min_tier / max_tier and says so", () => {
    expect(startTier(input(task("L"), { routing: { max_tier: "mid" } }))).toEqual({
      tier: "mid",
      reason: "rule",
      clamped: true,
    });
    expect(startTier(input(task("S"), { routing: { min_tier: "mid" } }))).toEqual({
      tier: "mid",
      reason: "rule",
      clamped: true,
    });
  });

  it("clamps a hint too", () => {
    expect(
      startTier(
        input(task("S", { tier_hint: { tier: "top", reason: "novel_logic" } }), {
          routing: { max_tier: "mid" },
        }),
      ),
    ).toEqual({ tier: "mid", reason: "planner_hint", clamped: true });
  });

  it("never starts QA author on Low, even with max_tier low", () => {
    const qa = { role: "qa", mode: "author" } as const;
    expect(startTier(input(task("S"), qa))).toEqual({ tier: "mid", reason: "rule", clamped: true });
    expect(startTier(input(task("S"), { ...qa, routing: { max_tier: "low" } }))).toEqual({
      tier: "mid",
      reason: "rule",
      clamped: true,
    });
    expect(
      startTier(input(task("M", { tier_hint: { tier: "low", reason: "boilerplate" } }), qa)).tier,
    ).toBe("mid");
    // QA judge has no such floor
    expect(startTier(input(task("S"), { role: "qa", mode: "judge", roleTier: "low" })).tier).toBe(
      "low",
    );
  });
});

describe("startTier: roles the rule does not route (D-cm)", () => {
  it("keeps a non-task role on its role.yaml tier, reason role, still clamped", () => {
    expect(startTier(input(undefined, { role: "planner", roleTier: "top" }))).toEqual({
      tier: "top",
      reason: "role",
      clamped: false,
    });
    expect(
      startTier(
        input(undefined, { role: "planner", roleTier: "top", routing: { max_tier: "mid" } }),
      ),
    ).toEqual({ tier: "mid", reason: "role", clamped: true });
  });

  it("uses each role's own tier under routing.start: role", () => {
    expect(
      startTier(
        input(task("S", { tier_hint: { tier: "top", reason: "concurrency" } }), {
          roleTier: "mid",
          routing: { start: "role" },
        }),
      ),
    ).toEqual({ tier: "mid", reason: "role", clamped: false });
    expect(
      startTier(
        input(task("L"), {
          role: "qa",
          mode: "author",
          roleTier: "low",
          routing: { start: "role" },
        }),
      ),
    ).toEqual({ tier: "mid", reason: "role", clamped: true });
  });
});

describe("routeTier: escalation and the reviewers' budget drop (D-cm)", () => {
  it("escalates one tier up from the routed start: Low → Mid", () => {
    expect(routeTier(input(task("S")), "escalation")).toEqual({
      tier: "mid",
      reason: "escalation",
      clamped: false,
    });
    expect(routeTier(input(task("M")), "escalation").tier).toBe("top");
    expect(routeTier(input(task("L")), "escalation").tier).toBe("top");
  });

  it("escalates a second time from the start: Low → Mid → Top (reading 218(4))", () => {
    expect(routeTier(input(task("S")), "escalation", 2)).toEqual({
      tier: "top",
      reason: "escalation",
      clamped: false,
    });
    expect(routeTier(input(task("M")), "escalation", 2).tier).toBe("top");
    expect(routeTier(input(task("S"), { routing: { max_tier: "mid" } }), "escalation", 2)).toEqual({
      tier: "mid",
      reason: "escalation",
      clamped: true,
    });
  });

  it("clamps an escalation to max_tier", () => {
    expect(routeTier(input(task("M"), { routing: { max_tier: "mid" } }), "escalation")).toEqual({
      tier: "mid",
      reason: "escalation",
      clamped: true,
    });
  });

  it("drops a reviewer one tier from its own start tier, clamped to min_tier", () => {
    expect(
      routeTier(input(task("S"), { role: "spec_verifier", roleTier: "top" }), "budget_drop"),
    ).toEqual({ tier: "mid", reason: "budget_drop", clamped: false });
    expect(
      routeTier(
        input(task("M"), { role: "spec_verifier", roleTier: "mid", routing: { min_tier: "mid" } }),
        "budget_drop",
      ),
    ).toEqual({ tier: "mid", reason: "budget_drop", clamped: true });
    // the high-risk raise is the start Security verify drops from
    expect(
      routeTier(
        input(task("S", { risk: "high" }), { role: "security", mode: "verify", roleTier: "mid" }),
        "budget_drop",
      ),
    ).toEqual({ tier: "mid", reason: "budget_drop", clamped: false });
  });

  it("escalates a reviewer from its own start tier", () => {
    expect(
      routeTier(input(task("L"), { role: "spec_verifier", roleTier: "low" }), "escalation"),
    ).toEqual({ tier: "mid", reason: "escalation", clamped: false });
  });

  it("keeps QA author's floor on any change", () => {
    expect(routeTier(input(task("M"), { role: "qa", mode: "author" }), "budget_drop").tier).toBe(
      "mid",
    );
  });

  it("without a change is the start", () => {
    expect(routeTier(input(task("M")))).toEqual(startTier(input(task("M"))));
  });
});

describe("one start-tier rule (contracts 5.5.0, merge conformance)", () => {
  it("the router's table tier is the shared routedStartTier, which Lookback measures against, for every role, size and risk class", () => {
    const tables = [
      DEFAULT_ROUTING_TABLE,
      RoutingTableSchema.parse({
        ...DEFAULT_ROUTING_TABLE,
        by_size: { S: "low", M: "low", L: "mid" },
        tagged_floor: "low",
        high_floor: "mid",
        roles: {
          spec_verifier: { by_size: { M: "top" }, tagged_floor: "top" },
          qa: { high_floor: "low" },
        },
      }),
    ];
    const tasks = [
      { risk: "low" as const, risk_tags: [] },
      { risk: "med" as const, risk_tags: ["ui"] },
      { risk: "low" as const, risk_tags: ["auth"] },
      { risk: "high" as const, risk_tags: [] },
    ];
    let cases = 0;
    for (const table of tables)
      for (const role of ["engineer", "spec_verifier", "qa", "security"])
        for (const size of ["S", "M", "L"] as const)
          for (const t of tasks) {
            const routed = { size, ...t };
            const risk = taskRiskClass(routed, table);
            expect(ruleTier(routed, role, table)).toBe(routedStartTier(table, role, size, risk));
            expect(lookbackStartTier(table, role, size, risk)).toBe(ruleTier(routed, role, table));
            cases += 1;
          }
    expect(cases).toBe(96);
  });
});
