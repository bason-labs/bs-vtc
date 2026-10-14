/**
 * What G2 shows and what its approval must carry (spec §8.2, §8.6, §9.1, §6.1 DESIGN; spine
 * AD-22 rule 4, §5 readings 109–110): `gate.requested` with the directions, the unverified facts
 * and the design coverage; an approval that does not waive every unverified fact with a reason is
 * rejected; each waiver is recorded as `fact.waived`; with directions on offer the human picks one.
 */
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineRepoKey,
  factId,
  noveltyReportPath,
  type ApproveInput,
  type DesignLibraryEntry,
  type FactRow,
  type LeadAction,
  type NoveltyCheckRequest,
  type NoveltyReport,
  type ResearchScope,
} from "@vtc/shared";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";
import { unverifiedFacts } from "../../src/core/g2.js";
import type { Kernel } from "../../src/core/kernel.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
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
    // the spine's research section states an EOL date that cites no fact
    const uncited = factId(
      ".vtc/architecture/spine.md",
      "uncited_eol",
      "Postgres 17 is supported until 2029.",
      null,
    );
    expect(gate.unverified_facts).toEqual([unverified.id, stale.id, uncited, tag]);
    expect(gate.facts).toEqual([
      expect.objectContaining({
        id: unverified.id,
        status: "unverified",
        reason: expect.stringContaining("no source") as unknown,
      }),
      expect.objectContaining({ id: stale.id, status: "stale" }),
      expect.objectContaining({
        id: uncited,
        subject: ".vtc/architecture/spine.md:5",
        predicate: "uncited_eol",
        status: "unverified",
        reason: expect.stringContaining("cites no fact") as unknown,
      }),
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
    ).rejects.toThrow(new RegExp(`not waived: ${stale.id}, ${uncited}, ${tag}`));
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

  it("re-fetches the stale facts once before G2 shows: a fact verified again is not listed", async () => {
    const stale = row({
      id: factId("react@19", "license", "MIT", null),
      subject: "react@19",
      predicate: "license",
      value: "MIT",
      status: "stale",
    });
    const h = createHarness({
      files: { ".vtc/research/facts.jsonl": `${JSON.stringify(stale)}\n` },
    });
    let refreshed = 0;
    h.engine.setFactRefresher((repoRoot) => {
      refreshed += 1;
      const again = {
        ...stale,
        id: factId("react@19", "license", "MIT", "https://deps.dev/react"),
        status: "verified",
        supersedes: stale.id,
        source: {
          fetcher: "depsdev",
          url: "https://deps.dev/react",
          retrieved_at: "2026-10-13T08:00:00.000Z",
          content_sha256: "b".repeat(64),
          locator: { kind: "json_pointer", pointer: "/license" },
        },
      };
      writeFile(
        repoRoot,
        ".vtc/research/facts.jsonl",
        `${JSON.stringify(stale)}\n${JSON.stringify(again)}\n`,
      );
      // `null`: core reads the statuses the rows record
      return Promise.resolve(null);
    });
    const gate = await toG2(h);
    expect(refreshed).toBe(1);
    expect(gate.unverified_facts).not.toContain(stale.id);
    await h.engine.next({}, CLAUDE);
    expect(refreshed).toBe(1);
    await h.release();
  });

  it("with nothing unverified G2 approves as before", async () => {
    const h = createHarness();
    const gate = await toG2(h);
    expect(gate.unverified_facts.filter((id) => !id.startsWith("f-"))).toEqual([]);
    const listed = gate.unverified_facts;
    expect(listed).toHaveLength(2); // the spine's uncited EOL claim and its UNVERIFIED: line
    const out = await approve(h, gate, {
      waived_facts: listed,
      fact_waivers: listed.map((id) => ({ id, reason: "the human checked it" })),
    });
    expect(only(out.actions, "planner").role).toBe("planner");
    await h.release();
  });
});

