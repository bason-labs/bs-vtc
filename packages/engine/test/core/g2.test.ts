/**
 * What G2 shows and what its approval must carry (spec §8.2, §8.6, §9.1, §6.1 DESIGN; spine
 * AD-22 rule 4, §5 readings 109–110): `gate.requested` with the directions, the unverified facts
 * and the design coverage; an approval that does not waive every unverified fact with a reason is
 * rejected; each waiver is recorded as `fact.waived`; with directions on offer the human picks one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { factId, type ApproveInput, type FactRow, type LeadAction } from "@vtc/shared";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  only,
  SPEC,
  spawns,
  submitResult,
  threatModel,
  workdir,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 20_000 });
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
const ofType = (h: Harness, type: string): Line[] => events(h).filter((e) => e.type === type);

type ApproveGate = Extract<LeadAction, { type: "approve_gate" }>;
const gateOf = (actions: readonly LeadAction[]): ApproveGate => {
  const gate = actions.find((a): a is ApproveGate => a.type === "approve_gate");
  if (gate === undefined) throw new Error(`expected a gate, got ${JSON.stringify(actions)}`);
  return gate;
};

const SPINE = [
  "# Spine",
  "",
  "## Research",
  "",
  "- Postgres 17 is supported until 2029.",
  "- UNVERIFIED: the hosting plan includes point-in-time recovery",
  "",
].join("\n");

const row = (over: Partial<FactRow>): FactRow => ({
  v: 1,
  id: factId("nodejs@22", "eol_date", "2027-04-30", null),
  subject: "nodejs@22",
  predicate: "eol_date",
  value: "2027-04-30",
  status: "unverified",
  source: null,
  recorded_by: "research_analyst",
  recorded_at: "2026-10-13T08:00:00.000Z",
  ...over,
});

/** Discover, specify and G1 of a feature run, then the design phase, up to G2. */
const toG2 = async (
  h: Harness,
  options: {
    readonly hasUi?: boolean;
    readonly designer?: (action: SpawnAction) => { type: string; path: string }[];
  } = {},
): Promise<ApproveGate> => {
  await h.engine.start(
    {
      request: "Password reset",
      track: "feature",
      repo: "existing",
      has_ui: options.hasUi ?? false,
      risk_hints: [],
    },
    CLAUDE,
  );
  const carto = only((await h.engine.next({}, CLAUDE)).actions, "repo_cartographer");
  writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
  const ba = only(
    (
      await submitResult(h, carto, {
        exit: "done",
        artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
      })
    ).actions,
    "ba",
  );
  writeFile(workdir(ba), ".vtc/spec/spec.md", SPEC);
  const g1 = gateOf(
    (
      await submitResult(h, ba, {
        exit: "done",
        artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
      })
    ).actions,
  );
  const design = (
    await h.engine.approve(
      { gates: g1.gates, decision: "approve", frozen: g1.artifacts, waived_facts: [] },
      CLAUDE,
    )
  ).actions;
  const architect = only(design, "architect");
  const security = only(design, "security");
  writeFile(workdir(architect), ".vtc/architecture/spine.md", SPINE);
  let actions = (
    await submitResult(h, architect, {
      exit: "done",
      artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
    })
  ).actions;
  const designer = spawns(actions).find((a) => a.role === "designer");
  actions = await threatModel(h, security);
  const designerAction = designer ?? spawns(actions).find((a) => a.role === "designer");
  if (designerAction !== undefined && options.designer !== undefined)
    actions = (
      await submitResult(h, designerAction, {
        exit: "done",
        artifacts: options.designer(designerAction),
      })
    ).actions;
  return gateOf(actions);
};

const approve = (h: Harness, gate: ApproveGate, over: Partial<ApproveInput> = {}) =>
  h.engine.approve(
    { gates: gate.gates, decision: "approve", frozen: gate.artifacts, waived_facts: [], ...over },
    CLAUDE,
  );

