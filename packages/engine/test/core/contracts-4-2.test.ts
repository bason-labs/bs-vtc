/**
 * Contracts 4.2.0 on the engine side (spine §5 readings 46, 49, 51, 65 and 67), driven through
 * the tools on a real repo: Codex runs with no invented model id (D-ae), the lint severity cap in
 * triage (reading 46a), `gates_config_hash` and `hidden_tasks` on gate requests (46b, 46c), the
 * Final Review steps from the shared helper (46e), `.vtc/gates.yml` read at the baseline commit
 * and never from the working tree (46f), the structured per-dispatch write scope the cli hook
 * reads (reading 67), `ingestUsage` merging SDK windows by kind, and role sandbox requests with no
 * network (reading 49).
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvidenceBundleSchema,
  GateReportSchema,
  HIDDEN_TESTS,
  SESSION_DEFAULT_MODEL,
  SubmitInputSchema,
  TaskPackSchema,
  type GateReport,
  type GateRunRequest,
  type HostId,
  type LeadAction,
  type RoleContract,
  type SandboxProfile,
  type VtcEvent,
} from "@vtc/shared";
import * as core from "../../src/core/index.js";
import { findingFromTool } from "../../src/core/triage.js";
import { cleanupDirs, git, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  DEFAULT_GATES_YML,
  draft,
  only,
  passFinalReview,
  SPEC_ONE,
  spawns,
  submitResult,
  throughPlan,
  toPlanner,
  toolFinding,
  verdictPass,
  workdir,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";

// Whole engine flows on a real repo spawn a few hundred git processes per test: under turbo's
// parallel load the 5 s default is too tight, so they get room on a loaded machine. A real hang
// still fails, and no assertion changes.
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanupDirs);

type Call = { readonly host: HostId | null };
const CODEX: Call = { host: "codex" };
const next = async (h: Harness, call: Call = CLAUDE): Promise<LeadAction[]> =>
  (await h.engine.next({}, call)).actions;
interface Line {
  type: string;
  seq: number;
  role?: string;
  task?: string;
  model?: string;
  cost_usd?: number | null;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const escalations = (h: Harness): string =>
  JSON.stringify(events(h).filter((e) => e.type === "escalation.opened"));
const start = (h: Harness, call: Call = CLAUDE) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    call,
  );
const toEngineer = async (h: Harness): Promise<SpawnAction> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  return only(await next(h), "engineer");
};
const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const committedGates = (h: Harness): string => git(h.repo, "show", "HEAD:.vtc/gates.yml");
const contract = (id: string): RoleContract => {
  const found = ALL_FIXTURE_ROLES.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no fixture role ${id}`);
  return found;
};

describe("Codex runs on the session's model (D-ae, spine §5 reading 51)", () => {
  it("has no built-in Codex ids, so resolveModel names no model without an explicit one", () => {
    expect(core.DEFAULT_TIER_MODELS.codex).toEqual({});
    const engineer = contract("engineer");
    const hosts = { hosts: { preferred: undefined, dispatch: "plugin_only" } } as never;
    const resolved = core.resolveModel(engineer, "codex", hosts);
    expect(resolved).toEqual({ tier: "mid", effort: engineer.models.codex.effort });
    expect("model" in resolved).toBe(false);
    // a project override or an explicit role model still names one
    const overridden = core.resolveModel(engineer, "codex", {
      hosts: { dispatch: "plugin_only", models: { codex: { mid: "gpt-x" } } },
    } as never);
    expect(overridden.model).toBe("gpt-x");
    expect(core.resolveModel(engineer, "claude-code", hosts).model).toBe("sonnet");
  });
  it("dispatches no Codex role in-session at all, so no spawn names an undefined model (reading 82)", async () => {
    const h = createHarness();
    await start(h, CODEX);
    expect(spawns(await next(h, CODEX))).toEqual([]);
    expect(events(h).some((e) => e.type === "role.dispatched")).toBe(false);
    expect(SESSION_DEFAULT_MODEL).toBeTruthy();
    await h.release();
  });
  it("keeps the cost the host reports though it names no model", async () => {
    const h = createHarness();
    await start(h, CLAUDE);
    const carto = only(await next(h, CLAUDE), "repo_cartographer");
    writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
    const out = await h.engine.submit(
      SubmitInputSchema.parse({
        kind: "result",
        action_id: carto.action_id,
        result: {
          role: "repo_cartographer",
          summary: "done",
          exit: "done",
          artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
        },
        usage: { model: null, tokens: null, cost_usd: 0.4 },
      }),
      CLAUDE,
    );
    expect(out.accepted).toBe(true);
    const submitted = events(h).find((e) => e.type === "role.submitted");
    // a host-computed cost does not depend on VTC knowing the model id (§11 caps count it)
    expect(submitted).toMatchObject({ cost_usd: 0.4 });
    await h.release();
  });
});

describe("tool findings outside the security class cap at medium (reading 46a)", () => {
  it("passes the category, so a lint error never normalises to high", () => {
    const ctx = { run: "r1", task: "T-1", round: 1 } as never;
    const lint = findingFromTool(
      { ...toolFinding("no-console", "critical"), category: "maintainability" },
      ctx,
    );
    expect(lint.severity).toBe("medium");
    const security = findingFromTool(
      { ...toolFinding("sql-injection", "critical"), category: "security" },
      ctx,
    );
    expect(security.severity).toBe("critical");
  });
});

/** Final Review's report (reshaped): hidden tests ran (traceability) and an L6 gate ran. */
const finalReviewWithHiddenAndL6 =
  (h: Harness) =>
  (request: GateRunRequest, report: GateReport): GateReport => {
    if (request.reason !== "final_review") return report;
    const trace = ".vtc/evidence/F-1/traceability.json";
    writeFile(
      h.repo,
      trace,
      JSON.stringify({
        run: request.run,
        feature: "F-1",
        rows: [
          {
            req: "REQ-1.AC-1",
            tests: [{ id: "[REQ-1.AC-1] hidden", status: "pass", hidden: true }],
            covered: true,
          },
        ],
        gaps: [],
        built_at: report.finished_at,
      }),
    );
    writeFile(h.repo, ".vtc/evidence/F-1/inventory.json", "{}");
    const [tests] = report.results;
    return GateReportSchema.parse({
      ...report,
      traceability: trace,
      results: [
        {
          ...tests,
          tests: {
            executed: 1,
            skipped: 0,
            failed: 0,
            inventory: ".vtc/evidence/F-1/inventory.json",
          },
        },
        { ...tests, gate_id: "arch", layer: "L6", tests: undefined },
      ],
    });
  };