describe("uncited version, licence, CVE and EOL claims in research sections (AD-22 rule 4)", () => {
  const kernelAt = (repoRoot: string): Kernel => ({ deps: { repoRoot } }) as unknown as Kernel;
  const DOC = [
    "# Spine",
    "",
    "## Context",
    "",
    "- We run Node 22.11.0 today.", // not a research section
    "",
    "## Research",
    "",
    "- react 19.1.0 is the latest release (f-0123456789abcdef).", // cited
    "- lodash is MIT licensed.",
    "- CVE-2025-1234 affects the old parser.",
    "- Node 20 reaches end of life in April 2026.",
    "- The team knows TypeScript well.", // no claim
    "",
    "```",
    "# not a heading: inside a fence",
    "```",
    "- vite@7 is the build tool.",
    "",
    "### Hosting",
    "",
    "- Postgres 17.2 is the managed version.", // a subsection of Research
    "",
    "## Decision",
    "",
    "- Use pnpm 10.0.0.", // research section closed
    "",
  ].join("\n");

  it("lists each uncited claim of a research section with its kind, and nothing elsewhere", () => {
    const repo = tempDir();
    writeFile(repo, ".vtc/architecture/spine.md", DOC);
    const facts = unverifiedFacts(kernelAt(repo), [".vtc/architecture/spine.md"]);
    expect(facts.map((f) => [f.subject, f.predicate])).toEqual([
      [".vtc/architecture/spine.md:10", "uncited_licence"],
      [".vtc/architecture/spine.md:11", "uncited_cve"],
      [".vtc/architecture/spine.md:12", "uncited_eol"],
      [".vtc/architecture/spine.md:18", "uncited_version"],
      [".vtc/architecture/spine.md:22", "uncited_version"],
    ]);
    expect(facts[0]).toMatchObject({
      id: factId(".vtc/architecture/spine.md", "uncited_licence", "lodash is MIT licensed.", null),
      status: "unverified",
    });
  });

  it("a research brief is a research section as a whole", () => {
    const repo = tempDir();
    writeFile(repo, ".vtc/research/briefs/stack.md", "# Stack\n\n- Use pnpm 10.0.0.\n");
    const brief = ".vtc/research/briefs/stack.md";
    expect(unverifiedFacts(kernelAt(repo), [brief])).toEqual([]);
    expect(
      unverifiedFacts(kernelAt(repo), [brief], new Set([brief])).map((f) => f.predicate),
    ).toEqual(["uncited_version"]);
  });

  it("never reads a role-written document through a symlink", () => {
    const repo = tempDir();
    const outside = tempDir();
    writeFile(outside, "secret.md", "## Research\n\n- UNVERIFIED: host secret 1.2.3\n");
    writeFile(repo, ".vtc/architecture/.keep", "");
    symlinkSync(join(outside, "secret.md"), join(repo, ".vtc/architecture/spine.md"));
    symlinkSync(outside, join(repo, ".vtc/research-link"));
    expect(unverifiedFacts(kernelAt(repo), [".vtc/architecture/spine.md"])).toEqual([]);
    expect(unverifiedFacts(kernelAt(repo), [".vtc/research-link/secret.md"])).toEqual([]);
  });
});

/**
 * The Designer declares `design_direction` (roles/designer). The `novelty_report` output here lets
 * a test show that a verdict the Designer submits itself is never read (spine §5 reading 116).
 */
const ROLES = ALL_FIXTURE_ROLES.map((r) =>
  r.id === "designer"
    ? {
        ...r,
        output: {
          ...r.output,
          artifacts: [...r.output.artifacts, "novelty_report"],
        },
      }
    : r,
);

const SIGNAL_REPORT: NoveltyReport = {
  v: 1,
  direction: "signal",
  phash: "0123456789abcdef",
  token_vector: [0.1, 0.2],
  nearest: [],
  thresholds: { phash_distance: 10, token_distance: 0.2 },
  verdict: "novel",
};

/**
 * The gate runner's novelty seam (reading 127) on the harness's fake: `checkNovelty` reports
 * `signal` novel and fails for anything else; `recordDesignChoice` keeps what it was given.
 */
