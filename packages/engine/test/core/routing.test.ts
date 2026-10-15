/**
 * D-cm (H-9; spine §5 reading 218): the start tier of every role run dispatched for a task follows
 * the task's difficulty, a test per rule.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_TABLE,
  RoutingTableSchema,
  type ModelTier,
  type RoutingConfig,
  type TierHint,
} from "@vtc/shared";
import { routeTier, ruleTier, startTier, type RouteInput } from "../../src/core/routing.js";

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

const input = (
  t: RouteInput["task"],
  over: Partial<Omit<RouteInput, "task">> & { routing?: RoutingConfig } = {},
): RouteInput => ({
  role: over.role ?? "engineer",
  ...(over.mode === undefined ? {} : { mode: over.mode }),
  ...(t === undefined ? {} : { task: t }),
  roleTier: over.roleTier ?? ("top" satisfies ModelTier),
  ...(over.routing === undefined ? {} : { config: { routing: over.routing } }),
  ...(over.table === undefined ? {} : { table: over.table }),
});

describe("startTier: the routing table (D-cm)", () => {
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

  it("routes QA judge and every reviewer slot by the same rule", () => {
    for (const [role, mode] of [
      ["qa", "judge"],
      ["spec_verifier", undefined],
      ["security", "verify"],
      ["visual_qa", undefined],
      ["lens_accessibility", undefined],
    ] as const)
      expect(
        startTier(input(task("M"), { role, ...(mode === undefined ? {} : { mode }) })),
      ).toEqual({ tier: "mid", reason: "rule", clamped: false });
  });

  it("applies a role's own table cells, cell by cell", () => {
    const table = RoutingTableSchema.parse({
      ...DEFAULT_ROUTING_TABLE,
      roles: { spec_verifier: { by_size: { M: "low" }, tagged_floor: "low" } },
    });
    expect(ruleTier(task("M"), "spec_verifier", table)).toBe("low");
    // the cells it does not name stay the shared ones
    expect(ruleTier(task("L"), "spec_verifier", table)).toBe("top");
    expect(ruleTier(task("S", { risk_tags: ["perf"] }), "spec_verifier", table)).toBe("low");
    expect(ruleTier(task("S", { risk_tags: ["auth"] }), "spec_verifier", table)).toBe("top");
    // another role keeps the shared rule
    expect(ruleTier(task("M"), "engineer", table)).toBe("mid");
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
    expect(startTier(input(task("S"), { role: "qa", mode: "judge" })).tier).toBe("low");
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

  it("clamps an escalation to max_tier", () => {
    expect(routeTier(input(task("M"), { routing: { max_tier: "mid" } }), "escalation")).toEqual({
      tier: "mid",
      reason: "escalation",
      clamped: true,
    });
  });

  it("drops a reviewer one tier from its routed tier, clamped to min_tier", () => {
    expect(routeTier(input(task("L"), { role: "spec_verifier" }), "budget_drop")).toEqual({
      tier: "mid",
      reason: "budget_drop",
      clamped: false,
    });
    expect(
      routeTier(
        input(task("M"), { role: "spec_verifier", routing: { min_tier: "mid" } }),
        "budget_drop",
      ),
    ).toEqual({ tier: "mid", reason: "budget_drop", clamped: true });
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
