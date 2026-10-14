/**
 * The daemon's bridge to the upstream module (AD-27 rule 8; spine §5 readings 189, 190 and 196):
 * engine facts in the module's vocabulary, the project context it checks them against, its events
 * through the wiring's sink, the Lookback PR input from the stored candidate version, and its
 * sweep at most once a day across daemon restarts. The module is a fake with the module's shape.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  automationFor,
  type AssetBundle,
  type AutomationContext,
  type AutomationDeps,
  type CreateGitPlumbing,
  type PromptProposal,
  type ReplayResult,
} from "@vtc/shared";
import type { AutomationFact, EventDraft, UpstreamWiringDeps } from "../../src/core/index.js";
import {
  bridgeUpstream,
  githubRepoOf,
  readLookbackPrInput,
  upstreamModuleFact,
  UPSTREAM_SWEEP_EVERY_MS,
  type CreateUpstreamModule,
  type LookbackPrInput,
  type UpstreamModuleContext,
  type UpstreamModuleDeps,
  type UpstreamModuleFact,
  type UpstreamModuleOutcome,
} from "../../src/daemon/upstream-bridge.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";

afterEach(cleanupDirs);

const SAMPLE = new URL(
  "../../../../fixtures/golden-run/samples/replay-p-engineer-1.json",
  import.meta.url,
);
const REPLAY: ReplayResult = {
  ...(JSON.parse(readFileSync(SAMPLE, "utf8")) as ReplayResult),
  verdict: "improve",
};

const PROPOSAL: PromptProposal = {
  v: 1,
  id: "p-engineer-1",
  base: {
    role: "engineer",
    host: "codex",
    locked_sha256: "1".repeat(64),
    editable_sha256: "2".repeat(64),
    effective_sha256: REPLAY.baseline,
  },
  changes: [
    {
      hypothesis: "Naming the failing test first shortens the fix loop",
      target_metric: "first_round_gate_pass",
      trace_ids: ["golden-1-t-1-engineer-1"],
      summary: "run the failing test before editing",
    },
  ],
  editable: "a later RETRO's text",
  created_at: "2026-10-14T10:00:00.000Z",
};

const fact = (over: Partial<AutomationFact>): AutomationFact => ({
  target: "upstream",
  kind: "defect",
  run: "r1",
  source: "incident.recorded",
  at: "2026-10-14T10:00:00.000Z",
  detail: "x",
  ...over,
});

describe("engine facts in the module's vocabulary", () => {
  it("maps VTC defects, cost regressions and project problems; a Lookback fact is a PR", () => {
    expect(
      upstreamModuleFact(
        fact({ errorClass: "incident.gate_infra", role: "qa", host: "codex", promptSha: "a" }),
      ),
    ).toEqual({
      type: "vtc_defect",
      errorClass: "incident.gate_infra",
      role: "qa",
      mode: undefined,
      host: "codex",
      model: undefined,
      promptSha: "a",
      at: "2026-10-14T10:00:00.000Z",
    });
    expect(
      upstreamModuleFact(
        fact({
          kind: "cost",
          role: "engineer",
          host: "claude-code",
          metric: "tokens_per_success",
          baselinePromptSha: "b".repeat(64),
          promptSha: "c".repeat(64),
          baseline: 10,
          current: 20,
        }),
      ),
    ).toMatchObject({
      type: "cost_regression",
      role: "engineer",
      metric: "tokens_per_success",
      baseline: 10,
      current: 20,
    });
    expect(
      upstreamModuleFact(
        fact({
          target: "project",
          kind: "finding",
          ruleId: "finding/abc",
          path: "src/a.ts",
          title: "security finding: x",
          detail: "details",
        }),
      ),
    ).toEqual({
      type: "project_problem",
      kind: "finding",
      ruleId: "finding/abc",
      path: "src/a.ts",
      title: "security finding: x",
      detail: "details",
      run: "r1",
      at: "2026-10-14T10:00:00.000Z",
    });
    expect(upstreamModuleFact(fact({ kind: "lookback", proposal: "p-1" }))).toBeNull();
    // a project fact without a stable identity raises nothing
    expect(upstreamModuleFact(fact({ target: "project", kind: "parked" }))).toBeNull();
  });

  it("reads owner/name from a GitHub remote", () => {
    expect(githubRepoOf("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepoOf("git@github.com:acme/app.git")).toBe("acme/app");
    expect(githubRepoOf("ssh://git@github.com/acme/my.app")).toBe("acme/my.app");
    expect(githubRepoOf("https://gitlab.com/acme/app.git")).toBeNull();
    expect(githubRepoOf("https://github.com/acme/.hidden.git")).toBeNull();
    expect(githubRepoOf(null)).toBeNull();
  });
});

describe("the Lookback PR input (D-cb)", () => {
  const setup = () => {
    const root = tempDir("vtc-bridge-");
    mkdirSync(join(root, ".vtc/lookback/replays"), { recursive: true });
    writeFileSync(join(root, ".vtc/lookback/replays/p-engineer-1.json"), JSON.stringify(REPLAY));
    return root;
  };
  const read = (root: string, over: Partial<Parameters<typeof readLookbackPrInput>[0]> = {}) =>
    readLookbackPrInput({
      projectRoot: root,
      proposal: "p-engineer-1",
      replayPath: ".vtc/lookback/replays/p-engineer-1.json",
      readProposal: () => Promise.resolve(PROPOSAL),
      candidateEditable: (replay) =>
        Promise.resolve(
          replay.candidate === REPLAY.candidate ? "the replayed candidate text" : undefined,
        ),
      ...over,
    });

  it("is the replay and its proposal, carrying the stored candidate the replay measured", async () => {
    const input = (await read(setup())) as LookbackPrInput;
    expect(input.replay).toEqual(REPLAY);
    expect(input.proposal).toEqual({ ...PROPOSAL, editable: "the replayed candidate text" });
  });

  it("says why there is none", async () => {
    const root = setup();
    expect(await read(root, { replayPath: "elsewhere/p.json" })).toMatch(/not under/);
    expect(await read(root, { replayPath: ".vtc/lookback/replays/../x.json" })).toMatch(
      /not under/,
    );
    expect(await read(root, { replayPath: ".vtc/lookback/replays/none.json" })).toMatch(
      /missing or not JSON/,
    );
    expect(await read(root, { proposal: "p-other" })).toMatch(/is for p-engineer-1/);
    expect(
      await read(root, { readProposal: () => Promise.resolve({ ...PROPOSAL, id: "p-later" }) }),
    ).toMatch(/no longer in its proposal file/);
    expect(await read(root, { candidateEditable: () => Promise.resolve(undefined) })).toMatch(
      /is not stored/,
    );
    writeFileSync(
      join(root, ".vtc/lookback/replays/p-engineer-1.json"),
      JSON.stringify({ ...REPLAY, verdict: "no_change" }),
    );
    expect(await read(root)).toMatch(/says no_change/);
    // a link is never followed
    const outside = join(tempDir("vtc-outside-"), "r.json");
    writeFileSync(outside, JSON.stringify(REPLAY));
    symlinkSync(outside, join(root, ".vtc/lookback/replays/p-link.json"));
    expect(await read(root, { replayPath: ".vtc/lookback/replays/p-link.json" })).toMatch(
      /not a regular file/,
    );
    // nor a linked parent directory
    const linked = tempDir("vtc-bridge-");
    mkdirSync(join(linked, ".vtc"), { recursive: true });
    symlinkSync(join(root, ".vtc/lookback"), join(linked, ".vtc/lookback"));
    expect(await read(linked, { replayPath: ".vtc/lookback/replays/p-engineer-1.json" })).toMatch(
      /not a regular file/,
    );
  });
});

describe("bridgeUpstream", () => {
  const CONTEXT: AutomationContext = { githubRemote: true, ghLoggedIn: true, paused: false };
  const AUTOMATION: AutomationDeps = {
    upstream: { repo: "bason-labs/bs-vtc", share: true },
    hosting: "branch",
    ffmpeg: false,
  };
  const plumbing: CreateGitPlumbing = () => {
    throw new Error("unused");
  };

  const fakeModule = (answer: UpstreamModuleOutcome = { status: "ignored" }) => {
    const calls: { what: string; arg: unknown; ctx: UpstreamModuleContext }[] = [];
    let built: UpstreamModuleDeps | undefined;
    const create: CreateUpstreamModule = (deps) => {
      built = deps;
      return {
        report: (f: UpstreamModuleFact, ctx) => {
          calls.push({ what: "report", arg: f, ctx });
          return Promise.resolve(answer);
        },
        openLookbackPr: (input, ctx) => {
          calls.push({ what: "lookback", arg: input, ctx });
          return Promise.resolve(answer);
        },
        sweep: (ctx) => {
          calls.push({ what: "sweep", arg: null, ctx });
          return Promise.resolve([answer]);
        },
      };
    };
    return {
      calls,
      create,
      built: () => {
        if (built === undefined) throw new Error("not built");
        return built;
      },
    };
  };

  const build = (
    module: ReturnType<typeof fakeModule>,
    options: { guard: string; clock: { now: Date }; lookbackPr?: LookbackPrInput | string },
  ) => {
    const emitted: EventDraft[] = [];
    const started: unknown[] = [];
    const deps: UpstreamWiringDeps = {
      projectRoot: "/work/acme-app",
      vtcHome: "/home/u/.vtc",
      automation: AUTOMATION,
      settings: () =>
        automationFor({}, { upstream: { repo: "bason-labs/bs-vtc", share: true } }, CONTEXT),
      context: () => CONTEXT,
      emit: (draft) => {
        emitted.push(draft);
      },
      startRun: (input, issue) => {
        started.push([input.request, issue.issue]);
        return Promise.resolve();
      },
      now: () => options.clock.now,
    };
    const wiring = bridgeUpstream(module.create, {
      guardDir: options.guard,
      vtcVersion: "0.4.0",
      assets: {} as AssetBundle,
      remoteUrl: "git@github.com:acme/app.git",
      clientNames: () => ["acme-client"],
      knownValues: () => ["s3cr3t-value"],
      redactSelectors: () => [".card-number"],
      lookbackPr: () => Promise.resolve(options.lookbackPr ?? "no replay"),
      plumbing,
    })(deps);
    return { wiring, emitted, started };
  };

  it("builds the module with the cli's seams and engine git's plumbing, and records its events", async () => {
    const module = fakeModule();
    const guard = tempDir("vtc-guard-");
    const { emitted, started } = build(module, { guard, clock: { now: new Date() } });
    const deps = module.built();
    expect(deps).toMatchObject({ vtcHome: "/home/u/.vtc", guardDir: guard, vtcVersion: "0.4.0" });
    expect(deps.automation.plumbing).toBe(plumbing);
    expect(deps.automation.upstream.repo).toBe("bason-labs/bs-vtc");
    const payload = { reason: "rate_limit", detail: "5 issues today" };
    deps.emit({ type: "automation.skipped", payload });
    expect(emitted).toEqual([{ type: "automation.skipped", actor: "engine", data: payload }]);
    // the module gets the engine's way to start an automatic run from an issue (D-bv)
    await deps.startRun?.(
      { request: "Fix #42", track: "feature", repo: "existing", has_ui: false, risk_hints: [] },
      {
        kind: "ci_failure",
        fingerprint: "0123456789abcdef",
        target: { kind: "project", repo: "acme/app" },
        issue: 42,
      },
    );
    expect(started).toEqual([["Fix #42", 42]]);
  });

  it("reports a fact with the project's context; an error outcome fails the fact", async () => {
    const module = fakeModule();
    const { wiring } = build(module, { guard: tempDir("vtc-guard-"), clock: { now: new Date() } });
    await wiring.onFact(fact({ errorClass: "incident.crash" }));
    const [call] = module.calls;
    expect(call?.what).toBe("report");
    expect(call?.arg).toMatchObject({ type: "vtc_defect", errorClass: "incident.crash" });
    expect(call?.ctx).toMatchObject({
      repoRoot: "/work/acme-app",
      repo: "acme/app",
      identity: {
        repo: "acme/app",
        remoteUrl: "git@github.com:acme/app.git",
        repoRoot: "/work/acme-app",
        clientNames: ["acme-client"],
      },
      knownValues: ["s3cr3t-value"],
      redactSelectors: [".card-number"],
    });
    expect(call?.ctx.state().context).toEqual(CONTEXT);
    expect(call?.ctx.state().settings.upstreamRepo).toBe("bason-labs/bs-vtc");

    const failing = fakeModule({ status: "error", detail: "gh exploded" });
    const broken = build(failing, { guard: tempDir("vtc-guard-"), clock: { now: new Date() } });
    await expect(broken.wiring.onFact(fact({ errorClass: "incident.crash" }))).rejects.toThrow(
      /gh exploded/,
    );
  });

  it("a replay verdict improve opens the Lookback PR from its input, or fails with the reason", async () => {
    const module = fakeModule({ status: "pr" });
    const input: LookbackPrInput = { replay: REPLAY, proposal: PROPOSAL };
    const { wiring } = build(module, {
      guard: tempDir("vtc-guard-"),
      clock: { now: new Date() },
      lookbackPr: input,
    });
    await wiring.onFact(fact({ kind: "lookback", proposal: "p-engineer-1" }));
    expect(module.calls.map((c) => [c.what, c.arg])).toEqual([["lookback", input]]);

    const none = build(fakeModule(), {
      guard: tempDir("vtc-guard-"),
      clock: { now: new Date() },
      lookbackPr: "the candidate is not stored",
    });
    await expect(
      none.wiring.onFact(fact({ kind: "lookback", proposal: "p-engineer-1" })),
    ).rejects.toThrow(/no Lookback PR: the candidate is not stored/);
  });

  it("sweeps at most once a day, remembered across restarts", async () => {
    const guard = tempDir("vtc-guard-");
    const clock = { now: new Date("2026-10-14T10:00:00.000Z") };
    const module = fakeModule();
    const first = build(module, { guard, clock });
    await first.wiring.sweep?.();
    await first.wiring.sweep?.();
    expect(module.calls.filter((c) => c.what === "sweep")).toHaveLength(1);
    // a restarted daemon on the same guard dir keeps the clock
    const restarted = build(module, { guard, clock });
    clock.now = new Date(clock.now.getTime() + UPSTREAM_SWEEP_EVERY_MS - 1);
    await restarted.wiring.sweep?.();
    expect(module.calls.filter((c) => c.what === "sweep")).toHaveLength(1);
    clock.now = new Date(clock.now.getTime() + 1);
    await restarted.wiring.sweep?.();
    expect(module.calls.filter((c) => c.what === "sweep")).toHaveLength(2);
  });

  it("a sweep that failed is tried again at the next tick, not a day later", async () => {
    const guard = tempDir("vtc-guard-");
    const clock = { now: new Date("2026-10-14T10:00:00.000Z") };
    const failing = fakeModule({ status: "error", detail: "gh exploded" });
    const first = build(failing, { guard, clock });
    await expect(first.wiring.sweep?.()).rejects.toThrow(/gh exploded/);
    clock.now = new Date(clock.now.getTime() + 60_000);
    const working = fakeModule();
    const second = build(working, { guard, clock });
    await second.wiring.sweep?.();
    expect(working.calls.filter((c) => c.what === "sweep")).toHaveLength(1);
    // now the clock is set: the next try waits a day
    await second.wiring.sweep?.();
    expect(working.calls.filter((c) => c.what === "sweep")).toHaveLength(1);
  });
});