const noveltySeam = (h: Harness, failRecord = false) => {
  const checked: NoveltyCheckRequest[] = [];
  const recorded: { entry: DesignLibraryEntry; scope: ResearchScope }[] = [];
  h.gates.checkNovelty = (request) => {
    checked.push(request);
    return request.direction === "signal"
      ? Promise.resolve(SIGNAL_REPORT)
      : Promise.reject(new Error("no first viewport rendered"));
  };
  h.gates.recordDesignChoice = (entry, scope) => {
    if (failRecord) return Promise.reject(new Error("the design library is read-only"));
    recorded.push({ entry, scope });
    return Promise.resolve();
  };
  return { checked, recorded };
};

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
      "id: signal\ntitle: Signal\nthesis: high-contrast and fast\nprototype: .vtc/design/prototype/signal\nfirst_viewport: .vtc/design/prototype/signal/first.png\n",
    );
    // a verdict the Designer wrote itself is dropped (spine §5 reading 116)
    writeFile(
      cwd,
      ".vtc/design/directions/bold.json",
      JSON.stringify({
        id: "bold",
        title: "Bold",
        thesis: "loud type, one accent",
        prototype: ".vtc/design/prototype/directions/bold/index.html",
        novelty: "novel",
      }),
    );
    // a verdict the Designer submits as a report is never read either (reading 116)
    writeFile(
      cwd,
      ".vtc/design/directions/bold-novelty.json",
      JSON.stringify({ ...SIGNAL_REPORT, direction: "bold" }),
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
      { type: "design_direction", path: ".vtc/design/directions/bold.json" },
      { type: "novelty_report", path: ".vtc/design/directions/bold-novelty.json" },
      { type: "component_specs", path: ".vtc/design/components/button.yaml" },
    ];
  };

  it("shows each direction with the engine's novelty verdict, and the coverage report in gate.requested", async () => {
    const h = createHarness({ roles: ROLES });
    const seam = noveltySeam(h);
    const gate = await toG2(h, { hasUi: true, designer: designerWork });
    // only a direction with a first viewport is checked, in the project's client scope
    expect(seam.checked).toEqual([
      {
        direction: "signal",
        firstViewport: ".vtc/design/prototype/signal/first.png",
        scope: "_shared",
      },
    ]);
    expect(JSON.parse(readFileSync(join(h.repo, noveltyReportPath("signal")), "utf8"))).toEqual(
      SIGNAL_REPORT,
    );
    expect(gate.design_directions).toEqual(["quiet-ledger", "signal", "bold"]);
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
        first_viewport: ".vtc/design/prototype/signal/first.png",
        novelty: "novel",
      },
      {
        id: "bold",
        title: "Bold",
        thesis: "loud type, one accent",
        prototype: ".vtc/design/prototype/directions/bold/index.html",
        novelty: "unchecked",
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

  const waiveAll = (gate: ApproveGate) => ({
    waived_facts: gate.unverified_facts,
    fact_waivers: gate.unverified_facts.map((id) => ({ id, reason: "ok" })),
  });

  it("records the chosen direction through the gate runner's design library (§9.1 step 6)", async () => {
    const h = createHarness({ roles: ROLES });
    const seam = noveltySeam(h);
    const gate = await toG2(h, { hasUi: true, designer: designerWork });
    await approve(h, gate, { ...waiveAll(gate), design_direction: "signal" });
    expect(seam.recorded).toEqual([
      {
        scope: "_shared",
        entry: {
          v: 1,
          id: expect.stringMatching(/^[a-f0-9]{16}-[a-f0-9]{12}$/) as string,
          project_key: engineRepoKey(h.repo),
          direction: "signal",
          phash: "0123456789abcdef",
          token_vector: [0.1, 0.2],
          chosen_at: "2026-10-13T09:00:00.000Z",
        },
      },
    ]);
    await h.release();
  });

  it("keeps a client's directions in the client's own library", async () => {
    const h = createHarness({ roles: ROLES, project: { client: "acme" } });
    const seam = noveltySeam(h);
    const gate = await toG2(h, { hasUi: true, designer: designerWork });
    expect(seam.checked.map((c) => c.scope)).toEqual(["client-acme"]);
    await approve(h, gate, { ...waiveAll(gate), design_direction: "signal" });
    expect(seam.recorded.map((r) => [r.scope, r.entry.direction])).toEqual([
      ["client-acme", "signal"],
    ]);
    await h.release();
  });

  it("a chosen direction with no engine novelty report has nothing to record", async () => {
    const h = createHarness({ roles: ROLES });
    const seam = noveltySeam(h);
    const gate = await toG2(h, { hasUi: true, designer: designerWork });
    // bold's only report is the one the Designer submitted
    await approve(h, gate, { ...waiveAll(gate), design_direction: "bold" });
    expect(seam.recorded).toEqual([]);
    await h.release();
  });

  it("an approval whose direction the library could not record is refused and records nothing", async () => {
    const h = createHarness({ roles: ROLES });
    noveltySeam(h, true);
    const gate = await toG2(h, { hasUi: true, designer: designerWork });
    await expect(
      approve(h, gate, { ...waiveAll(gate), design_direction: "signal" }),
    ).rejects.toThrow(
      /could not be recorded in the design library: the design library is read-only/,
    );
    // G1 was approved on the way; G2 is not
    expect(ofType(h, "gate.approved").map((e) => e.data.gates)).toEqual([["G1"]]);
    expect(ofType(h, "fact.waived")).toEqual([]);
    await h.release();
  });

  it("without the gate runner's novelty seam every direction stays unchecked", async () => {
    const h = createHarness({ roles: ROLES });
    const gate = await toG2(h, { hasUi: true, designer: designerWork });
    expect(gate.directions?.map((d) => d.novelty)).toEqual(["unchecked", "unchecked", "unchecked"]);
    await approve(h, gate, { ...waiveAll(gate), design_direction: "signal" });
    expect(ofType(h, "gate.approved").at(-1)?.data.design_direction).toBe("signal");
    await h.release();
  });
});
