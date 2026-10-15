/**
 * Contracts 5.5.0 (MINOR; spine §5 readings 228–231): the round-5 merge. One shared start-tier
 * rule, the routing fact's metric names, command shapes that keep no argument as a subcommand,
 * the headless role run marker, a PR's partial-evidence reason on the Automation view, and two
 * optional git plumbing reads.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AutomationItemSchema,
  COMMAND_SHAPE_PATH,
  COMMAND_SHAPE_SUBCOMMAND_PROGRAMS,
  commandShapes,
  CONTRACTS_VERSION,
  DEFAULT_ROUTING_TABLE,
  HEADLESS_ROLE_ENV,
  ROUTING_FACT_METRICS,
  routedStartTier,
  RoutingTableSchema,
  TaskRiskClassSchema,
  type GitPlumbing,
  type GitSha,
} from "../src/index.js";

const SIZES = ["S", "M", "L"] as const;

describe("contracts 5.5.0", () => {
  it("is MINOR over 5.4.0", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });

  describe("routedStartTier (D-cm, readings 218(2) and 228)", () => {
    it("gives the default table's cells: S Low, M Mid, L Top; a tag lifts to Mid, high risk to Top", () => {
      const grid = Object.fromEntries(
        SIZES.map((size) => [
          size,
          TaskRiskClassSchema.options.map((risk) =>
            routedStartTier(DEFAULT_ROUTING_TABLE, "engineer", size, risk),
          ),
        ]),
      );
      expect(grid).toEqual({
        S: ["low", "mid", "top"],
        M: ["mid", "mid", "top"],
        L: ["top", "top", "top"],
      });
    });

    it("takes one role's override field by field, and the floors stay floors", () => {
      const table = RoutingTableSchema.parse({
        ...DEFAULT_ROUTING_TABLE,
        by_size: { S: "low", M: "low", L: "mid" },
        tagged_floor: "low",
        high_floor: "mid",
        roles: { spec_verifier: { by_size: { M: "mid" }, high_floor: "top" } },
      });
      expect(routedStartTier(table, "spec_verifier", "M", "none")).toBe("mid");
      expect(routedStartTier(table, "spec_verifier", "S", "none")).toBe("low");
      expect(routedStartTier(table, "spec_verifier", "S", "high")).toBe("top");
      // a floor below by_size never lowers the start
      expect(routedStartTier(table, "engineer", "L", "tagged")).toBe("mid");
      expect(routedStartTier(table, "engineer", "S", "high")).toBe("mid");
      expect(routedStartTier(table, undefined, "M", "none")).toBe("low");
    });
  });

  it("names the routing fact's fixed metrics as Lookback sends them", () => {
    expect(ROUTING_FACT_METRICS).toEqual({
      fromTier: "routing.from_tier",
      toTier: "routing.to_tier",
      currentTier: "routing.current_tier",
      shared: "routing.shared",
      replayPlanned: "routing.replay_planned",
      lifted: "routing.lifted",
      liftedPrefix: "routing.lifted.",
    });
  });

  describe("command shapes keep no argument as a subcommand (amends reading 221(1))", () => {
    it("records a subcommand only after a program that has subcommands", () => {
      const shape = (line: string) =>
        commandShapes(line).map((s) => [s.program, s.subcommand ?? null]);
      expect(shape("git status && pnpm install && docker build .")).toEqual([
        ["git", "status"],
        ["pnpm", "install"],
        ["docker", "build"],
      ]);
      expect(shape("echo hunter2; cat secrets; make deploy-acme; psql acme_prod")).toEqual([
        ["echo", null],
        ["cat", null],
        ["make", null],
        ["psql", null],
      ]);
      expect(shape("./scripts/deploy.sh prod")).toEqual([[COMMAND_SHAPE_PATH, null]]);
    });

    it("lists only plain program names", () => {
      for (const program of COMMAND_SHAPE_SUBCOMMAND_PROGRAMS)
        expect(program).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(COMMAND_SHAPE_SUBCOMMAND_PROGRAMS).toContain("git");
      expect(COMMAND_SHAPE_SUBCOMMAND_PROGRAMS).not.toContain("make");
    });
  });

  it("names the headless role run marker", () => {
    expect(HEADLESS_ROLE_ENV).toBe("VTC_HEADLESS_ROLE");
  });

  it("lets an Automation view PR carry why its evidence is partial, and stays valid without it", () => {
    const item = {
      target: { kind: "project", repo: "o/r" },
      kind: "parked",
      fingerprint: "a".repeat(16),
      issue: null,
      pr: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        state: "draft",
        evidence: "partial",
      },
      first_at: "2026-10-15T08:00:00.000Z",
      last_at: "2026-10-15T08:00:00.000Z",
    };
    expect(AutomationItemSchema.safeParse(item).success).toBe(true);
    const withReason = { ...item, pr: { ...item.pr, partial_reason: "base_build_failed" } };
    expect(AutomationItemSchema.parse(withReason).pr?.partial_reason).toBe("base_build_failed");
    expect(
      AutomationItemSchema.safeParse({ ...item, pr: { ...item.pr, partial_reason: "nope" } })
        .success,
    ).toBe(false);
  });

  it("adds the optional git plumbing reads", () => {
    expectTypeOf<GitPlumbing["changedPaths"]>().toEqualTypeOf<
      ((base: GitSha, head: GitSha) => Promise<readonly string[]>) | undefined
    >();
    expectTypeOf<GitPlumbing["mergeBase"]>().toEqualTypeOf<
      ((a: GitSha, b: GitSha) => Promise<GitSha | null>) | undefined
    >();
  });
});
