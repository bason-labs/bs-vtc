/**
 * The Lookback module wired into the engine by the daemon (AD-21; spine §5 readings 135(d) and
 * 144): core's prompt selector reads the human's pins and canaries from the VTC home, a canary
 * dispatch that ends gets its canary evaluated in the run's log, and `run.finished` attributes the
 * run and writes the scorecards the dashboard lists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectivePromptSha,
  engineRepoKey,
  LOOKBACK_REPO,
  LookbackPinsSchema,
  ScorecardIndexSchema,
  sha256Hex,
  type LookbackPinsInput,
} from "@vtc/shared";
import { createPluginCatalog, toYaml, type PluginCatalog } from "../../src/core/index.js";
import { wireLookback } from "../../src/daemon/index.js";
import { pinsPath, promptVersionRef, storePromptVersion } from "../../src/lookback/index.js";
import { cleanupDirs } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  passFinalReview,
  SPEC_ONE,
  throughPlan,
  verdictPass,
  type Harness,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

const LOCKED = "You are a VTC role.";
const DEFAULT = "Prefer the smallest change that meets the contract.";
const CANDIDATE = "Write the failing test first, then the smallest change.";

/** Every agent compiled without its editable section, carrying both texts (reading 142). */
const switched: PluginCatalog = {
  ...createPluginCatalog({}),
  promptParts: () => ({
    lockedSha256: sha256Hex(LOCKED),
    editableInPack: true,
    compiled: { locked: LOCKED, editable: DEFAULT },
  }),
};

interface Line {
  type: string;
  task?: string;
  role?: string;
  prompt_sha?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

const store = async (h: Harness, role: string, mode?: string): Promise<string> => {
  const version = promptVersionRef({
    role,
    mode,
    host: "claude-code",
    locked: LOCKED,
    editable: CANDIDATE,
  });
  await storePromptVersion(
    h.home,
    {
      v: 1,
      version,
      parent: effectivePromptSha(LOCKED, DEFAULT),
      proposal: "p-1",
      changelog: { hypothesis: "Tests first.", trace_ids: ["a-1"], evaluation: null },
      created_at: h.clock.toISOString(),
    },
    CANDIDATE,
  );
  return version.effective_sha256;
};

const writePins = (
  h: Harness,
  project: NonNullable<LookbackPinsInput["projects"]>[string],
): void => {
  mkdirSync(join(h.home, "lookback"), { recursive: true });
  writeFileSync(
    pinsPath(h.home),
    toYaml(LookbackPinsSchema.parse({ v: 1, projects: { [engineRepoKey(h.repo)]: project } })),
  );
};

const start = (h: Harness) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CLAUDE,
  );

describe("the daemon wires the Lookback module (AD-21)", () => {
  it("hands core a prompt selector that runs the human's pin from the VTC home", async () => {
    const h = createHarness({ plugins: switched });
    const pinned = await store(h, "repo_cartographer");
    writePins(h, {
      pins: [{ role: "repo_cartographer", host: "claude-code", effective_sha256: pinned }],
    });
    // a pins.yaml inside the repo selects nothing (rule 3)
    mkdirSync(join(h.repo, ".vtc/lookback"), { recursive: true });
    writeFileSync(join(h.repo, ".vtc/lookback/pins.yaml"), "v: 1\n");
    const unwire = wireLookback(h.engine, { repoRoot: h.repo, vtcHome: h.home }, switched);
    expect(h.engine.promptPins()).not.toBeNull();
    await start(h);
    const carto = only((await h.engine.next({}, CLAUDE)).actions, "repo_cartographer");
    expect(readFileSync(join(h.repo, carto.pack), "utf8")).toContain(CANDIDATE);
    const dispatched = events(h).find((e) => e.type === "role.dispatched");
    expect(dispatched?.prompt_sha).toBe(pinned);
    expect(dispatched?.data.editable_sha256).toBe(sha256Hex(CANDIDATE));
    await unwire();
    expect(h.engine.promptPins()).toBeNull();
    await h.release();
  });

  it("a pin it cannot honour runs the compiled default and records a prompt_selection incident", async () => {
    const h = createHarness({ plugins: switched });
    writePins(h, {
      pins: [{ role: "repo_cartographer", host: "claude-code", effective_sha256: "b".repeat(64) }],
    });
    const unwire = wireLookback(h.engine, { repoRoot: h.repo, vtcHome: h.home }, switched);
    await start(h);
    const carto = only((await h.engine.next({}, CLAUDE)).actions, "repo_cartographer");
    expect(readFileSync(join(h.repo, carto.pack), "utf8")).toContain(DEFAULT);
    const incident = events(h).find((e) => e.type === "incident.recorded");
    expect(incident?.data).toMatchObject({ kind: "prompt_selection" });
    expect(String(incident?.data.detail)).toMatch(/missing or does not verify/);
    await unwire();
    await h.release();
  });

  it("evaluates the canary when a canary dispatch ends, in the run's log (rule 7)", async () => {
    const h = createHarness({ plugins: switched });
    // QA authors a task's tests in mode `author`
    const candidate = await store(h, "qa", "author");
    writePins(h, {
      canaries: [
        {
          role: "qa",
          mode: "author",
          host: "claude-code",
          candidate,
          baseline: effectivePromptSha(LOCKED, DEFAULT),
          started_at: h.clock.toISOString(),
          assignment: "task_hash_50",
        },
      ],
    });
    const unwire = wireLookback(h.engine, { repoRoot: h.repo, vtcHome: h.home }, switched);
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await h.engine.settle();
    await unwire();
    const log = events(h);
    const qa = log.find((e) => e.type === "role.dispatched" && e.role === "qa" && e.task === "T-1");
    expect(qa?.data.canary_arm).toMatch(/^(candidate|baseline)$/);
    const evaluated = log.filter((e) => e.type === "lookback.canary_evaluated");
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]?.data).toMatchObject({
      role: "qa",
      mode: "author",
      host: "claude-code",
      candidate,
    });
    await h.release();
  });

  it("wires RETRO, and at run.finished attributes the run and writes the scorecards the dashboard lists (rule 8)", async () => {
    const h = createHarness({ plugins: switched, project: { merge_level: 1 } });
    const unwire = wireLookback(h.engine, { repoRoot: h.repo, vtcHome: h.home }, switched);
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    await verdictPass(
      h,
      only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
      "src/t-1/impl.ts",
    );
    await h.engine.settle();
    expect(existsSync(join(h.repo, LOOKBACK_REPO.scorecardIndex))).toBe(false);
    // RETRO asked Lookback first (reading 154): one passing task leaves no target, so the run ends
    expect(h.engine.lookbackRetro()).not.toBeNull();
    await passFinalReview(h);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    const log = readFileSync(
      join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`),
      "utf8",
    );
    expect(log).toContain('"to":"retro"');
    expect(log).not.toContain("lookback.dispatched");
    await unwire();
    expect(h.engine.lookbackRetro()).toBeNull();
    const index = ScorecardIndexSchema.parse(
      JSON.parse(readFileSync(join(h.repo, LOOKBACK_REPO.scorecardIndex), "utf8")),
    );
    const roles = index.scorecards.map((c) => c.prompt.role);
    expect(roles).toEqual(expect.arrayContaining(["engineer", "qa"]));
    for (const card of index.scorecards) {
      expect(card.prompt.effective_sha256).toBe(effectivePromptSha(LOCKED, DEFAULT));
      expect(existsSync(join(h.repo, card.path))).toBe(true);
    }
    await h.release();
  }, 40_000);
});