describe("gate requests carry the run's committed gates.yml (reading 46b, c, e, f)", () => {
  it("hash on every request, hidden_tasks on Final Review, baseline configs protected, steps from the helper", async () => {
    const h = createHarness({
      project: { merge_level: 1 },
      files: { "eslint.config.js": "export default [];\n" },
    });
    // the working tree's gates.yml also protects eslint, but only the committed file counts
    writeFile(
      h.repo,
      ".vtc/gates.yml",
      JSON.stringify({
        ...DEFAULT_GATES_YML,
        tests: { ...DEFAULT_GATES_YML.tests, protected_configs: ["eslint.config.js"] },
      }),
    );
    h.gates.reshape(finalReviewWithHiddenAndL6(h));
    await build(h, await toEngineer(h));
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    await passFinalReview(h);
    const hash = sha256(`${committedGates(h)}\n`);
    expect(h.gates.requests.map((r) => r.reason)).toEqual(
      expect.arrayContaining(["base_fail_check", "round", "merge_queue", "final_review"]),
    );
    for (const request of h.gates.requests) expect(request.gates_config_hash).toBe(hash);
    const round = h.gates.requests.find((r) => r.reason === "round");
    expect(round?.protected.map((p) => p.path)).toContain("vitest.config.ts");
    expect(round?.protected.map((p) => p.path)).not.toContain("eslint.config.js");
    const final = h.gates.requests.find((r) => r.reason === "final_review");
    expect(final).toMatchObject({ include_hidden: true, hidden_tasks: ["T-1"] });
    expect(final?.layers).toBeUndefined();
    // §6.7a step 2 only because hidden tests ran, step 6 because an L6 gate ran
    const bundle = EvidenceBundleSchema.parse(
      JSON.parse(readFileSync(join(h.repo, ".vtc/evidence/F-1/bundle.json"), "utf8")),
    );
    // and, since wave 3, the AI steps 3–4 and release readiness (7); no UI, so no step 5
    expect(bundle.kind === "feature" && bundle.final_review.steps_run).toEqual([1, 2, 3, 4, 6, 7]);
    expect(core.finalReviewScopeNote([1, 2, 6])).toContain("3, 4, 5, 7 did not run");
    await h.release();
  });
  it("refuses to start a run on a commit with no committed gates.yml (reading 78 supersedes 46f's park)", async () => {
    const h = createHarness({ gatesYml: null });
    // present in the working tree, but not committed where the run would start
    writeFile(h.repo, ".vtc/gates.yml", JSON.stringify(DEFAULT_GATES_YML));
    await expect(start(h)).rejects.toMatchObject({
      code: "config",
      message: expect.stringContaining("run vtc calibrate, commit .vtc/gates.yml") as unknown,
    });
    expect(h.engine.states()).toEqual([]);
    expect(h.gates.requests).toEqual([]);
    await h.release();
  });
  it("parks when the baseline's gates.yml is not the one the run started with", async () => {
    const h = createHarness();
    const planner = await toPlanner(h, SPEC_ONE);
    // recalibrated and committed after the run froze its config (reading 20)
    writeFile(
      h.repo,
      ".vtc/gates.yml",
      JSON.stringify({
        ...DEFAULT_GATES_YML,
        gates: [{ id: "x", layer: "L0", command: ["true"] }],
      }),
    );
    git(h.repo, "commit", "--quiet", "-am", "recalibrate");
    const planned = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1")] as never,
    });
    expect(planned.accepted).toBe(true);
    await h.engine.settle();
    await authorTests(h, only(await next(h), "qa"));
    const parked = h.engine.status({}).parked.find((p) => p.task === "T-1");
    expect(parked).toMatchObject({ reason: "gate_infra" });
    expect(escalations(h)).toContain("not the one this run started with");
    expect(h.gates.requests).toEqual([]);
    // the project's own gates.yml is the cause: a project issue, never a VTC defect (reading 190)
    const opened = events(h).find((e) => e.type === "escalation.opened" && e.task === "T-1");
    const state = h.engine.states().at(-1);
    expect(
      opened === undefined || state === undefined
        ? null
        : core.automationFacts(state, opened as unknown as VtcEvent).map((f) => [f.target, f.kind]),
    ).toEqual([["project", "parked"]]);
    await h.release();
  });
});

