/**
 * Contracts 5.4.0 (MINOR; spine §5 readings 217–227): round 5. Difficulty-based model routing
 * (H-9, D-cm), Lookback routing scorecards and replay pace (D-cn, D-cq, D-cr), the tool and
 * capability signals (D-cs), UI before/after evidence (D-ct), and the followups of readings 211
 * and 212.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AutomationSkipReasonSchema,
  CAPABILITY_SIGNAL_MIN,
  clampTier,
  COMMAND_SHAPE_OTHER,
  COMMAND_SHAPE_PATH,
  commandShapeKey,
  commandShapes,
  CommandShapeSpoolRowSchema,
  CONTRACTS_VERSION,
  ControlResultSchema,
  countCommandShapes,
  DEFAULT_ROUTING_TABLE,
  ENGINE_MCP_TOOLS,
  EscalationAnswerSchema,
  escalationFromQuestion,
  EvidenceManifestSchema,
  EVIDENCE_HOSTING_DEFAULT,
  EVIDENCE_HOSTING_PREFERRED,
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  lookbackPaceFor,
  ProjectConfigSchema,
  QA_AUTHOR_MIN_TIER,
  QuestionSchema,
  RoleRunSummarySchema,
  routingConfigSubject,
  routingFor,
  RoutingScorecardSchema,
  routedStartTier,
  RoutingTableSchema,
  sha256Hex,
  TaskDraftSchema,
  taskRiskClass,
  TIER_EFFORT_WITHOUT_MODEL,
  TOOL_SIGNAL_MIN_TASKS,
  touchesUi,
  UPSTREAM_EVENT_PAYLOAD_SCHEMAS,
  UserConfigSchema,
  validateEventData,
  type EvidenceRecorder,
  type GitPlumbing,
  type ParsedStream,
} from "../src/index.js";
import { DCM_TABLE, NOW, SHA, validTaskDraft } from "./fixtures.js";

describe("contracts 5.4.0", () => {
  it("is MINOR over 5.3.0", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });

  describe("difficulty routing (H-9, D-cm)", () => {
    it("starts S Low, M or a tagged task Mid, L or a high-risk task Top", () => {
      // D-cm's table as decided (reading 218(2)). `DEFAULT_ROUTING_TABLE` started equal to it and
      // its tiers move only through a reviewed D-cn routing PR, which changes that one file
      // (reading 233): its tier values are not pinned here, or no such PR could pass.
      expect(RoutingTableSchema.parse(DCM_TABLE)).toEqual(DCM_TABLE);
      expect(routedStartTier(DCM_TABLE, "engineer", "S", "none")).toBe("low");
      expect(routedStartTier(DCM_TABLE, "engineer", "S", "tagged")).toBe("mid");
      expect(routedStartTier(DCM_TABLE, "engineer", "M", "none")).toBe("mid");
      expect(routedStartTier(DCM_TABLE, "engineer", "L", "none")).toBe("top");
      expect(routedStartTier(DCM_TABLE, "engineer", "S", "high")).toBe("top");
      // a routing PR moves tiers only: the tags and the shape stay
      expect([...DEFAULT_ROUTING_TABLE.high_risk_tags].sort()).toEqual(
        ["auth", "data", "migration", "payments", "security"].sort(),
      );
      expect(RoutingTableSchema.safeParse(DEFAULT_ROUTING_TABLE).success).toBe(true);
      // a reviewed Lookback PR may give one role its own cells (D-cn)
      expect(
        RoutingTableSchema.safeParse({
          ...DEFAULT_ROUTING_TABLE,
          roles: { spec_verifier: { by_size: { M: "low" } } },
        }).success,
      ).toBe(true);
      expect(
        RoutingTableSchema.safeParse({
          ...DEFAULT_ROUTING_TABLE,
          roles: { spec_verifier: { by_size: { XL: "low" } } },
        }).success,
      ).toBe(false);
    });

    it("classifies a task's risk from its tags; risk high counts as a high-risk tag", () => {
      expect(taskRiskClass({ risk: "low", risk_tags: [] })).toBe("none");
      expect(taskRiskClass({ risk: "med", risk_tags: [] })).toBe("none");
      expect(taskRiskClass({ risk: "low", risk_tags: ["perf"] })).toBe("tagged");
      expect(taskRiskClass({ risk: "low", risk_tags: ["perf", "payments"] })).toBe("high");
      expect(taskRiskClass({ risk: "high", risk_tags: [] })).toBe("high");
    });

    it("clamps a tier into a range, and keeps QA author off Low", () => {
      expect(clampTier("low", "mid", "top")).toBe("mid");
      expect(clampTier("top", "low", "mid")).toBe("mid");
      expect(clampTier("mid")).toBe("mid");
      expect(clampTier("top", "mid", "low")).toBe("mid");
      expect(QA_AUTHOR_MIN_TIER).toBe("mid");
    });

    it("lets the Planner name a reason-coded tier hint, kept on the task", () => {
      const draft = {
        ...validTaskDraft(),
        tier_hint: { tier: "top", reason: "concurrency", detail: "Two writers race." },
      };
      expect(TaskDraftSchema.safeParse(draft).success).toBe(true);
      expect(
        TaskDraftSchema.safeParse({ ...draft, tier_hint: { tier: "top", reason: "because" } })
          .success,
      ).toBe(false);
      expect(TaskDraftSchema.safeParse(validTaskDraft()).success).toBe(true);
    });

    it("reads project.yaml routing with defaults and refuses min above max", () => {
      expect(routingFor(ProjectConfigSchema.parse({ version: 1 }))).toEqual({
        start: "difficulty",
        min: "low",
        max: "top",
      });
      const set = ProjectConfigSchema.parse({
        version: 1,
        routing: { start: "role", min_tier: "mid", max_tier: "mid" },
      });
      expect(routingFor(set)).toEqual({ start: "role", min: "mid", max: "mid" });
      expect(
        ProjectConfigSchema.safeParse({
          version: 1,
          routing: { min_tier: "top", max_tier: "low" },
        }).success,
      ).toBe(false);
    });

    it("records the tier and why on role.dispatched, both or neither", () => {
      const base = {
        action_id: "a-1",
        dispatch: "subagent",
        agent: "vtc-engineer",
        pack: ".vtc/packs/a-1.md",
        resume: null,
      };
      expect(validateEventData("role.dispatched", base).ok).toBe(true);
      expect(
        validateEventData("role.dispatched", { ...base, tier: "low", tier_reason: "rule" }).ok,
      ).toBe(true);
      expect(
        validateEventData("role.dispatched", {
          ...base,
          tier: "mid",
          tier_reason: "planner_hint",
          tier_clamped: true,
        }).ok,
      ).toBe(true);
      expect(validateEventData("role.dispatched", { ...base, tier: "low" }).ok).toBe(false);
      expect(validateEventData("role.dispatched", { ...base, tier_reason: "rule" }).ok).toBe(false);
      expect(validateEventData("role.dispatched", { ...base, tier_clamped: true }).ok).toBe(false);
      expect(
        validateEventData("role.dispatched", { ...base, tier: "top", tier_reason: "vibes" }).ok,
      ).toBe(false);
    });

    it("shows the tier on the task view's role runs", () => {
      const run = {
        action_id: "a-1",
        role: "engineer",
        prompt_sha: SHA,
        host: "claude-code",
        model: "sonnet",
        dispatched_at: NOW,
        exit: null,
        tier: "mid",
        tier_reason: "escalation",
      };
      expect(RoleRunSummarySchema.safeParse(run).success).toBe(true);
    });

    it("varies Codex effort by tier until its model ids are filled (D-co)", () => {
      expect(TIER_EFFORT_WITHOUT_MODEL).toEqual({ low: "low", mid: "medium", top: "high" });
    });
  });

  describe("Lookback routing and pace (D-cn, D-cq, D-cr)", () => {
    it("names one routing cell the same way everywhere", () => {
      expect(routingConfigSubject("engineer", "S", "none")).toBe("routing.engineer.S.none");
      expect(() => routingConfigSubject("engineer", "S", "risky" as never)).toThrow();
    });

    it("writes a routing scorecard per (role, size, risk, start tier)", () => {
      const metric = { value: 0.8, ci_low: 0.6, ci_high: 0.9, n: 12 };
      const card = {
        v: 1,
        grader_bundle_sha: SHA,
        window: { from: NOW, to: NOW },
        cells: [
          {
            role: "engineer",
            host: "claude-code",
            size: "S",
            risk: "none",
            start_tier: "low",
            start_reason: "rule",
            tasks: 12,
            metrics: { first_round_gate_pass: metric },
            escalated: { value: 0.1, ci_low: 0.02, ci_high: 0.3, n: 12 },
            cost_per_task_usd: { value: 0.4, ci_low: null, ci_high: null, n: 12 },
          },
        ],
        written_at: NOW,
      };
      expect(RoutingScorecardSchema.safeParse(card).success).toBe(true);
      expect(LOOKBACK_REPO.routingScorecard).toBe(".vtc/lookback/scorecards/routing.json");
    });

    it("samples 6 + 6 tasks, caps at 24 trials, 36 above half the weekly window", () => {
      expect(lookbackPaceFor(undefined, null)).toEqual({
        failureTasks: 6,
        regressionTasks: 6,
        maxTrialsPerRetro: 24,
      });
      expect(lookbackPaceFor(undefined, 50).maxTrialsPerRetro).toBe(24);
      expect(lookbackPaceFor(undefined, 51).maxTrialsPerRetro).toBe(36);
      const user = UserConfigSchema.parse({
        version: 1,
        lookback: { max_trials_per_retro: 40, max_trials_per_retro_boosted: 30 },
      });
      // the boosted cap never goes below the base one
      expect(lookbackPaceFor(user, 90).maxTrialsPerRetro).toBe(40);
      expect(LOOKBACK_LIMITS.driftWindowDays).toBe(14);
    });
  });

  describe("tool and capability signals (D-cs)", () => {
    it("shapes a command line without values or paths", () => {
      const shapes = commandShapes(
        "FOO=1 pnpm test --filter @acme/secret-app && ./scripts/deploy.sh prod | grep -v 'x y'",
      );
      expect(shapes.map((s) => [s.program, s.subcommand])).toEqual([
        ["pnpm", "test"],
        // 5.5.0 (reading 228): a script's next word is an argument, never a subcommand
        [COMMAND_SHAPE_PATH, undefined],
        ["grep", undefined],
      ]);
      expect(JSON.stringify(shapes)).not.toContain("acme");
      expect(JSON.stringify(shapes)).not.toContain("scripts");
      expect(shapes[0]?.flags).toBe(sha256Hex("--filter").slice(0, 12));
      expect(commandShapes("git -C /repo/acme status")[0]).toEqual({
        program: "git",
        flags: sha256Hex("-C").slice(0, 12),
      });
      expect(commandShapes("$TOOL run")[0]?.program).toBe(COMMAND_SHAPE_OTHER);
      expect(commandShapes("env A=1 B=2 make build")[0]?.program).toBe("make");
      expect(commandShapes("")).toEqual([]);
    });

    it("counts shapes per key, most used first", () => {
      const counted = countCommandShapes([
        ...commandShapes("git status"),
        ...commandShapes("pnpm test"),
        ...commandShapes("git status"),
      ]);
      expect(counted.map((c) => [commandShapeKey(c), c.count])).toEqual([
        [`git status ${sha256Hex("").slice(0, 12)}`, 2],
        [`pnpm test ${sha256Hex("").slice(0, 12)}`, 1],
      ]);
    });

    it("carries the shapes on role.submitted and in the hook's spool", () => {
      const submitted = {
        action_id: "a-1",
        exit: "done",
        findings: 0,
        questions: 0,
        session_ref: null,
        command_shapes: countCommandShapes(commandShapes("git status")),
      };
      expect(validateEventData("role.submitted", submitted).ok).toBe(true);
      expect(
        CommandShapeSpoolRowSchema.safeParse({
          v: 1,
          at: NOW,
          agent: "vtc:vtc-engineer-backend",
          cwd: "/tmp/wt/T-1",
          shape: commandShapes("git status")[0],
        }).success,
      ).toBe(true);
      expectTypeOf<ParsedStream["commandShapes"]>().toEqualTypeOf<
        readonly { program: string; subcommand?: string | undefined; flags: string }[] | undefined
      >();
      expect(TOOL_SIGNAL_MIN_TASKS).toBe(3);
      expect(CAPABILITY_SIGNAL_MIN).toBe(2);
    });

    it("lets a role or the Lead name a missing capability, kept on the escalation", () => {
      const question = QuestionSchema.parse({
        question: "No browser to check the flow. Proceed without it?",
        options: [
          { id: "proceed", label: "Proceed", effect: "retry" },
          { id: "drop", label: "Drop the check", effect: "drop" },
        ],
        recommended: "proceed",
        evidence: [{ type: "file_line", ref: "src/a.ts:1" }],
        missing_capability: { slug: "browser_automation", reason: "no browser tool" },
      });
      const escalation = escalationFromQuestion(question, {
        id: "E-1",
        run: "run-2026-10-15",
        reason: "blocked",
        created_at: NOW,
        task: "T-1",
      });
      expect(escalation.missing_capability?.slug).toBe("browser_automation");
      expect(
        EscalationAnswerSchema.safeParse({
          option: "proceed",
          who_should_have_caught: "none",
          missing_capability: { slug: "db_migration_runner", reason: "no runner" },
        }).success,
      ).toBe(true);
    });
  });

  describe("UI before/after evidence (D-ct) and gh --attach (D-cc)", () => {
    it("sets has_ui from the issue's touched paths", () => {
      expect(touchesUi(["apps/dashboard/src/app.tsx"])).toBe(true);
      expect(touchesUi(["src/styles/Main.SCSS"])).toBe(true);
      expect(touchesUi(["packages/engine/src/core/loop.ts"])).toBe(false);
      expect(touchesUi([])).toBe(false);
    });

    it("says why evidence is partial", () => {
      const pr = {
        target: { kind: "project", repo: "me/app" },
        kind: "finding",
        fingerprint: "0123456789abcdef",
        number: 3,
        url: "https://github.com/me/app/pull/3",
        branch: "vtc/auto/finding/01234567",
        evidence: "partial",
        partial_reason: "base_build_failed",
      };
      expect(UPSTREAM_EVENT_PAYLOAD_SCHEMAS["upstream.pr_opened"].safeParse(pr).success).toBe(true);
      const manifest = {
        v: 1,
        kind: "finding",
        fingerprint: "0123456789abcdef",
        hosting: "attach",
        files: [
          {
            name: "01-after.png",
            kind: "ui_after",
            bytes: 10,
            sha256: SHA,
            redaction: "passed",
            alt: "after",
          },
        ],
        complete: false,
        partial_reason: "base_serve_failed",
        captured_at: NOW,
      };
      expect(EvidenceManifestSchema.safeParse(manifest).success).toBe(true);
      expectTypeOf<EvidenceRecorder["captureBeforeAfter"]>().not.toBeUndefined();
    });

    it("prefers gh --attach and falls back to the evidence branch", () => {
      expect(EVIDENCE_HOSTING_PREFERRED).toBe("attach");
      expect(EVIDENCE_HOSTING_DEFAULT).toBe("branch");
    });
  });

  describe("followups of readings 211 and 212", () => {
    it("lets pause and resume answer without a run", () => {
      expect(ENGINE_MCP_TOOLS.find((t) => t.name === "pause")?.output).toBe("ControlResult");
      expect(ENGINE_MCP_TOOLS.find((t) => t.name === "resume")?.output).toBe("ControlResult");
      expect(ControlResultSchema.safeParse({ run: null, automation_paused: true }).success).toBe(
        true,
      );
      expect(
        ControlResultSchema.safeParse({
          run: "run-2026-10-15",
          paused: true,
          phase: "build",
          automation_paused: true,
        }).success,
      ).toBe(true);
      expect(ControlResultSchema.safeParse({ run: null }).success).toBe(false);
    });

    it("skips with error, and names the remote branch of a push", () => {
      expect(AutomationSkipReasonSchema.options).toContain("error");
      expect(
        validateEventData("branch.pushed", {
          branch: "vtc/F-1",
          commit: "0123456789abcdef0123456789abcdef01234567",
          remote_ref: "vtc/auto/finding/01234567",
        }).ok,
      ).toBe(true);
      expect(
        validateEventData("branch.push_failed", {
          branch: "vtc/F-1",
          detail: "rejected",
          remote_ref: "main",
        }).ok,
      ).toBe(false);
    });

    it("moves the remote-refs seam onto GitPlumbing", () => {
      expectTypeOf<GitPlumbing["fetch"]>().toEqualTypeOf<
        ((remote: string, refspecs: readonly string[]) => Promise<void>) | undefined
      >();
      expectTypeOf<GitPlumbing["message"]>().toEqualTypeOf<
        ((sha: string) => Promise<string | null>) | undefined
      >();
    });
  });
});