describe("G2 blocks on unverified facts until a human waives each with a reason (AD-22 rule 4)", () => {
  it("lists unverified, stale and conflicting facts and UNVERIFIED: tags, in gate.requested too", async () => {
    const verified = row({
      id: factId("pg@17", "eol_date", "2029-11-08", "https://endoflife.date/api/postgresql.json"),
      subject: "pg@17",
      value: "2029-11-08",
      status: "verified",
      source: {
        fetcher: "eol",
        url: "https://endoflife.date/api/postgresql.json",
        retrieved_at: "2026-10-13T08:00:00.000Z",
        content_sha256: "a".repeat(64),
        locator: { kind: "json_pointer", pointer: "/0/eol" },
      },
    });
    const unverified = row({});
    const stale = row({
      id: factId("react@19", "license", "MIT", null),
      subject: "react@19",
      predicate: "license",
      value: "MIT",
      status: "stale",
    });
    // a stale row superseded by a verified one is no longer listed
    const replaced = row({
      id: factId("vite@7", "latest_version", "7.1.0", null),
      subject: "vite@7",
      predicate: "latest_version",
      value: "7.1.0",
      status: "stale",
    });
    const replacement = {
      ...verified,
      id: factId("vite@7", "latest_version", "7.1.2", null),
      subject: "vite@7",
      supersedes: replaced.id,
    };
    const h = createHarness({
      files: {
        ".vtc/research/facts.jsonl": `${[verified, unverified, stale, replaced, replacement]
          .map((r) => JSON.stringify(r))
          .join("\n")}\n`,
      },
    });
    const gate = await toG2(h);
    const tag = factId(
      ".vtc/architecture/spine.md",
      "unverified_tag",
      "the hosting plan includes point-in-time recovery",
      null,
    );
    expect(gate.unverified_facts).toEqual([unverified.id, stale.id, tag]);
    expect(gate.facts).toEqual([
      expect.objectContaining({
        id: unverified.id,
        status: "unverified",
        reason: expect.stringContaining("no source") as unknown,
      }),
      expect.objectContaining({ id: stale.id, status: "stale" }),
      expect.objectContaining({
        id: tag,
        subject: ".vtc/architecture/spine.md:6",
        predicate: "unverified_tag",
      }),
    ]);
    const requested = ofType(h, "gate.requested").at(-1)?.data;
    expect(requested).toMatchObject({ gates: ["G2"], unverified_facts: gate.unverified_facts });
    // asking again shows the same gate: it is logged once
    await h.engine.next({}, CLAUDE);
    expect(
      ofType(h, "gate.requested").filter((e) => (e.data.gates as string[]).includes("G2")),
    ).toHaveLength(1);

    // an approval without a waiver for every fact is rejected, and nothing changes
    await expect(approve(h, gate)).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining(unverified.id) as unknown,
    });
    await expect(
      approve(h, gate, {
        waived_facts: [unverified.id],
        fact_waivers: [{ id: unverified.id, reason: "checked by hand" }],
      }),
    ).rejects.toThrow(new RegExp(`not waived: ${stale.id}, ${tag}`));
    expect(h.engine.status({}).run.phase).toBe("g2");

    const waivers = gate.unverified_facts.map((id) => ({ id, reason: `accepted risk for ${id}` }));
    const approved = await approve(h, gate, {
      waived_facts: gate.unverified_facts,
      fact_waivers: waivers,
    });
    expect(only(approved.actions, "planner").role).toBe("planner");
    expect(ofType(h, "fact.waived").map((e) => e.data)).toEqual(waivers);
    expect(ofType(h, "gate.approved").at(-1)?.data.fact_waivers).toEqual(waivers);
    await h.release();
  });

  it("with nothing unverified G2 approves as before", async () => {
    const h = createHarness();
    const gate = await toG2(h);
    expect(gate.unverified_facts.filter((id) => !id.startsWith("f-"))).toEqual([]);
    const tagOnly = gate.unverified_facts;
    expect(tagOnly).toHaveLength(1); // the spine's UNVERIFIED: line
    const out = await approve(h, gate, {
      waived_facts: tagOnly,
      fact_waivers: [{ id: tagOnly[0]!, reason: "the human checked the plan" }],
    });
    expect(only(out.actions, "planner").role).toBe("planner");
    await h.release();
  });
});

