/**
 * The routing-table PR the upstream module makes itself (D-cn; spine §5 readings 219 and 233): a
 * value-only edit of `DEFAULT_ROUTING_TABLE` in `packages/shared/src/tier-routing.ts`, read at the
 * PR's base, moved by the routing fact's tiers, and written back in the file's own form, so the
 * PR changes that one file and needs no run (no QA author tests, no CHANGELOG entry, no gates).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ROUTING_TABLE,
  ROUTING_REPLAY_VERDICT_CODES,
  routedStartTier,
  type RoutingTable,
} from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  applyRoutingMove,
  buildRoutingPr,
  readRoutingTableSource,
  renderRoutingTableLiteral,
  routingMoveOfBody,
  routingMoveOfMetrics,
  routingReplayLine,
  routingReplayOfBody,
  routingReplayOfMetrics,
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

describe("the graded tier replay a routing fact carries (pure; reading 247(6))", () => {
  const graded = (verdict: keyof typeof ROUTING_REPLAY_VERDICT_CODES, trials: number) => ({
    "routing.replay_verdict": ROUTING_REPLAY_VERDICT_CODES[verdict],
    "routing.replay_trials": trials,
  });

  it("decodes the verdict and the trial count, and nothing short of both", () => {
    expect(routingReplayOfMetrics(graded("improve", 24))).toEqual({
      verdict: "improve",
      trials: 24,
    });
    expect(routingReplayOfMetrics(graded("no_change", 6))).toEqual({
      verdict: "no_change",
      trials: 6,
    });
    for (const bad of [
      undefined,
      {},
      { "routing.replay_verdict": 1 },
      { "routing.replay_trials": 24 },
      { "routing.replay_verdict": 7, "routing.replay_trials": 24 },
      { "routing.replay_verdict": 0.5, "routing.replay_trials": 24 },
      { "routing.replay_verdict": 1, "routing.replay_trials": 0 },
      { "routing.replay_verdict": 1, "routing.replay_trials": 2.5 },
    ])
      expect(routingReplayOfMetrics(bad), JSON.stringify(bad)).toBeNull();
  });

  it("writes the issue's replay line and reads the same replay back from it", () => {
    const cheaper = { from: "mid", to: "low", scope: "shared" } as const;
    const higher = { from: "mid", to: "top", scope: "role" } as const;
    const line = routingReplayLine({ verdict: "no_change", trials: 12 }, cheaper);
    expect(line).toBe("A graded tier replay backs the move: verdict `no_change` over 12 trials.");
    expect(routingReplayOfBody(`x\n${line}\ny`)).toEqual({ verdict: "no_change", trials: 12 });
    // a higher tier needs `improve`: `no_change` does not back it, and the line says so
    expect(routingReplayLine({ verdict: "no_change", trials: 12 }, higher)).toBe(
      "A graded tier replay does not back the move: verdict `no_change` over 12 trials.",
    );
    expect(routingReplayOfBody("No tier replay was planned.")).toBeNull();
    expect(routingReplayOfBody(undefined)).toBeNull();
    expect(
      routingReplayOfBody("A graded tier replay backs the move: verdict `great` over 12 trials."),
    ).toBeNull();
  });

  const SUBJECT = subject("routing.engineer.M.tagged");
  const MOVE = { from: "mid", to: "top", scope: "role" } as const;
  const verification = (replay?: Parameters<typeof buildRoutingPr>[0]["replay"]) =>
    buildRoutingPr({
      subject: SUBJECT,
      move: MOVE,
      source: writeRoutingTableSource(SOURCE, DCM),
      vtcVersion: "0.4.0",
      issue: 3,
      ...(replay === undefined ? {} : { replay }),
    }).slots.verification ?? "";

  it("cites the graded replay's verdict and trial count in the PR, never its local path", () => {
    const text = verification({ verdict: "improve", trials: 24 });
    expect(text).toContain(
      "A graded tier replay backs this change: verdict `improve` over 24 trials",
    );
    expect(text).not.toContain("only evidence");
    expect(text).not.toMatch(/routing-replays|\.json/);
  });

  it("says when the graded replay does not back the change", () => {
    expect(verification({ verdict: "inconclusive", trials: 8 })).toContain(
      "A graded tier replay does not back this change: verdict `inconclusive` over 8 trials",
    );
  });

  it("says the scorecard is the only evidence without a graded replay", () => {
    for (const text of [verification(), verification(null)]) {
      expect(text).toContain(
        "No tier replay backs this change, so the routing scorecard is the only evidence.",
      );
      expect(text).not.toContain("graded tier replay");
    }
  });
});
