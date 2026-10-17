/**
 * Contracts 5.7.0 (MINOR; spine §5 readings 234–248): round 6. Reviewer routing and Low-start
 * escalation (D-cu, D-cv), default price tables (H-12), the G2 coverage loop (H-13), check-tool
 * integrity (H-14), the Codex model fallback (D-cx) and the round-5 carryover (tier replays,
 * scripted flows, the typed upstream subject, shapes on failed and rejected runs, the spool row's
 * action).
 */
import { describe, expect, it } from "vitest";
import {
  CheckToolSchema,
  CommandShapeSpoolRowSchema,
  CONTRACTS_VERSION,
  DESIGN_COVERAGE_LOOP,
  designCoverageComplete,
  designCoverageGaps,
  designCoverageRedispatch,
  DesignCoverageReportSchema,
  DesignFlowsFileSchema,
  effectivePrices,
  escalationSteps,
  GateResultSchema,
  GateSchema,
  HostErrorCauseSchema,
  ModelFallbackSchema,
  ModelRefusalRowSchema,
  priceCeiling,
  priceRun,
  PriceTableSchema,
  renderTaskPack,
  ReplayTrialRefSchema,
  ReplayTrialRowSchema,
  reviewerStartTier,
  routedByDifficulty,
  ROUTING_FACT_METRICS,
  ROUTING_REPLAY_VERDICT_CODES,
  routingReplayBacks,
  routingReplayId,
  routingReplayPath,
  RoutingReplayResultSchema,
  selectDesignFlow,
  TOOL_TAMPER_RULE_ID,
  UpstreamReportSchema,
  upstreamSubjectKey,
  UpstreamSubjectSchema,
  validateEventData,
  type DesignCoverageReport,
  type ModelPrice,
} from "../src/index.js";
import { expectInvalid, expectValid } from "./helpers.js";
import { validGateResult } from "./fixtures.js";

const SHA = "a".repeat(64);