/** The Designer's 4.5.0 outputs (roles-compiler declares them in roles/designer this wave). */
const ROLES = ALL_FIXTURE_ROLES.map((r) =>
  r.id === "designer"
    ? {
        ...r,
        output: {
          ...r.output,
          artifacts: [...r.output.artifacts, "design_direction", "novelty_report"],
        },
      }
    : r,
);

describe("G2 directions and the DESIGN coverage check (§9.1, §6.1)", () => {
  const SCREENS = [
    "version: 1",
    "screens:",
    "  - id: reset-request",
    "    route: /reset",
    "    states: [empty, success]",
    "    reqs: [REQ-1]",
    "  - id: about",
    "    route: /about",
    "    states: [success]",
    "",
  ].join("\n");
  const designerWork = (action: SpawnAction): { type: string; path: string }[] => {
    const cwd = workdir(action);
    writeFile(cwd, ".vtc/design/screens.yaml", SCREENS);
    writeFile(
      cwd,
      ".vtc/design/directions/quiet-ledger.md",
      "# Quiet ledger\n\nTHESIS: a calm, paper-like reset flow\n",
    );
    writeFile(
      cwd,
      ".vtc/design/directions/signal.yaml",
      "id: signal\ntitle: Signal\nthesis: high-contrast and fast\nprototype: .vtc/design/prototype/signal\n",
    );
    writeFile(
      cwd,
      ".vtc/design/directions/signal-novelty.json",
      JSON.stringify({
        v: 1,
        direction: "signal",
        phash: "0123456789abcdef",
        token_vector: [0.1, 0.2],
        nearest: [],
        thresholds: { phash_distance: 10, token_distance: 0.2 },
        verdict: "novel",
      }),
    );
    writeFile(
      cwd,
      ".vtc/design/components/button.yaml",
      "id: button\nuses: [icon]\nscreens: [reset-request]\n",
    );
    return [
      { type: "screens", path: ".vtc/design/screens.yaml" },
      { type: "design_direction", path: ".vtc/design/directions/quiet-ledger.md" },
      { type: "design_direction", path: ".vtc/design/directions/signal.yaml" },
      { type: "novelty_report", path: ".vtc/design/directions/signal-novelty.json" },
      { type: "component_specs", path: ".vtc/design/components/button.yaml" },
    ];
  };

  it("shows each direction with its novelty, and the coverage report in gate.requested", async () => {
    const h = createHarness({ roles: ROLES });
    const gate = await toG2(h, { hasUi: true, designer: designerWork });
    expect(gate.design_directions).toEqual(["quiet-ledger", "signal"]);
    expect(gate.directions).toEqual([
      {
        id: "quiet-ledger",
        title: "Quiet ledger",
        thesis: "a calm, paper-like reset flow",
        prototype: ".vtc/design/prototype",
        novelty: "unchecked",
      },
      {
        id: "signal",
        title: "Signal",
        thesis: "high-contrast and fast",
        prototype: ".vtc/design/prototype/signal",
        novelty: "novel",
      },
    ]);
    expect(ofType(h, "gate.requested").at(-1)?.data.design_coverage).toEqual({
      reqs_without_screen: ["REQ-2"],
      screens_without_req: ["about"],
      components_unregistered: ["icon"],
      ok: false,
    });
    // the coverage report is Flow Studio's (gate.requested); the Lead's action stays as frozen
    expect(gate).not.toHaveProperty("design_coverage");
    await h.release();
  });

  it("an approval must pick one of the directions shown", async () => {
    const h = createHarness({ roles: ROLES });
    const gate = await toG2(h, { hasUi: true, designer: designerWork });
    const waive = {
      waived_facts: gate.unverified_facts,
      fact_waivers: gate.unverified_facts.map((id) => ({ id, reason: "ok" })),
    };
    await expect(approve(h, gate, waive)).rejects.toThrow(/pick one design direction/);
    await expect(approve(h, gate, { ...waive, design_direction: "other" })).rejects.toThrow(
      /not one of the directions shown/,
    );
    const out = await approve(h, gate, { ...waive, design_direction: "signal" });
    expect(only(out.actions, "planner").role).toBe("planner");
    expect(ofType(h, "gate.approved").at(-1)?.data.design_direction).toBe("signal");
    await h.release();
  });
});