/** The run's kept frozen config (`.vtc/state/runs/<run>/config.json`), as an older engine wrote it. */
const keptConfig = (h: Harness): string =>
  join(h.repo, `.vtc/state/runs/${h.engine.status({}).run.id}/config.json`);
const reopen = async (h: Harness): Promise<void> => {
  await h.engine.settle();
  Object.assign(h, { engine: h.reopen() });
};

describe("a restarted engine checks the committed gates.yml of the run's start (reading 46f)", () => {
  const recalibrate = (h: Harness): void => {
    writeFile(
      h.repo,
      ".vtc/gates.yml",
      JSON.stringify({
        ...DEFAULT_GATES_YML,
        gates: [{ id: "x", layer: "L0", command: ["true"] }],
      }),
    );
    git(h.repo, "commit", "--quiet", "-am", "recalibrate");
  };
  /** Plans T-1 and lets its worktree be made; no dispatch is in flight afterwards. */
  const plan = async (h: Harness, planner: SpawnAction): Promise<void> => {
    const planned = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1")] as never,
    });
    expect(planned.accepted).toBe(true);
    await h.engine.settle();
  };
  /** What an older engine kept: the frozen config with no `gates_sha256`. */
  const keepWithoutSha = (h: Harness): void => {
    const kept = JSON.parse(readFileSync(keptConfig(h), "utf8")) as Record<string, unknown>;
    expect(kept.gates_sha256).toMatch(/^[a-f0-9]{64}$/);
    delete kept.gates_sha256;
    writeFile(h.repo, keptConfig(h).slice(h.repo.length + 1), JSON.stringify(kept));
  };
  it("a kept copy with no gates_sha256 still verifies with the run's file", async () => {
    const h = createHarness();
    const started = sha256(`${committedGates(h)}\n`);
    await plan(h, await toPlanner(h, SPEC_ONE));
    keepWithoutSha(h);
    await reopen(h);
    await authorTests(h, only(await next(h), "qa"));
    expect(h.engine.status({}).parked).toEqual([]);
    expect(h.gates.requests.map((r) => r.gates_config_hash)).toEqual([started]);
    await h.release();
  });
  it("a kept copy with no gates_sha256 never adopts a recalibrated base's gates.yml", async () => {
    const h = createHarness();
    const planner = await toPlanner(h, SPEC_ONE);
    recalibrate(h); // before T-1's worktree: its base has the new file
    await plan(h, planner);
    keepWithoutSha(h);
    await reopen(h);
    await authorTests(h, only(await next(h), "qa"));
    expect(h.engine.status({}).parked.find((p) => p.task === "T-1")).toMatchObject({
      reason: "gate_infra",
    });
    expect(escalations(h)).toContain("not the one this run started with");
    expect(h.gates.requests).toEqual([]);
    await h.release();
  });
  it("with no kept copy, the working tree's bytes never stand in for the committed file's hash", async () => {
    const h = createHarness();
    const started = sha256(`${committedGates(h)}\n`);
    await plan(h, await toPlanner(h, SPEC_ONE));
    // the same config in other bytes, uncommitted: the run's config is unchanged
    writeFile(h.repo, ".vtc/gates.yml", JSON.stringify(DEFAULT_GATES_YML));
    rmSync(keptConfig(h));
    await reopen(h);
    await authorTests(h, only(await next(h), "qa"));
    expect(h.engine.status({}).parked).toEqual([]);
    expect(h.gates.requests.map((r) => r.gates_config_hash)).toEqual([started]);
    await h.release();
  });
});