describe("contracts 5.7.0", () => {
  it("is MINOR over 5.6.0", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });

  describe("the routing table starts the producers only (D-cu)", () => {
    it("routes the Engineer family and QA author, never a reviewer", () => {
      for (const role of ["engineer", "engineer_backend", "engineer_frontend"])
        expect(routedByDifficulty(role), role).toBe(true);
      expect(routedByDifficulty("qa", "author")).toBe(true);
      for (const [role, mode] of [
        ["qa", "judge"],
        ["spec_verifier", undefined],
        ["security", "verify"],
        ["visual_qa", undefined],
        ["lens_db", undefined],
        ["planner", undefined],
      ] as const)
        expect(routedByDifficulty(role, mode), `${role} ${String(mode)}`).toBe(false);
    });

    it("starts a reviewer on its own tier, and raises only Security verify and the cross-family reviewer on high risk", () => {
      expect(reviewerStartTier({ role: "spec_verifier", roleTier: "low", risk: "high" })).toEqual({
        tier: "low",
        reason: "role",
      });
      expect(
        reviewerStartTier({ role: "security", mode: "verify", roleTier: "mid", risk: "high" }),
      ).toEqual({ tier: "top", reason: "rule" });
      expect(
        reviewerStartTier({ role: "security", mode: "verify", roleTier: "mid", risk: "tagged" }),
      ).toEqual({ tier: "mid", reason: "role" });
      expect(
        reviewerStartTier({
          role: "qa",
          mode: "judge",
          roleTier: "mid",
          risk: "high",
          crossFamily: true,
        }),
      ).toEqual({ tier: "top", reason: "rule" });
      expect(
        reviewerStartTier({ role: "qa", mode: "judge", roleTier: "mid", risk: "high" }),
      ).toEqual({ tier: "mid", reason: "role" });
      // at most Top
      expect(
        reviewerStartTier({ role: "security", mode: "verify", roleTier: "top", risk: "high" }).tier,
      ).toBe("top");
    });
  });

  describe("a Low start escalates after every failed round (D-cv)", () => {
    it("runs Low, Mid, Top in rounds 1 to 3 within the default low-risk cap", () => {
      expect([1, 2, 3].map((r) => escalationSteps("low", r))).toEqual([0, 1, 2]);
    });
    it("keeps a Mid or Top start on one tier up after every 2 failed rounds", () => {
      expect([1, 2, 3, 4, 5].map((r) => escalationSteps("mid", r))).toEqual([0, 0, 1, 1, 2]);
      expect([1, 2, 3].map((r) => escalationSteps("top", r))).toEqual([0, 0, 1]);
    });
  });

  describe("default price tables (H-12)", () => {
    const sol: ModelPrice = {
      input_per_mtok: 2,
      cached_input_per_mtok: 0.2,
      output_per_mtok: 10,
      cache_write_per_mtok: 0,
    };
    const astra: ModelPrice = {
      input_per_mtok: 5,
      cached_input_per_mtok: 0.5,
      output_per_mtok: 20,
      cache_write_per_mtok: 0,
    };
    const table = expectValid(PriceTableSchema, {
      v: 1,
      source_url: "https://openai.com/api/pricing/",
      as_of: "2026-10-15",
      prices: { "gpt-6.1-sol": sol, "gpt-6-astra": astra },
    });

    it("records its source and date, https only", () => {
      expectInvalid(PriceTableSchema, { ...table, source_url: "http://x.test/" }, "source_url");
      expectInvalid(PriceTableSchema, { ...table, as_of: "15 Oct" }, "as_of");
    });

    it("lets the user override a model, never requires it", () => {
      expect(effectivePrices(table, undefined)["gpt-6.1-sol"]).toEqual(sol);
      expect(effectivePrices(table, { "gpt-6.1-sol": astra })["gpt-6.1-sol"]).toEqual(astra);
      expect(effectivePrices(undefined, undefined)).toEqual({});
    });

    it("prices a listed model, and counts an unknown one at the ceiling without blocking", () => {
      const tokens = { in: 1_000_000, out: 1_000_000, cache_r: 0, cache_w: 0 };
      expect(priceRun(tokens, "gpt-6.1-sol", table.prices)).toEqual({
        cost_usd: 12,
        budget_usd: 12,
        basis: "listed",
      });
      expect(priceRun(tokens, "gpt-7-unknown", table.prices)).toEqual({
        cost_usd: null,
        budget_usd: 25,
        basis: "ceiling",
      });
      expect(priceRun(tokens, null, {})).toEqual({
        cost_usd: null,
        budget_usd: null,
        basis: "none",
      });
      expect(priceCeiling([sol, { ...astra, cached_input_per_mtok: 0.1 }])).toEqual({
        ...astra,
        cached_input_per_mtok: 0.2,
      });
    });

    it("carries the budget count on role.submitted", () => {
      const parsed = validateEventData("role.submitted", {
        action_id: "a-1",
        exit: "done",
        findings: 0,
        questions: 0,
        session_ref: null,
        budget_usd: 0.42,
      });
      expect(parsed.ok).toBe(true);
    });
  });

  describe("the G2 coverage loop (H-13)", () => {
    const report = (over: Partial<DesignCoverageReport>): DesignCoverageReport =>
      DesignCoverageReportSchema.parse({
        reqs_without_component: [],
        reqs_without_screen: [],
        screens_without_req: [],
        components_unregistered: [],
        ok: Object.keys(over).length === 0,
        ...over,
      });

    it("caps the loop at 3 fix rounds", () => {
      expect(DESIGN_COVERAGE_LOOP.maxRounds).toBe(3);
    });

    it("routes architecture gaps to the Architect and screen gaps to the Designer", () => {
      expect(designCoverageRedispatch(report({ reqs_without_component: ["REQ-1"] }))).toEqual([
        "architect",
      ]);
      expect(designCoverageRedispatch(report({ reqs_without_screen: ["REQ-2"] }))).toEqual([
        "designer",
      ]);
      expect(
        designCoverageRedispatch(
          report({ reqs_without_component: ["REQ-1"], components_unregistered: ["card"] }),
        ),
      ).toEqual(["architect", "designer"]);
      expect(designCoverageRedispatch(report({}))).toEqual([]);
    });

    it("leaves the directions problem out of coverage", () => {
      expect(designCoverageComplete(report({ directions_problem: "one direction" }))).toBe(true);
      expect(designCoverageComplete(report({ screens_problem: "missing" }))).toBe(false);
    });

    it("prints the gaps as Dispatch lines of the re-dispatch", () => {
      const gaps = designCoverageGaps(
        report({ reqs_without_component: ["REQ-1", "REQ-4"], reqs_without_screen: ["REQ-2"] }),
        2,
      );
      const text = renderTaskPack({
        v: 1,
        run: "r-1",
        action_id: "a-9",
        role: "architect",
        coverage_gaps: gaps,
      });
      expect(text).toContain("- coverage round: 2 of 3");
      expect(text).toContain("- requirements no AD or component names: REQ-1, REQ-4");
      expect(text).toContain("- UI requirements with no screen: REQ-2");
      expect(text).not.toContain("screens with no requirement");
    });

    it("logs each check as design.coverage_checked", () => {
      const parked = validateEventData("design.coverage_checked", {
        check: 4,
        max_rounds: 3,
        report: report({ reqs_without_component: ["REQ-1"] }),
        outcome: "parked",
        park_reason: "cap",
        escalation: "E-3",
      });
      expect(parked.ok).toBe(true);
      const fixingWithoutRoles = validateEventData("design.coverage_checked", {
        check: 1,
        max_rounds: 3,
        report: report({ reqs_without_component: ["REQ-1"] }),
        outcome: "fixing",
      });
      expect(fixingWithoutRoles.ok).toBe(false);
    });
  });

  describe("check-tool integrity (H-14)", () => {
    it("names a pinned or a project tool on a gate", () => {
      expectValid(CheckToolSchema, { source: "pinned", pin: "ruff" });
      expectValid(CheckToolSchema, {
        source: "project",
        paths: ["node_modules/eslint/**", "node_modules/.bin/eslint"],
      });
      expectInvalid(CheckToolSchema, { source: "project", paths: [] }, "paths");
      expectValid(GateSchema, {
        id: "lint",
        layer: "L1",
        command: ["eslint", "."],
        tool: { source: "pinned", pin: "biome" },
      });
    });

    it("fails a gate whose tool the install phase changed, as a product failure", () => {
      const tampered = { source: "project", sha256: SHA, tampered: ["node_modules/eslint/bin.js"] };
      expectValid(GateResultSchema, { ...validGateResult(), tool: tampered });
      expectInvalid(
        GateResultSchema,
        {
          ...validGateResult(),
          status: "pass",
          new_violations: 0,
          failure_class: undefined,
          tool: tampered,
        },
        "tool.tampered",
      );
      expect(TOOL_TAMPER_RULE_ID).toBe("vtc/tool-tampered");
    });
  });

  describe("the Codex model fallback (D-cx)", () => {
    it("names a refused model as an error cause and records the fallback on the retry", () => {
      expect(HostErrorCauseSchema.options).toContain("model_refused");
      expectValid(ModelFallbackSchema, {
        requested: "gpt-6-astra",
        reason: "model_refused",
        detail: "model not available on your plan",
      });
      const dispatched = validateEventData("role.dispatched", {
        action_id: "a-2",
        dispatch: "headless",
        agent: "vtc-engineer",
        pack: ".vtc/state/packs/a-2.md",
        resume: null,
        model_fallback: { requested: "gpt-6-astra", reason: "model_refused" },
      });
      expect(dispatched.ok).toBe(true);
    });

    it("keeps refusals for vtc doctor", () => {
      expectValid(ModelRefusalRowSchema, {
        v: 1,
        at: "2026-10-15T10:00:00Z",
        host: "codex",
        model: "gpt-6-astra",
      });
      expectInvalid(
        ModelRefusalRowSchema,
        { v: 1, at: "2026-10-15T10:00:00Z", host: "codex", model: "a b" },
        "model",
      );
    });
  });

  describe("tier replays (D-cn)", () => {
    it("names a tier replay and its result path", () => {
      const id = routingReplayId("engineer_backend", "S", "none", "mid", "low");
      expect(id).toBe("routing-engineer_backend-s-none-mid-low");
      expect(routingReplayPath(id)).toBe(
        ".vtc/lookback/replays/routing/routing-engineer_backend-s-none-mid-low.json",
      );
    });

    it("carries the arm's tier on the trial ref and the ledger rows", () => {
      expectValid(ReplayTrialRefSchema, {
        proposal: "routing-engineer-s-none-mid-low",
        task: "r-1:T-3",
        arm: "b",
        trial: 1,
        tier: "low",
      });
      expectValid(ReplayTrialRowSchema, {
        v: 1,
        repo_key: "a".repeat(16),
        proposal: "routing-engineer-s-none-mid-low",
        baseline: SHA,
        candidate: SHA,
        task: "r-1:T-3",
        arm: "a",
        trial: 1,
        grader_bundle_sha: SHA,
        tier: "mid",
        passed: true,
        tokens: 1200,
        read_denied: false,
        graded_at: "2026-10-15T10:00:00Z",
      });
    });

    it("grades a tier replay and says which changes it backs", () => {
      expectValid(RoutingReplayResultSchema, {
        v: 1,
        id: "routing-engineer-s-none-mid-low",
        subject: "routing.engineer.S.none",
        role: "engineer",
        host: "claude-code",
        prompt: SHA,
        tiers: { a: "mid", b: "low" },
        grader_bundle_sha: SHA,
        grader: "gates",
        k: 3,
        per_task: [
          { task: "r-1:T-3", a: [true, true, true], b: [true, true, false], regression_set: true },
        ],
        sign_test: { n_discordant: 1, wins_b: 0, p: 0.5 },
        tokens_delta_pct: -40,
        cost_delta_pct: null,
        verdict: "no_change",
        isolation: "paths_only",
        finished_at: "2026-10-15T10:00:00Z",
      });
      expect(routingReplayBacks("cheaper", "no_change")).toBe(true);
      expect(routingReplayBacks("cheaper", "regress")).toBe(false);
      expect(routingReplayBacks("higher", "no_change")).toBe(false);
      expect(routingReplayBacks("higher", "improve")).toBe(true);
      expect(routingReplayBacks("cheaper", "inconclusive")).toBe(false);
    });

    it("names the replay's verdict and trials among the routing fact's metrics", () => {
      expect(ROUTING_FACT_METRICS).toEqual({
        fromTier: "routing.from_tier",
        toTier: "routing.to_tier",
        currentTier: "routing.current_tier",
        shared: "routing.shared",
        replayPlanned: "routing.replay_planned",
        lifted: "routing.lifted",
        liftedPrefix: "routing.lifted.",
        replayVerdict: "routing.replay_verdict",
        replayTrials: "routing.replay_trials",
      });
      expect(ROUTING_REPLAY_VERDICT_CODES).toEqual({
        regress: -1,
        no_change: 0,
        improve: 1,
        inconclusive: 2,
      });
    });
  });

  describe("scripted flows (D-ct)", () => {
    const file = expectValid(DesignFlowsFileSchema, {
      fixtures: { email: "ada@example.test" },
      flows: [
        {
          id: "reset-password",
          start: "/login",
          screens: ["login"],
          paths: ["apps/web/src/auth/**"],
          steps: [
            { action: "click", selector: "text=Forgot password" },
            { action: "fill", selector: "#email", fixture: "email" },
            { action: "press", key: "Enter" },
            { action: "wait_for", selector: "role=status" },
          ],
        },
        {
          id: "settings",
          start: "/settings",
          screens: ["settings"],
          steps: [{ action: "wait", ms: 500 }],
        },
      ],
    });
    const glob = (g: string, p: string): boolean =>
      g.endsWith("/**") ? p.startsWith(g.slice(0, -2)) : g === p;

    it("refuses an unknown fixture, inline script and unbounded flows", () => {
      expectInvalid(
        DesignFlowsFileSchema,
        { flows: [{ ...file.flows[0], id: "x" }] },
        "flows.0.steps.1.fixture",
      );
      expectInvalid(DesignFlowsFileSchema, {
        flows: [{ id: "x", start: "/", paths: ["a"], steps: [{ action: "eval", code: "1" }] }],
      });
      expectInvalid(DesignFlowsFileSchema, {
        flows: [{ id: "x", start: "/", paths: ["a"], steps: [{ action: "wait", ms: 60_000 }] }],
      });
      expectInvalid(DesignFlowsFileSchema, {
        flows: [{ id: "x", start: "/", steps: [{ action: "wait", ms: 10 }] }],
      });
    });

    it("selects the flow by changed path first, then by touched screen", () => {
      expect(
        selectDesignFlow(file, { changedPaths: ["apps/web/src/auth/reset.ts"] }, glob)?.id,
      ).toBe("reset-password");
      expect(
        selectDesignFlow(file, { changedPaths: ["README.md"], screens: ["settings"] }, glob)?.id,
      ).toBe("settings");
      expect(selectDesignFlow(file, { changedPaths: ["README.md"] }, glob)).toBeUndefined();
    });
  });

  describe("the typed upstream subject (D-cs, D-cn, D-by)", () => {
    it("allows only VTC's vocabulary", () => {
      const routing = expectValid(UpstreamSubjectSchema, {
        kind: "routing",
        role: "spec_verifier",
        size: "M",
        risk: "tagged",
      });
      expect(upstreamSubjectKey(routing)).toBe("routing.spec_verifier.M.tagged");
      expect(upstreamSubjectKey({ kind: "config", key: "caps.fix_rounds" })).toBe(
        "caps.fix_rounds",
      );
      expect(upstreamSubjectKey({ kind: "capability", slug: "browser_automation" })).toBe(
        "browser_automation",
      );
      expectInvalid(UpstreamSubjectSchema, { kind: "config", key: "client.name" }, "key");
      expectInvalid(UpstreamSubjectSchema, {
        kind: "tool",
        shape: { program: "make", subcommand: "deploy acme", flags: "0".repeat(12) },
      });
    });

    it("rides on the upstream report", () => {
      expectValid(UpstreamReportSchema, {
        v: 1,
        kind: "capability",
        fingerprint: "0123abcd4567ef89",
        vtc_version: "0.1.0",
        subject: { kind: "capability", slug: "db_migration_runner" },
        occurrences: 2,
        first_seen: "2026-10-15T10:00:00Z",
        last_seen: "2026-10-15T11:00:00Z",
      });
    });
  });

  describe("shapes of failed and rejected runs, the spool row's action (D-cs)", () => {
    const shapes = [{ program: "pnpm", subcommand: "test", flags: "0".repeat(12), count: 2 }];

    it("carries command_shapes on role.failed and role.rejected", () => {
      expect(
        validateEventData("role.failed", {
          action_id: "a-3",
          kind: "error",
          message: "boom",
          retryable: false,
          command_shapes: shapes,
        }).ok,
      ).toBe(true);
      expect(
        validateEventData("role.rejected", {
          action_id: "a-3",
          reason: "schema",
          command_shapes: shapes,
        }).ok,
      ).toBe(true);
    });

    it("names the dispatch on a spool row when the hook can tell it", () => {
      expectValid(CommandShapeSpoolRowSchema, {
        v: 1,
        at: "2026-10-15T10:00:00Z",
        agent: "vtc:vtc-spec-verifier",
        cwd: "/tmp/wt",
        shape: { program: "git", subcommand: "status", flags: "0".repeat(12) },
        action: "a-12",
      });
    });
  });
});
