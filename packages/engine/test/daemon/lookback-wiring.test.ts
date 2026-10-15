/**
 * The Lookback module wired into the engine by the daemon (AD-21; spine §5 readings 135(d) and
 * 144): core's prompt selector reads the human's pins and canaries from the VTC home, a canary
 * dispatch that ends gets its canary evaluated in the run's log, and `run.finished` attributes the
 * run and writes the scorecards the dashboard lists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  agentNameFor,
  AttributionSchema,
  CONTRACTS_VERSION,
  EDITABLE_IN_PACK_ROLES,
  effectivePromptSha,
  engineRepoKey,
  HOST_IDS,
  LOOKBACK_HOME,
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  LookbackPinsSchema,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  promptShaFor,
  ReplayResultSchema,
  rolePromptAssetPath,
  ScorecardIndexSchema,
  sha256Hex,
  splitRolePrompt,
  TASK_PACK_HEURISTICS_SECTION,
  type AssetBundle,
  type Attribution,
  type HostId,
  type LookbackPinsInput,
  type PluginManifestAgent,
  type TaskPack,
  type UsageSnapshot,
} from "@vtc/shared";
import {
  createPluginCatalog,
  pluginCatalogFrom,
  toYaml,
  type LookbackReplay,
  type LookbackRetro,
  type PluginCatalog,
  type RunState,
} from "../../src/core/index.js";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";
import { lookbackWindow, newAgentFact, wireLookback } from "../../src/daemon/index.js";
import {
  lookbackEvent,
  lookbackTargets,
  pinsPath,
  promptVersionRef,
  storePromptVersion,
  traceRef,
  traceSplit,
} from "../../src/lookback/index.js";
import { cleanupDirs } from "../helpers/repo.js";
import {
  EDITABLE as LOG_EDITABLE,
  LOCKED as LOG_LOCKED,
  LOCKED_SHA as LOG_LOCKED_SHA,
  RunLog,
} from "../lookback/log.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  passFinalReview,
  SPEC_ONE,
  spawns,
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

const ROLES_DIR = fileURLToPath(new URL("../../../../roles/", import.meta.url));

/**
 * The plugins as the shipped compile emits them (D-bl, spine §5 reading 166): every fixture
 * role's agents (one per mode) with their manifest SHAs and both prompt texts from
 * `roles/<role>/prompt.md`, and exactly the shared `EDITABLE_IN_PACK_ROLES` switched to
 * `editable_in_pack`: the list the compiler's default switches, which `packages/cli`'s
 * shipped-plugin test checks against the real compiled manifests. So a change that unswitches
 * `spec_verifier` fails the pin tests below.
 */