describe("the per-dispatch write scope for vtc hook (reading 67, reading 65)", () => {
  it("persists the pack as JSON, splits worktree globs from main-checkout entries, and packs the committed gates", async () => {
    const h = createHarness();
    // an uncommitted edit (an agent's, say) of the working tree's gates.yml never reaches a pack
    writeFile(
      h.repo,
      ".vtc/gates.yml",
      JSON.stringify({
        ...DEFAULT_GATES_YML,
        tests: { acceptance_globs: ["anywhere/**"], protected_configs: [] },
        gates: [{ id: "noop", layer: "L0", command: ["true"] }],
      }),
    );
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const qa = only(actions, "qa");
    const json = core.taskPackJsonPath(qa.action_id);
    expect(json).toBe(qa.pack.replace(/\.md$/, ".json"));
    const pack = TaskPackSchema.parse(JSON.parse(readFileSync(join(h.repo, json), "utf8")));
    expect(pack.action_id).toBe(qa.action_id);
    expect(pack.gates.map((g) => g.id)).toEqual(["typecheck", "tests"]);
    const rendered = readFileSync(join(h.repo, qa.pack), "utf8");
    expect(rendered).toContain("tests/acceptance/**");
    expect(rendered).not.toContain("anywhere/**");
    expect(rendered).not.toContain("noop");
    const state = h.engine.states().at(-1);
    const run = state?.roleRuns.get(qa.action_id);
    if (state === undefined || run === undefined) throw new Error("no QA run");
    expect(core.dispatchWriteScope(h.repo, state, run)).toEqual({
      action_id: qa.action_id,
      worktree: ".vtc/state/worktrees/T-1",
      worktree_globs: ["tests/acceptance/**"],
      checkout_globs: [`${HIDDEN_TESTS.stagingDir}/T-1/**`],
    });
    await h.release();
  });
  it("gives a phase role its own worktree and its write paths", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    const state = h.engine.states().at(-1);
    const run = state?.roleRuns.get(carto.action_id);
    if (state === undefined || run === undefined) throw new Error("no cartographer run");
    const scope = core.dispatchWriteScope(h.repo, state, run);
    expect(scope?.worktree).toBe(
      `.vtc/state/worktrees/${core.roleWorktreeId(state.id, carto.action_id)}`,
    );
    expect(join(h.repo, scope?.worktree ?? "")).toBe(workdir(carto));
    expect(scope?.worktree_globs).toEqual(contract("repo_cartographer").tools.write_paths);
    expect(scope?.checkout_globs).toEqual([]);
    await h.release();
  });
  it("is null when the pack JSON is missing or belongs to another dispatch", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    const state = h.engine.states().at(-1);
    const run = state?.roleRuns.get(carto.action_id);
    if (state === undefined || run === undefined) throw new Error("no cartographer run");
    const path = join(h.repo, core.taskPackJsonPath(carto.action_id));
    const pack = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFile(
      h.repo,
      core.taskPackJsonPath(carto.action_id),
      JSON.stringify({ ...pack, run: "rOther" }),
    );
    expect(core.dispatchWriteScope(h.repo, state, run)).toBeNull();
    writeFile(h.repo, core.taskPackJsonPath(carto.action_id), "{");
    expect(core.dispatchWriteScope(h.repo, state, run)).toBeNull();
    await h.release();
  });
  it("gives an Engineer no main-checkout entries, whatever its files_scope names under .vtc/state/", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const path = core.taskPackJsonPath(engineer.action_id);
    const pack = JSON.parse(readFileSync(join(h.repo, path), "utf8")) as Record<string, unknown>;
    writeFile(
      h.repo,
      path,
      JSON.stringify({
        ...pack,
        files_scope: [
          "src/t-1/**",
          ".vtc/state/**",
          ".vtc/state/engine.lock",
          ".vtc/state/checkouts/**",
          `${HIDDEN_TESTS.stagingDir}/**`,
          `${HIDDEN_TESTS.stagingDir}/T-1/**`,
        ],
      }),
    );
    const state = h.engine.states().at(-1);
    const run = state?.roleRuns.get(engineer.action_id);
    if (state === undefined || run === undefined) throw new Error("no Engineer run");
    expect(core.dispatchWriteScope(h.repo, state, run)).toEqual({
      action_id: engineer.action_id,
      worktree: ".vtc/state/worktrees/T-1",
      worktree_globs: ["src/t-1/**"],
      checkout_globs: [],
    });
    await h.release();
  });
  it("splits a scope: only QA author mode's own staging entry is a main-checkout entry", () => {
    const staging = (task: string) => `${HIDDEN_TESTS.stagingDir}/${task}/**`;
    const scope = ["tests/acceptance/**", staging("T-1"), staging("T-2"), ".vtc/state/**"];
    expect(core.splitWriteScope(scope, { role: "qa", mode: "author", task: "T-1" })).toEqual({
      worktree: ["tests/acceptance/**"],
      checkout: [staging("T-1")],
    });
    expect(core.splitWriteScope(scope, { role: "qa", mode: "review", task: "T-1" })).toEqual({
      worktree: ["tests/acceptance/**"],
      checkout: [],
    });
    expect(core.splitWriteScope(scope, { role: "engineer", task: "T-1" })).toEqual({
      worktree: ["tests/acceptance/**"],
      checkout: [],
    });
    expect(
      core.isCheckoutScopeEntry(staging("T-1"), { role: "qa", mode: "author", task: "T-1" }),
    ).toBe(true);
    expect(core.isCheckoutScopeEntry(staging("T-1"), { role: "qa", mode: "author" })).toBe(false);
  });
  it("rejects a plan whose files_scope names a .vtc/ path", async () => {
    const h = createHarness();
    const planner = await toPlanner(h, SPEC_ONE);
    const planned = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1", { files_scope: ["src/t-1/**", ".vtc/state/**"] })] as never,
    });
    expect(planned.accepted).toBe(false);
    expect(JSON.stringify(planned.rejection)).toContain(
      "T-1 files_scope names .vtc/state/**, which the engine owns",
    );
    await h.release();
  });
  it("refuses an out-of-scope fault under .vtc/, so no task is made to write there", async () => {
    const h = createHarness({ files: { ".vtc/notes.md": "x\n" } });
    const engineer = await toEngineer(h);
    h.gates.queue("fault_repro", "fail");
    const claim = await submitResult(h, engineer, {
      exit: "out_of_scope_fault",
      fault: {
        path: ".vtc/notes.md",
        line: 1,
        evidence: { type: "file_line", ref: ".vtc/notes.md:1" },
        detail: "the notes are wrong",
      },
    });
    expect(claim.accepted).toBe(false);
    expect(JSON.stringify(claim)).toContain(".vtc/notes.md is under .vtc/");
    expect([...(h.engine.states().at(-1)?.tasks.keys() ?? [])]).toEqual(["T-1"]);
    await h.release();
  });
  it("exports the engine's glob dialect", () => {
    expect(core.matchesAny(["src/**", "docs/*.md"], "src/a/b.ts")).toBe(true);
    expect(core.matchesAny(["docs/*.md"], "docs/x/y.md")).toBe(false);
    expect(core.globToRegExp("a/{b,c}/*.ts").test("a/c/x.ts")).toBe(true);
  });
});

describe("ingestUsage (§6.9, reading 67)", () => {
  it("merges an sdk_event snapshot into the stored one by window kind and stamps updated_at", async () => {
    const h = createHarness();
    await start(h);
    h.engine.ingestUsage({
      host: "claude-code",
      source: "statusline",
      windows: [
        {
          kind: "five_hour",
          label: "five_hour",
          window_minutes: 300,
          used_pct: 10,
          resets_at: null,
        },
        {
          kind: "weekly",
          label: "seven_day",
          window_minutes: 10080,
          used_pct: 40,
          resets_at: null,
        },
      ],
      model_limits: [],
      updated_at: "2026-10-13T08:59:00.000Z",
    });
    h.engine.ingestUsage({
      host: "claude-code",
      source: "sdk_event",
      windows: [
        {
          kind: "five_hour",
          label: "five_hour",
          window_minutes: 300,
          used_pct: 55,
          resets_at: "2026-10-13T12:00:00.000Z",
        },
      ],
      model_limits: [],
      updated_at: null,
    });
    const stored = h.engine.usage.get("claude-code");
    expect(stored?.source).toBe("sdk_event");
    expect(stored?.updated_at).toBe(h.clock.toISOString());
    expect(stored?.windows.map((w) => [w.kind, w.used_pct])).toEqual([
      ["five_hour", 55],
      ["weekly", 40],
    ]);
    await h.release();
  });
});

describe("role sandboxes get no network (D-ac, spine §5 reading 49)", () => {
  const profile = (secretsUnreadable: boolean | undefined, network: boolean): SandboxProfile => ({
    host: secretsUnreadable === true ? "claude-code" : "codex",
    enforced: {
      readOnly: true,
      perPathWriteDeny: true,
      network,
      ...(secretsUnreadable === undefined ? {} : { secretsUnreadable }),
    },
    settings: {},
    cliArgs: [],
  });
  it("requests network none for every role run", () => {
    for (const role of ALL_FIXTURE_ROLES) {
      const request = core.roleSandboxRequest(role, {
        cwd: "/repo/.vtc/state/worktrees/T-1",
        writablePaths: role.tools.write_paths,
        protectedPaths: [],
      });
      expect(request.network).toBe("none");
      expect(request.tools).toEqual(role.tools);
    }
  });
  it("refuses a profile that would leave a role a route to the token", () => {
    expect(core.roleSandboxProblem(profile(true, true))).toBeNull();
    expect(core.roleSandboxProblem(profile(false, true))).toBeNull();
    expect(core.roleSandboxProblem(profile(undefined, true))).toBeNull();
    // the host cannot hide the token and cannot keep the network off: no safe way to run
    expect(core.roleSandboxProblem(profile(false, false))).toMatch(/network/);
    expect(core.roleSandboxProblem(profile(undefined, false))).toMatch(/token/);
  });
});
