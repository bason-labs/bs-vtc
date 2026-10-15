/**
 * The routing-table PR the upstream module makes itself (D-cn; spine §5 readings 219 and 233): a
 * value-only edit of `DEFAULT_ROUTING_TABLE` in `packages/shared/src/tier-routing.ts`, read at the
 * PR's base, moved by the routing fact's tiers, and written back in the file's own form, so the
 * PR changes that one file and needs no run (no QA author tests, no CHANGELOG entry, no gates).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ROUTING_TABLE, routedStartTier, type RoutingTable } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  applyRoutingMove,
  readRoutingTableSource,
  renderRoutingTableLiteral,
  routingMoveOfBody,
  routingMoveOfMetrics,
  routingSubject,
  writeRoutingTableSource,
  ROUTING_TABLE_FILE,
} from "../../src/upstream/index.js";

const REPO = join(import.meta.dirname, "../../../..");
const SOURCE = readFileSync(join(REPO, ROUTING_TABLE_FILE), "utf8");

const DCM: RoutingTable = {
  v: 1,
  by_size: { S: "low", M: "mid", L: "top" },
  tagged_floor: "mid",
  high_floor: "top",
  high_risk_tags: ["auth", "payments", "data", "security", "migration"],
};

const subject = (key: string) => {
  const s = routingSubject(key);
  if (s === null) throw new Error(key);
  return s;
};

describe("the routing table's source (pure)", () => {
  it("reads VTC's own tier-routing.ts as the table the engine routes with", () => {
    expect(readRoutingTableSource(SOURCE)).toEqual(DEFAULT_ROUTING_TABLE);
  });

  it("writes the table back in the file's own form: an unchanged table is the same file", () => {
    expect(writeRoutingTableSource(SOURCE, DEFAULT_ROUTING_TABLE)).toBe(SOURCE);
  });

  it("round-trips role overrides, quoted role ids and a long tag list", () => {
    const table: RoutingTable = {
      ...DCM,
      high_risk_tags: Array.from({ length: 14 }, (_, i) => `risk-tag-${String(i)}`),
      roles: {
        engineer: { high_floor: "top" },
        "spec-verifier": {
          by_size: { S: "mid", M: "top", L: "top" },
          tagged_floor: "top",
          high_floor: "top",
        },
      },
    };
    const text = writeRoutingTableSource(SOURCE, table);
    expect(readRoutingTableSource(text)).toEqual(table);
    expect(text).toContain('    "spec-verifier": {\n');
    expect(text).toContain('    engineer: { high_floor: "top" },\n');
    // every line stays within the repo's print width
    for (const line of renderRoutingTableLiteral(table).split("\n"))
      expect(line.length).toBeLessThanOrEqual(100);
  });

  it("fails closed on a file it cannot read as the table", () => {
    expect(() => readRoutingTableSource("export const X = 1;\n")).toThrow(/DEFAULT_ROUTING_TABLE/);
    const commented = SOURCE.replace(
      '  tagged_floor: "mid",',
      '  // a note\n  tagged_floor: "mid",',
    );
    expect(() => readRoutingTableSource(commented)).toThrow();
    const twice = `${SOURCE}\n${SOURCE}`;
    expect(() => readRoutingTableSource(twice)).toThrow(/once/);
    const bad = SOURCE.replace('tagged_floor: "mid"', 'tagged_floor: "huge"');
    expect(() => readRoutingTableSource(bad)).toThrow();
  });
});

describe("the move a routing fact or issue names (pure)", () => {
  it("reads the tiers and the scope from the fact's metrics", () => {
    expect(
      routingMoveOfMetrics({ "routing.from_tier": 1, "routing.to_tier": 2, "routing.shared": 0 }),
    ).toEqual({ from: "mid", to: "top", scope: "role" });
    expect(
      routingMoveOfMetrics({ "routing.from_tier": 1, "routing.to_tier": 0, "routing.shared": 1 }),
    ).toEqual({ from: "mid", to: "low", scope: "shared" });
    for (const bad of [
      { "routing.from_tier": 1, "routing.to_tier": 7, "routing.shared": 1 },
      { "routing.from_tier": 1, "routing.to_tier": 1, "routing.shared": 1 },
      { "routing.from_tier": 1, "routing.to_tier": 2 },
      { "routing.from_tier": 1, "routing.to_tier": 2, "routing.shared": 0.5 },
    ])
      expect(routingMoveOfMetrics(bad)).toBeNull();
  });

  it("reads the same move back from the issue's line, for its own role only", () => {
    const s = subject("routing.engineer.M.tagged");
    expect(
      routingMoveOfBody("x\nMove the start tier from `mid` to `top` in the shared cell.\ny", s),
    ).toEqual({ from: "mid", to: "top", scope: "shared" });
    expect(
      routingMoveOfBody(
        "Move the start tier from `mid` to `top` in `roles.engineer`'s cell only. No tier replay was planned.",
        s,
      ),
    ).toEqual({ from: "mid", to: "top", scope: "role" });
    expect(
      routingMoveOfBody("Move the start tier from `mid` to `top` in `roles.qa`'s cell only.", s),
    ).toBeNull();
    expect(
      routingMoveOfBody("Move the start tier from `mid` to `mid` in the shared cell.", s),
    ).toBeNull();
    expect(routingMoveOfBody(undefined, s)).toBeNull();
  });
});

describe("applying a move to the table (pure)", () => {
  it("sets the shared field of the cell: by_size for no tag, the floors for a tag or high risk", () => {
    expect(
      applyRoutingMove(DCM, subject("routing.engineer.S.none"), {
        from: "low",
        to: "mid",
        scope: "shared",
      }).by_size,
    ).toEqual({ S: "mid", M: "mid", L: "top" });
    const tagged = applyRoutingMove(DCM, subject("routing.qa.M.tagged"), {
      from: "mid",
      to: "top",
      scope: "shared",
    });
    expect(tagged.tagged_floor).toBe("top");
    expect(tagged.roles).toBeUndefined();
  });

  it("sets one role's override only, keeping its other cells", () => {
    const table: RoutingTable = { ...DCM, roles: { engineer: { by_size: { L: "top" } } } };
    const next = applyRoutingMove(table, subject("routing.engineer.S.none"), {
      from: "low",
      to: "mid",
      scope: "role",
    });
    expect(next.roles).toEqual({ engineer: { by_size: { S: "mid", L: "top" } } });
    expect(next.by_size).toEqual(DCM.by_size);
    expect(routedStartTier(next, "engineer", "S", "none")).toBe("mid");
    expect(routedStartTier(next, "qa", "S", "none")).toBe("low");
    const added = applyRoutingMove(DCM, subject("routing.spec-verifier.M.tagged"), {
      from: "mid",
      to: "top",
      scope: "role",
    });
    expect(added.roles).toEqual({ "spec-verifier": { tagged_floor: "top" } });
  });

  it("refuses a move from a tier the table no longer starts the cell on (stale)", () => {
    expect(() =>
      applyRoutingMove(DCM, subject("routing.engineer.S.none"), {
        from: "mid",
        to: "top",
        scope: "shared",
      }),
    ).toThrow(expect.objectContaining({ reason: "stale_baseline" }));
  });

  it("refuses a move one value cannot make (a floor under a higher by_size)", () => {
    // L tagged starts on by_size.L (top); lowering tagged_floor cannot start it on mid
    expect(() =>
      applyRoutingMove(DCM, subject("routing.engineer.L.tagged"), {
        from: "top",
        to: "mid",
        scope: "shared",
      }),
    ).toThrow(expect.objectContaining({ reason: "out_of_scope" }));
  });
});