const shippedPlugins = (): { readonly catalog: PluginCatalog; readonly locked: string } => {
  const files: Record<string, string> = {};
  let specLocked = "";
  for (const host of HOST_IDS) {
    const agents: PluginManifestAgent[] = [];
    for (const contract of ALL_FIXTURE_ROLES) {
      const path = `${ROLES_DIR}${contract.id}/prompt.md`;
      if (!existsSync(path)) continue;
      const split = splitRolePrompt(readFileSync(path, "utf8"));
      if (!split.ok) throw new Error(`${contract.id}: ${split.errors.join("; ")}`);
      if (contract.id === "spec_verifier") specLocked = split.locked;
      const switchedRole = EDITABLE_IN_PACK_ROLES.includes(contract.id);
      for (const mode of [undefined, ...Object.keys(contract.modes ?? {})]) {
        const name = agentNameFor(contract.id, mode);
        files[`plugin:${host}\n${rolePromptAssetPath(name, "locked")}`] = split.locked;
        files[`plugin:${host}\n${rolePromptAssetPath(name, "editable")}`] = split.editable;
        agents.push({
          name,
          role: contract.id,
          mode: mode ?? null,
          kind: contract.kind,
          discipline: null,
          role_version: contract.version,
          file: `agents/${name}.md`,
          prompt_sha256: switchedRole
            ? sha256Hex(split.locked)
            : promptShaFor(`${split.locked}\n\n${split.editable}`),
          locked_sha256: sha256Hex(split.locked),
          editable_sha256: sha256Hex(split.editable),
          ...(switchedRole ? { editable_in_pack: true } : {}),
          tier: "mid",
          effort: "medium",
        });
      }
    }
    files[`plugin:${host}\n${PLUGIN_MANIFEST_ASSET}`] = JSON.stringify(
      PluginManifestSchema.parse({
        v: 1,
        host,
        plugin: "vtc",
        contracts_version: CONTRACTS_VERSION,
        agents,
      }),
    );
  }
  const bundle: AssetBundle = {
    read: (namespace, path) => {
      const text = files[`${namespace}\n${path}`];
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
    list: (namespace) =>
      Object.keys(files)
        .filter((key) => key.startsWith(`${namespace}\n`))
        .map((key) => key.slice(namespace.length + 1)),
  };
  return { catalog: pluginCatalogFrom(bundle), locked: specLocked };
};

describe("RETRO reads the weekly window of the run's Lead host (AD-21 rule 8, reading 176)", () => {
  const weekly = (host: HostId, used: number): UsageSnapshot => ({
    host,
    source: host === "codex" ? "app_server" : "statusline",
    windows: [
      { kind: "weekly", label: "weekly", window_minutes: 10080, used_pct: used, resets_at: null },
    ],
    model_limits: [],
    updated_at: "2026-10-14T09:00:00.000Z",
  });
  /** Enough attributed train failures of one version for a lookback target. */
  const trainFailures = (host: HostId): Attribution[] => {
    const rows: Attribution[] = [];
    for (let i = 1; rows.length < LOOKBACK_LIMITS.minTrainFailures; i += 1) {
      const trace = { run: "r-old", trace: `a-${String(i)}` };
      if (traceSplit(trace) !== "train") continue;
      rows.push(
        AttributionSchema.parse({
          v: 1,
          ...trace,
          task: "T-1",
          prompt: promptVersionRef({ role: "engineer", host, locked: LOCKED, editable: DEFAULT }),
          outcome: "failure",
          blamed_role: "engineer",
          method: "tree",
          rule: "test_fails",
          confidence: 0.9,
          split: "train",
          evidence: [],
          attributed_at: "2026-10-14T09:00:00.000Z",
        }),
      );
    }
    return rows;
  };

  it("a Codex-led run whose Codex window is low skips with weekly_window, though Claude's is high", async () => {
    const h = createHarness();
    await h.engine.start(
      {
        request: "Password reset\n\nUsers reset forgotten passwords.",
        track: "feature",
        repo: "existing",
        has_ui: false,
        risk_hints: [],
      },
      { host: "codex", client: "bridge", session: "lead-codex" },
    );
    h.engine.ingestUsage(weekly("codex", 90));
    h.engine.ingestUsage(weekly("claude-code", 10));
    const state = h.engine.states()[0];
    if (state === undefined) throw new Error("no run");
    const window = lookbackWindow(h.engine, state);
    expect(window).toEqual({ host: "codex", pct: 10 });
    const rows = trainFailures("codex");
    const fresh = new Set(rows.map(traceRef));
    expect(
      lookbackTargets({
        attributions: rows,
        fresh,
        weeklyRemainingPct: window.pct,
        budgetAvailable: true,
      }),
    ).toEqual({ targets: [], skipped: "weekly_window" });
    // the preferred host's window (Claude's, 90% left) would have let it run
    expect(
      lookbackTargets({ attributions: rows, fresh, weeklyRemainingPct: 90, budgetAvailable: true })
        .targets,
    ).toHaveLength(1);
    await h.release();
  });

  it("through the wiring, a Codex-led run's lookback plan reads the Codex window: low, no target though Claude's is high; high, a target", async () => {
    // the plugins the run log's prompt versions were compiled from
    const catalog: PluginCatalog = {
      ...createPluginCatalog({}),
      promptParts: () => ({
        lockedSha256: LOG_LOCKED_SHA,
        editableInPack: true,
        compiled: { locked: LOG_LOCKED, editable: LOG_EDITABLE },
      }),
    };
    // enough attributed train failures of one Engineer version for a lookback target
    const failing = new RunLog("r-old");
    for (let i = 1; i <= LOOKBACK_LIMITS.minTrainFailures * 4; i += 1) {
      const task = `T-${String(i)}`;
      failing.taskCreated(task);
      failing.dispatch("engineer", { task });
      failing.gate(task, false);
    }
    const planAt = async (codexUsed: number) => {
      const h = createHarness({ plugins: catalog });
      await h.engine.start(
        {
          request: "Password reset\n\nUsers reset forgotten passwords.",
          track: "feature",
          repo: "existing",
          has_ui: false,
          risk_hints: [],
        },
        { host: "codex", client: "bridge", session: "lead-codex" },
      );
      h.engine.ingestUsage(weekly("codex", codexUsed));
      h.engine.ingestUsage(weekly("claude-code", 10));
      const unwire = wireLookback(h.engine, { repoRoot: h.repo, vtcHome: h.home }, catalog);
      const state = h.engine.states()[0];
      if (state === undefined) throw new Error("no run");
      expect(h.engine.liveLeadHost(state.id)).toBe("codex");
      // the wired RETRO plan of this run, over the failing history
      const planned = await h.engine.lookbackRetro()?.plan({ ...state, events: failing.events });
      await unwire();
      await h.release();
      return planned?.targets ?? [];
    };
    // the Codex Lead has 10% of its week left: no lookback role, though Claude's 90% would allow it
    expect(await planAt(90)).toEqual([]);
    const targets = await planAt(10);
    expect(targets.map((t) => [t.role, t.dispatched.type])).toEqual([
      ["engineer", "lookback.dispatched"],
    ]);
  });

  it("through the wiring, RETRO's replays wait on the Lead host's low window, though the preferred host's is high", async () => {
    const h = createHarness({
      plugins: switched,
      project: { merge_level: 1, hosts: { preferred: "codex" } },
    });
    // the Lead's host (Claude Code) has 10% of its week left; the preferred host (Codex) 90%
    h.engine.ingestUsage(weekly("claude-code", 90));
    h.engine.ingestUsage(weekly("codex", 10));
    const unwire = wireLookback(h.engine, { repoRoot: h.repo, vtcHome: h.home }, switched);
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    // a Claude Code session holds the run as its Lead
    const lead = {
      host: "claude-code",
      client: "bridge",
      session: "lead-claude",
      sessionSandbox: "on",
    } as const;
    await verdictPass(
      h,
      only((await h.engine.next({}, lead)).actions, "spec_verifier"),
      "src/t-1/impl.ts",
    );
    await h.engine.settle();
    const run = h.engine.status({}).run.id;
    expect(h.engine.liveLeadHost(run)).toBe("claude-code");
    expect(h.engine.hostFor({ host: null })).toBe("codex");
    // a recorded proposal: RETRO would replay it, window allowing
    h.engine.recordModuleEvent(
      run,
      lookbackEvent("lookback.proposal_recorded", {
        proposal: "p-1",
        path: ".vtc/lookback/proposals/engineer/proposal.json",
        changes: 1,
      }),
    );
    await passFinalReview(h);
    await h.engine.settle();
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    const log = events(h);
    expect(log.some((e) => e.type === "lookback.dispatched")).toBe(false);
    const retro = log.findIndex((e) => e.type === "run.phase_changed" && e.data.to === "retro");
    expect(retro).toBeGreaterThan(0);
    expect(log.slice(retro).filter((e) => e.type === "role.dispatched")).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /lookback replays of run .* wait for the next RETRO: 10% of the weekly window of claude-code \(the run's Lead host\) is left/,
    );
    await unwire();
    await h.release();
  }, 40_000);

  it("without a live Lead it reads the run's limit host, then the engine's default host", () => {
    const engine = {
      liveLeadHost: () => undefined,
      hostFor: () => "claude-code" as const,
      usage: new Map<HostId, UsageSnapshot>([
        ["codex", weekly("codex", 40)],
        ["claude-code", weekly("claude-code", 75)],
      ]),
    };
    expect(
      lookbackWindow(engine, { id: "r-1", limit: { host: "codex" } as RunState["limit"] }),
    ).toEqual({ host: "codex", pct: 60 });
    expect(lookbackWindow(engine, { id: "r-1", limit: null })).toEqual({
      host: "claude-code",
      pct: 25,
    });
    expect(
      lookbackWindow({ ...engine, usage: new Map() }, { id: "r-1", limit: null }).pct,
    ).toBeNull();
  });
});

describe("RETRO replays a recorded proposal end to end (AD-21 rule 6, readings 176 and 201)", () => {
  it("runs its trials headless with each arm's own plugin, grades them through the Gate Runner and writes the result with its SHA-256", async () => {
    const trialPacks: string[] = [];
    const h = createHarness({
      plugins: switched,
      project: { merge_level: 1 },
      // D-cg: every trial is an engine-launched headless run with its arm's compiled plugin
      armPlugins: {
        compileArm: (request) =>
          Promise.resolve({
            dir: request.outDir,
            version: "arm-000000000000",
            promptSha256: effectivePromptSha(LOCKED, request.editable),
          }),
      },
      headless: (request) => {
        const pack = /^Read your task pack: (.*)$/m.exec(request.prompt)?.[1] ?? "";
        trialPacks.push(readFileSync(pack, "utf8"));
        mkdirSync(join(request.cwd, "src/t-1"), { recursive: true });
        writeFileSync(join(request.cwd, "src/t-1/impl.ts"), "export const x = 2;\n");
        return {
          kind: "done",
          session_ref: null,
          output: { role: request.role, summary: "done", exit: "built" },
          model: "sonnet",
          tokens: { in: 100, out: 50, cache_r: 0, cache_w: 0 },
          cost_usd: 0.1,
        };
      },
    });
    h.engine.ingestUsage({
      host: "claude-code",
      source: "statusline",
      windows: [
        { kind: "weekly", label: "weekly", window_minutes: 10080, used_pct: 10, resets_at: null },
      ],
      model_limits: [],
      updated_at: "2026-10-13T09:00:00.000Z",
    });
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
    const run = h.engine.status({}).run.id;
    // a held-out dispatch of a task role that writes files (a verdict role is not replayed): its
    // version gets a recorded proposal
    const held = events(h).find(
      (e) =>
        e.type === "role.dispatched" &&
        e.task !== undefined &&
        e.role === "engineer" &&
        traceSplit({ run, trace: String(e.data.action_id) }) === "holdout",
    );
    if (held?.role === undefined) throw new Error("no held-out task dispatch to replay");
    const role = held.role;
    const candidate = await store(h, role);
    h.engine.recordModuleEvent(
      run,
      lookbackEvent("lookback.proposal_recorded", {
        proposal: "p-1",
        path: `.vtc/lookback/proposals/${role}/proposal.json`,
        changes: 1,
      }),
    );
    const carried = spawns(await passFinalReview(h));
    await h.engine.settle();
    for (let i = 0; i < 2 && h.engine.status({}).run.finished_at === undefined; i += 1) {
      carried.push(...spawns((await h.engine.next({}, CLAUDE)).actions));
      await h.engine.settle();
    }
    await unwire();
    // no trial is a Lead's subagent
    expect(carried.filter((a) => a.role === role)).toEqual([]);
    const trials = trialPacks.length;
    for (const pack of trialPacks)
      expect(pack).toMatch(
        new RegExp(`^## ${TASK_PACK_HEURISTICS_SECTION}\n\n(${CANDIDATE}|${DEFAULT})\n`),
      );
    // k = 3 trials per arm, with an A/A arm (no noise floor was cached)
    expect(trials % 9).toBe(0);
    expect(trials).toBeGreaterThan(0);
    const finished = events(h).filter((e) => e.type === "lookback.replay_finished");
    expect(finished).toHaveLength(1);
    const path = String(finished[0]?.data.path);
    expect(path).toBe(".vtc/lookback/replays/p-1.json");
    const bytes = readFileSync(join(h.repo, path), "utf8");
    expect(finished[0]?.data.sha256).toBe(sha256Hex(bytes));
    const result = ReplayResultSchema.parse(JSON.parse(bytes));
    expect(result).toMatchObject({
      proposal: "p-1",
      role,
      host: "claude-code",
      baseline: effectivePromptSha(LOCKED, DEFAULT),
      candidate,
      k: 3,
      aa_flip_rate: 0,
      // the fake host enforces no read deny (reading 178); the gates graded (D-ch)
      isolation: "paths_only",
      grader: "gates",
    });
    // the noise floor the replay measured is kept for the next one
    expect(existsSync(join(h.home, LOOKBACK_HOME.aaNoiseFile))).toBe(true);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    // the trials measured versions: no scorecard counts them, so the candidate has none
    const index = ScorecardIndexSchema.parse(
      JSON.parse(readFileSync(join(h.repo, LOOKBACK_REPO.scorecardIndex), "utf8")),
    );
    expect(index.scorecards.length).toBeGreaterThan(0);
    expect(index.scorecards.map((c) => c.prompt.effective_sha256)).not.toContain(candidate);
    await h.release();
  }, 120_000);
});

// Spine §5 readings 201 and 202 (D-cg, D-ch): on a Claude Lead every file-writing role replays
// through its arms' own plugins (`EngineDeps.armPlugins`), and a verdict role through the verdict
// grader; without either wired, the replay waits for the next RETRO and says why.
describe("which replays the shipped plugins can reach on a Claude Lead (spine §5 readings 201 and 202)", () => {
  it("compiled as shipped on a Claude Lead, no proposal's replay runs: the Engineer carries its own section, and the Spec Verifier, the one switched role, changes no file", async () => {
    const { catalog } = shippedPlugins();
    const h = createHarness({ plugins: catalog, project: { merge_level: 1 } });
    h.engine.ingestUsage({
      host: "claude-code",
      source: "statusline",
      windows: [
        { kind: "weekly", label: "weekly", window_minutes: 10080, used_pct: 10, resets_at: null },
      ],
      model_limits: [],
      updated_at: "2026-10-13T09:00:00.000Z",
    });
    const unwire = wireLookback(h.engine, { repoRoot: h.repo, vtcHome: h.home }, catalog);
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    await verdictPass(
      h,
      only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
      "src/t-1/impl.ts",
    );
    await h.engine.settle();
    const run = h.engine.status({}).run.id;
    // a candidate stored and a proposal recorded for each of the two roles
    for (const [role, proposal] of [
      ["engineer", "p-eng"],
      ["spec_verifier", "p-sv"],
    ] as const) {
      const compiled = catalog.promptParts?.(agentNameFor(role), "claude-code")?.compiled;
      if (compiled === undefined) throw new Error(`${role} is not compiled`);
      const editable = `${compiled.editable}\n\nCite the evidence for every claim.`;
      await storePromptVersion(
        h.home,
        {
          v: 1,
          version: promptVersionRef({
            role,
            host: "claude-code",
            locked: compiled.locked,
            editable,
          }),
          parent: effectivePromptSha(compiled.locked, compiled.editable),
          proposal,
          changelog: { hypothesis: "Cite.", trace_ids: ["a-1"], evaluation: null },
          created_at: h.clock.toISOString(),
        },
        editable,
      );
      h.engine.recordModuleEvent(
        run,
        lookbackEvent("lookback.proposal_recorded", {
          proposal,
          path: `.vtc/lookback/proposals/${role}/proposal.json`,
          changes: 1,
        }),
      );
    }
    await passFinalReview(h);
    await h.engine.settle();
    await unwire();
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    const log = events(h);
    const retro = log.findIndex((e) => e.type === "run.phase_changed" && e.data.to === "retro");
    expect(retro).toBeGreaterThan(0);
    expect(log.slice(retro).filter((e) => e.type === "role.dispatched")).toEqual([]);
    expect(log.filter((e) => e.type === "lookback.replay_finished")).toEqual([]);
    // neither has a recorded held-out dispatch of its baseline: the Engineer's dispatches carry
    // no prompt version (its agent carries its own section), and the Spec Verifier's one task
    // dispatch here fell in the train split
    expect(h.engine.notices.join("\n")).toMatch(
      /wait for the next RETRO: left out: p-eng: no held-out task of its baseline can be run again; p-sv: no held-out task of its baseline can be run again/,
    );
    await h.release();
  }, 60_000);

  it("compiled as shipped on a Claude Lead with no arm compiler and no verdict grader wired, both roles' replays wait and say why", async () => {
    const { catalog } = shippedPlugins();
    const h = createHarness({ plugins: catalog, project: { merge_level: 1 } });
    const replayOf = (role: string): LookbackReplay => {
      const compiled = catalog.promptParts?.(agentNameFor(role), "claude-code")?.compiled;
      if (compiled === undefined) throw new Error(`${role} is not compiled`);
      const version = promptVersionRef({
        role,
        host: "claude-code",
        locked: compiled.locked,
        editable: compiled.editable,
      });
      return {
        proposal: `p-${role}`,
        role,
        host: "claude-code",
        trials: [
          {
            arm: "a",
            trial: 1,
            task: "r-old:T-1",
            regressionSet: false,
            role,
            host: "claude-code",
            prompt: { version, text: compiled.editable },
            pack: {} as TaskPack,
            base: "a".repeat(40),
          },
        ],
      };
    };
    const retro: LookbackRetro = {
      plan: () => Promise.resolve({ targets: [] }),
      check: () => Promise.resolve({ ok: true, events: [] }),
      replays: () =>
        Promise.resolve({ replays: [replayOf("engineer"), replayOf("spec_verifier")] }),
      gradeTrial: () => Promise.reject(new Error("never")),
      finishReplay: () => Promise.reject(new Error("never")),
    };
    h.engine.setLookbackRetro(retro);
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    await verdictPass(
      h,
      only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
      "src/t-1/impl.ts",
    );
    await h.engine.settle();
    await passFinalReview(h);
    await h.engine.settle();
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    const log = events(h);
    const retroAt = log.findIndex((e) => e.type === "run.phase_changed" && e.data.to === "retro");
    expect(log.slice(retroAt).filter((e) => e.type === "role.dispatched")).toEqual([]);
    const notices = h.engine.notices.join("\n");
    expect(notices).toMatch(
      /proposal p-engineer waits for the next RETRO: a claude-code trial runs its arm's own compiled plugin, and no arm plugin compiler is wired/,
    );
    expect(notices).toMatch(
      /proposal p-spec_verifier waits for the next RETRO: vtc-spec-verifier is graded by its verdict, and no verdict grader is wired \(spine §5 reading 202\)/,
    );
    await h.release();
  }, 60_000);
});

describe("Lookback's new-agent signals reach automation (D-cd)", () => {
  it("as a new_agent fact whose subject is the proposed role; only a role VTC named after a shipped discipline may leave the machine", () => {
    const signal = {
      kind: "new_agent" as const,
      basis: "discipline_failures" as const,
      proposed_role: "engineer_mobile",
      discipline: "mobile" as const,
      stack_packs: [],
      failures: 4,
      escalations: 0,
      traces: ["r1:a-1"],
      evidence_only: true as const,
      labels: ["needs-eval"],
    };
    expect(newAgentFact("r1", signal, "2026-10-15T08:00:00.000Z")).toMatchObject({
      target: "upstream",
      kind: "new_agent",
      run: "r1",
      subject: "engineer_mobile",
      role: "engineer_mobile",
      metrics: { failures: 4, escalations: 0 },
    });
    // a stack named in the project (say after a client) is fingerprinted, never sent
    const stack = newAgentFact(
      "r1",
      { ...signal, basis: "stack_failures", proposed_role: "engineer_globexpay" },
      "2026-10-15T08:00:00.000Z",
    );
    expect(stack.subject).toBe("engineer_globexpay");
    expect(stack).not.toHaveProperty("role");
  });
});

describe("the daemon wires the Lookback module (AD-21)", () => {
  it("compiled as shipped (spec_verifier switched, D-bl), a human's pin reaches the Spec Verifier's pack (reading 176)", async () => {
    const { catalog, locked } = shippedPlugins();
    expect(catalog.promptParts?.("vtc-spec-verifier", "claude-code")?.editableInPack).toBe(true);
    const h = createHarness({ plugins: catalog });
    const heuristics = "Judge only what the cited test output shows; an uncited claim is unknown.";
    const version = promptVersionRef({
      role: "spec_verifier",
      host: "claude-code",
      locked,
      editable: heuristics,
    });
    const compiled = catalog.promptParts?.("vtc-spec-verifier", "claude-code")?.compiled;
    await storePromptVersion(
      h.home,
      {
        v: 1,
        version,
        parent: effectivePromptSha(locked, compiled?.editable ?? ""),
        proposal: "p-1",
        changelog: { hypothesis: "Cite or say unknown.", trace_ids: ["a-1"], evaluation: null },
        created_at: h.clock.toISOString(),
      },
      heuristics,
    );
    writePins(h, {
      pins: [
        { role: "spec_verifier", host: "claude-code", effective_sha256: version.effective_sha256 },
      ],
    });
    const unwire = wireLookback(h.engine, { repoRoot: h.repo, vtcHome: h.home }, catalog);
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    const verifier = only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");
    const pack = readFileSync(join(h.repo, verifier.pack), "utf8");
    expect(pack.startsWith(`## ${TASK_PACK_HEURISTICS_SECTION}\n\n${heuristics}\n`)).toBe(true);
    const dispatched = events(h).findLast(
      (e) => e.type === "role.dispatched" && e.role === "spec_verifier",
    );
    expect(dispatched?.prompt_sha).toBe(version.effective_sha256);
    expect(dispatched?.data.editable_sha256).toBe(sha256Hex(heuristics));
    // the agents that carry their own section ran their compiled prompt, with nothing to record
    const engineer = events(h).find((e) => e.type === "role.dispatched" && e.role === "engineer");
    expect(engineer?.data).not.toHaveProperty("editable_sha256");
    expect(events(h).filter((e) => e.type === "incident.recorded")).toEqual([]);
    await unwire();
    await h.release();
  });

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

  it("wires RETRO, and at run.finished attributes the run and writes the scorecards the dashboard lists (rule 8), then tells automation", async () => {
    const h = createHarness({ plugins: switched, project: { merge_level: 1 } });
    // the automation's cost regressions read the scorecards once they are written (D-bv)
    const written: [string, boolean][] = [];
    const unwire = wireLookback(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home },
      switched,
      (run) => {
        written.push([run, existsSync(join(h.repo, LOOKBACK_REPO.scorecardIndex))]);
      },
    );
    // D-ch: RETRO can replay a verdict role (the Spec Verifier) through the verdict grader
    expect(h.engine.lookbackRetro()).toHaveProperty("gradeVerdict", expect.any(Function));
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
    expect(written).toEqual([[h.engine.status({}).run.id, true]]);
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
