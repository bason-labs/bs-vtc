/**
 * Engine surfaces other packages build against (AD-4, AD-5):
 * - the MCP tool surface the Lead calls (§4.2), every tool with an input and an output contract;
 * - the localhost HTTP/SSE routes the dashboard and the statusline shim call (§6.9, §15, §17),
 *   every route with a response contract (and a request contract for the two writes).
 * Contracts are referenced by their `CONTRACT_SCHEMAS` name; `engine-api.test.ts` fails when a
 * tool or route names a contract that does not exist.
 */
import { z } from "zod";
import { DesignCoverageReportSchema, DesignExitSchema, G2DirectionSchema } from "./design.js";
import { EscalationAnswerSchema, EscalationSchema } from "./escalation.js";
import { HeadlessRunSummarySchema } from "./headless.js";
import { FactWaiverSchema, UnverifiedFactSummarySchema } from "./research.js";
import { EventSchema } from "./event.js";
import { FeatureSchema } from "./feature.js";
import { FindingSchema } from "./finding.js";
import { GateReportSchema } from "./gate-result.js";
import { HostFailureOutcomeSchema, SubagentInstructionSchema } from "./interfaces/host-adapter.js";
import {
  EscalationIdSchema,
  FeatureIdSchema,
  GitShaSchema,
  HostIdSchema,
  IsoDateTimeSchema,
  ModelTierSchema,
  RelPathSchema,
  RiskRuleReasonRuleSchema,
  RoleIdSchema,
  RunIdSchema,
  SessionRefSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
  TokenUsageSchema,
  VerdictSubjectSchema,
  type HostId,
} from "./primitives.js";
import {
  ArtifactRefSchema,
  RoleExitSchema,
  RoleResultSchema,
  VerdictSchema,
} from "./role-result.js";
import {
  ATTACHMENTS,
  AttachmentPathSchema,
  ChangeRequestArtifactSchema,
  FrozenArtifactSchema,
  HumanGateIdSchema,
  IntakeClassificationSchema,
  PhaseSchema,
  RunSchema,
} from "./run.js";
import { RejectReasonSchema } from "./event-payloads.js";
import { TierReasonSchema } from "./tier-routing.js";
import { checkParkRiskRule, ParkReasonSchema, TaskSchema, TaskStatusSchema } from "./task.js";
import { STATUSLINE_INGEST_MAX_BYTES, UsageReportSchema } from "./usage.js";

// ------------------------------------------------------------------ MCP tools

/**
 * Lead-facing MCP tools (server name `vtc`). `input` / `output` name contracts in
 * `CONTRACT_SCHEMAS`. Role-facing tools are added by later sub-projects (AD-4 rule 3).
 */
export const ENGINE_MCP_TOOLS = [
  {
    name: "start",
    purpose:
      "Start a run from an idea or change request, with the Lead's intake classification (track, repo, UI, risk hints).",
    input: "StartInput",
    output: "StartResult",
  },
  {
    name: "next",
    purpose:
      "Return the next actions for the Lead: spawn a role, ask the human, approve a gate, wait, or done.",
    input: "RunScopedInput",
    output: "NextResult",
  },
  {
    name: "submit",
    purpose:
      "Submit a role result (or the reason it did not finish) for a dispatched action; validated, claim-checked and scope-checked.",
    input: "SubmitInput",
    output: "SubmitResult",
  },
  {
    name: "status",
    purpose: "Summarise the run: phase, tasks by state, parked items, budget and usage.",
    input: "RunScopedInput",
    output: "StatusResult",
  },
  {
    name: "escalations",
    purpose: "List open escalations (batched) with evidence, options and the recommended option.",
    input: "RunScopedInput",
    output: "EscalationList",
  },
  {
    name: "answer",
    purpose: "Record the human's answer to an escalation and resume the parked work.",
    input: "AnswerInput",
    output: "NextResult",
  },
  {
    name: "approve",
    purpose: "Record the human's decision on gate G1 (spec) or G2 (architecture + design).",
    input: "ApproveInput",
    output: "NextResult",
  },
  {
    name: "change_request",
    purpose: "Open a change request against a frozen artifact (spec, architecture or design).",
    input: "ChangeRequestInput",
    output: "ChangeRequestResult",
  },
  {
    name: "consult",
    purpose:
      "Consult an advisor at the human's request: the engine dispatches it like a role (logged, priced, budgeted) and returns the spawn_role action, or, where the Lead's roles run headless (a Codex Lead), launches it itself and relays its answer in a later NextResult.notices.",
    input: "ConsultInput",
    output: "ConsultResult",
  },
  {
    name: "cancel",
    purpose:
      "End a run the human no longer wants (human only): stop its role runs, turn off its automatic merges and finish it as aborted, so the repo can start another run.",
    input: "RunScopedInput",
    output: "CancelResult",
  },
  {
    name: "pause",
    purpose:
      "Kill switch: stop dispatching and merging; in-flight steps finish or are interrupted.",
    input: "RunScopedInput",
    output: "ControlResult",
  },
  {
    name: "resume",
    purpose:
      "Resume a paused or interrupted run, rebuilding state from the event log. adopt: continue here a run another clone started (human only).",
    input: "ResumeInput",
    output: "ControlResult",
  },
] as const;
export type EngineMcpToolName = (typeof ENGINE_MCP_TOOLS)[number]["name"];

/**
 * Role-facing MCP tools (AD-4 rule 3; spine AD-22, new in 4.5.0): the research fetchers and the
 * facts table, for the Research Analyst and the Architect. The engine serves them next to
 * {@link ENGINE_MCP_TOOLS} on the same server, to role sessions and the Lead alike; every result is
 * compact and fetched text arrives datamarked (`datamarkFetchedText`). A role proposes a fact and
 * the engine verifies it; no role writes `facts.jsonl` or the cache itself.
 */
export const ROLE_MCP_TOOLS = [
  {
    name: "research_fetch",
    purpose:
      "Fetch from a pinned research source (endoflife.date, deps.dev, OSV, a registry, GitHub, a web page, RSS, a video transcript, search) through the engine's cache; returns the result and the datamarked text.",
    input: "ResearchFetchInput",
    output: "ResearchFetchResult",
  },
  {
    name: "fact_lookup",
    purpose: "Look up recorded facts by id or by subject, with their status and source.",
    input: "FactLookupInput",
    output: "FactLookupResult",
  },
  {
    name: "fact_propose",
    purpose:
      "Propose a fact with its source and locator; the engine verifies the locator against the cached source and records the row as verified or unverified.",
    input: "FactProposeInput",
    output: "FactProposeResult",
  },
] as const;
export type RoleMcpToolName = (typeof ROLE_MCP_TOOLS)[number]["name"];

/**
 * Tools that record a human decision (D-an, spine §5 reading 71). The engine accepts them only
 * from a human channel:
 * - the run's Lead session (a `client: bridge` connection the engine holds as the run's Lead),
 *   which relays what the human said in the Lead chat (spec §6.2, D5); never a role session;
 * - a cli connection whose `EngineSocketHello.install_token` matched, sent only after the human
 *   confirmed in an interactive terminal;
 * - a browser holding a dashboard session token, should an HTTP route for one of these tools
 *   ever exist. None does today (AD-5 rule 5: approval happens in the Lead chat); such a route
 *   would take the session token only, never the install token the shim and the cli send
 *   without a TTY check.
 * A bare `{client: "cli"}` hello is never proof of a human: such a call is refused with
 * `forbidden` and {@link humanChannelRequired}.
 */
export const HUMAN_ONLY_TOOLS = [
  "approve",
  "answer",
  "change_request",
  // 5.13.0 (spine §5 reading 268): ending a run is the human's decision too
  "cancel",
] as const satisfies readonly EngineMcpToolName[];
export type HumanOnlyToolName = (typeof HUMAN_ONLY_TOOLS)[number];

export const isHumanOnlyTool = (name: string): name is HumanOnlyToolName =>
  (HUMAN_ONLY_TOOLS as readonly string[]).includes(name);

/** The refusal text for a human-only tool called from no human channel. */
export const humanChannelRequired = (tool: HumanOnlyToolName): string =>
  `${tool} records a human decision and needs a human channel: the Lead chat, or the vtc cli confirmed in an interactive terminal`;

/**
 * The MCP server entry every host plugin registers (§4.4, AD-4, AD-16): a stdio bridge to the
 * repo's daemon that tags its session with the host it runs in (the `host` of its
 * `EngineSocketHello`, `ENGINE_SOCKET`). The Claude Code plugin carries it in
 * `plugins/claude-code/.mcp.json`; the Codex installer writes the same entry.
 */
export const engineMcpServer = (
  host: HostId,
): { readonly name: "vtc"; readonly command: "vtc"; readonly args: readonly string[] } => ({
  name: "vtc",
  command: "vtc",
  args: ["engine", "--mcp", "--host", HostIdSchema.parse(host)],
});

/** Tools act on the active run when `run` is omitted. */
export const RunScopedInputSchema = z.strictObject({ run: RunIdSchema.optional() });
export type RunScopedInput = z.infer<typeof RunScopedInputSchema>;

/**
 * `resume`. `adopt` (spine §5 reading 88): the run was started by another clone's engine (its
 * `run.started.origin` is not this install's), so this engine opened it read-only; adopting
 * makes this install its one writer from here on. Only a human channel adopts (the Lead session
 * relaying the human, or `vtc resume --adopt` after a terminal confirmation). New in 4.4.0.
 */
export const ResumeInputSchema = RunScopedInputSchema.extend({ adopt: z.boolean().optional() });
export type ResumeInput = z.infer<typeof ResumeInputSchema>;

/**
 * `start` carries the Lead's INTAKE classification (§6.1): the Lead classifies, the engine
 * cannot. The human may override the track (§6.2) before the Lead calls `start`.
 */
export const StartInputSchema = z.strictObject({
  request: z.string().min(1).max(20000),
  ...IntakeClassificationSchema.shape,
  /**
   * Images the human attached to the request (screenshots pasted into the Lead session), as the
   * absolute paths the host gives the Lead, at most {@link ATTACHMENTS.max}. The engine copies
   * each into gitignored local state (`runAttachmentPath`; never committed with the run, sent
   * upstream or made PR evidence, reading 266) and lists the copies in the SPECIFY and DISCOVER
   * packs as `attachments` inputs. A host that gives no path cannot pass them: the Lead then asks
   * the human to describe them or attach the files (spine §5 reading 262). New in 5.12.0.
   */
  attachments: z.array(AttachmentPathSchema).max(ATTACHMENTS.max).optional(),
  /**
   * Autopilot for this run (spine §5 reading 271; `ProjectConfig.autopilot`): the engine answers
   * the questions it may decide with their recommended option and approves G1 and G2, so the
   * human's one review is the PR. `false` turns it off for this run when the project has it on.
   * Absent: the project's setting. New in 5.14.0.
   */
  autopilot: z.boolean().optional(),
});
export type StartInput = z.infer<typeof StartInputSchema>;

export const StartResultSchema = z.strictObject({
  run: RunIdSchema,
  track: IntakeClassificationSchema.shape.track,
  phase: PhaseSchema,
});
export type StartResult = z.infer<typeof StartResultSchema>;

/**
 * A subagent spawn the Lead performs (AD-4 rule 4): from `next`, or from `consult` for an
 * advisor.
 */
export const SpawnRoleActionSchema = z.strictObject({
  type: z.literal("spawn_role"),
  /** Echoed back in `submit`; results for unknown or stale action ids are rejected. */
  action_id: SlugSchema,
  role: RoleIdSchema,
  mode: SlugSchema.optional(),
  task: TaskIdSchema.optional(),
  feature: FeatureIdSchema.optional(),
  /** The one subject this call judges, e.g. the AC of a Spec-Verifier call (§7.4). */
  subject: VerdictSubjectSchema.optional(),
  /** The task pack the role reads (§6.3 step 1; `TaskPack`, rendered by `renderTaskPack`). */
  pack: RelPathSchema,
  ...SubagentInstructionSchema.shape,
  /**
   * The model id the engine resolved for this run (AD-6 rule 2), after a tier escalation
   * (§6.3 step 9) or a budget drop (§11). The Lead passes it to the host's subagent spawn where
   * the host takes a model; the `role.dispatched` envelope records the same id. Absent when the
   * engine resolved no id (`ResolvedModel.model`, D-ae): the spawn uses the session's model.
   */
  model: z.string().min(1).max(200).optional(),
  /** Resume this host session (patch rounds, answers: §6.3 step 8, §6.5), when the host can. */
  resume: SessionRefSchema.optional(),
});
export type SpawnRoleAction = z.infer<typeof SpawnRoleActionSchema>;

/**
 * One action from `next` (§4.2 step 1). The Lead only dispatches what the engine returns.
 * `spawn_role` is always a subagent spawn the Lead performs; headless runs are launched by the
 * engine itself and never appear here (AD-4 rule 4).
 */
export const LeadActionSchema = z.discriminatedUnion("type", [
  SpawnRoleActionSchema,
  z.strictObject({
    type: z.literal("ask_human"),
    escalations: z.array(EscalationIdSchema).min(1),
  }),
  z.strictObject({
    type: z.literal("approve_gate"),
    /** Quick-fix track combines G1 + G2 on one screen (§6.2). */
    gates: z.array(HumanGateIdSchema).min(1).max(2),
    /** What to show, with the hashes the approval must echo (§6.2 freezing). */
    artifacts: z.array(FrozenArtifactSchema).min(1),
    /** G2: the 2–3 design directions to choose from (§9.1 step 5). */
    design_directions: z.array(SlugSchema).max(3).default([]),
    /** G2: research claims still UNVERIFIED; each needs a human waiver (§8.2). */
    unverified_facts: z.array(SlugSchema).default([]),
    /**
     * G2: what to show for each of `design_directions` (prototype, screenshot, novelty), in the
     * same order. New in 4.5.0.
     */
    directions: z.array(G2DirectionSchema).max(3).optional(),
    /**
     * G2: what to show for each of `unverified_facts` (subject, status, why), in the same order:
     * every fact that is unverified, stale or conflicting, plus `UNVERIFIED:` tags and version,
     * licence, CVE or EOL claims in the research sections that cite no fact (AD-22 rule 5).
     * New in 4.5.0.
     */
    facts: z.array(UnverifiedFactSummarySchema).optional(),
    /**
     * G2: the DESIGN check (§6.1, `DesignCoverageReport`). Since 5.7.0 (H-13; spine §5 reading
     * 237) G2 is offered only once its coverage part is complete (`designCoverageComplete`): the
     * engine's coverage loop re-dispatches the Architect and the Designer first, and parks the run
     * with an escalation when it cannot close the gaps, so there is no "approve anyway". The
     * engine still refuses an approval while `ok` is false (a `directions_problem`). New in 4.8.0.
     */
    design_coverage: DesignCoverageReportSchema.optional(),
    /**
     * G2 with directions: the exits offered beside them, re-roll and the category standard
     * (§9.1 step 5, `DesignExitSchema`); the human takes one with `ApproveInput.design_exit`.
     * New in 4.9.0.
     */
    design_exits: z.array(DesignExitSchema).max(2).optional(),
  }),
  z.strictObject({
    type: z.literal("wait"),
    reason: z.string().min(1).max(300),
    until: IsoDateTimeSchema.nullable(),
  }),
  z.strictObject({ type: z.literal("done"), summary: RelPathSchema.optional() }),
]);
export type LeadAction = z.infer<typeof LeadActionSchema>;

export const NextResultSchema = z.strictObject({
  run: RunIdSchema,
  actions: z.array(LeadActionSchema),
  /**
   * Short notices the Lead relays to the human once, in its own words: the automation daily
   * summary (D-ca: issues and PRs VTC opened, and what it skipped, with links) and run notices
   * such as `HOST_WEB_OFF_NOTICE`. Absent: none. New in 5.0.0.
   */
  notices: z.array(z.string().min(1).max(2000)).max(20).optional(),
});
export type NextResult = z.infer<typeof NextResultSchema>;

/**
 * Spend of a subagent run as the host reported it to the Lead (§11 cost capture).
 *
 * Budget semantics (D-at, spine §5 reading 77): a host-reported `cost_usd` is kept and counts
 * toward the task, Final Review and advisor budgets whatever the model id is, including
 * `SESSION_DEFAULT_MODEL` and ids missing from the engine's price table; being conservative about
 * budget beats being precise about price. The engine prices tokens itself only when the host
 * reported no cost. A run is **unpriced** (`role.submitted.cost_usd: null`, counted as 0 and
 * flagged) only when neither the host nor the price table gives a cost. The run summary still
 * notes "model unknown" for a run whose model id the price table does not know.
 */
export const RunUsageSchema = z.strictObject({
  model: z.string().min(1).max(200).nullable(),
  tokens: TokenUsageSchema.nullable(),
  cost_usd: z.number().nonnegative().nullable(),
});
export type RunUsage = z.infer<typeof RunUsageSchema>;

/**
 * `submit` carries either the role's result, or the normalised reason it did not finish
 * (`limit | auth | error`, §4.1, §6.9), so limit parking and cost tracking also work for
 * subagent runs.
 */
export const SubmitInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("result"),
    run: RunIdSchema.optional(),
    action_id: SlugSchema,
    result: RoleResultSchema,
    usage: RunUsageSchema.optional(),
    /**
     * The host session the run used, as the host reported it to the Lead. The engine records it
     * as `task.session_updated`, so later rounds and answers resume it (§6.3 step 8, §6.5).
     */
    session_ref: SessionRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("failure"),
    run: RunIdSchema.optional(),
    action_id: SlugSchema,
    outcome: HostFailureOutcomeSchema,
  }),
]);
export type SubmitInput = z.infer<typeof SubmitInputSchema>;
export type SubmitInputInput = z.input<typeof SubmitInputSchema>;

export const SubmitResultSchema = z
  .strictObject({
    run: RunIdSchema,
    accepted: z.boolean(),
    /** Why the result was rejected (§4.2 step 4); present exactly when not accepted. */
    rejection: z
      .strictObject({
        reason: RejectReasonSchema,
        issues: z.array(z.string().min(1).max(500)).max(20).default([]),
      })
      .optional(),
    actions: z.array(LeadActionSchema),
  })
  .superRefine((result, ctx) => {
    if (result.accepted === (result.rejection !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["rejection"],
        message: "rejection is required exactly when the result was not accepted",
      });
    }
  });
export type SubmitResult = z.infer<typeof SubmitResultSchema>;

export const AnswerInputSchema = z.strictObject({
  run: RunIdSchema.optional(),
  escalation: EscalationIdSchema,
  answer: EscalationAnswerSchema,
});
export type AnswerInput = z.infer<typeof AnswerInputSchema>;

/**
 * The human's gate decision. Every artifact is frozen at the hash that was shown; the engine
 * rejects the call if a hash no longer matches the file (§6.2).
 */
export const ApproveInputSchema = z
  .strictObject({
    run: RunIdSchema.optional(),
    gates: z.array(HumanGateIdSchema).min(1).max(2),
    decision: z.enum(["approve", "reject"]),
    frozen: z.array(FrozenArtifactSchema).min(1),
    /** G2: the chosen design direction (§9.1 step 5). */
    design_direction: SlugSchema.optional(),
    /**
     * G2: an exit instead of a direction (§9.1 step 5, `DesignExitSchema`): `re_roll` with
     * `decision: reject`, `category_standard` with `decision: approve` and no
     * `design_direction`. New in 4.9.0.
     */
    design_exit: DesignExitSchema.optional(),
    /** G2: UNVERIFIED research claims the human waives (§8.2). */
    waived_facts: z.array(SlugSchema).default([]),
    /**
     * G2: the human's reason for each waived fact (AD-22 rule 5); each id must also be in
     * `waived_facts`. The engine requires a waiver with a reason for every fact
     * `approve_gate.unverified_facts` listed and records each as `fact.waived`. New in 4.5.0.
     */
    fact_waivers: z.array(FactWaiverSchema).max(200).optional(),
    note: z.string().max(4000).optional(),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.gates).size !== input.gates.length) {
      ctx.addIssue({ code: "custom", path: ["gates"], message: "gates must be unique" });
    }
    const paths = input.frozen.map((f) => f.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({ code: "custom", path: ["frozen"], message: "each artifact is frozen once" });
    }
    const g2 = input.gates.includes("G2");
    if (!g2 && (input.design_direction !== undefined || input.waived_facts.length > 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["design_direction"],
        message: "design_direction and waived_facts belong to G2",
      });
    }
    const waived = new Set(input.waived_facts);
    if ((input.fact_waivers ?? []).some((w) => !waived.has(w.id))) {
      ctx.addIssue({
        code: "custom",
        path: ["fact_waivers"],
        message: "every fact waiver names a fact in waived_facts",
      });
    }
    if (input.decision === "reject" && input.design_direction !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["design_direction"],
        message: "a rejection does not choose a design direction",
      });
    }
    if (input.design_exit !== undefined) {
      const fits =
        g2 &&
        (input.design_exit === "re_roll"
          ? input.decision === "reject"
          : input.decision === "approve" && input.design_direction === undefined);
      if (!fits)
        ctx.addIssue({
          code: "custom",
          path: ["design_exit"],
          message:
            "design_exit belongs to G2: re_roll with a rejection, category_standard with an approval that picks no direction",
        });
    }
  });
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export const ChangeRequestInputSchema = z
  .strictObject({
    run: RunIdSchema.optional(),
    artifact: ChangeRequestArtifactSchema,
    /** The provider task whose published interface contract changes (§6.6). */
    task: TaskIdSchema.optional(),
    summary: z.string().min(1).max(300),
    detail: z.string().min(1).max(8000),
    /**
     * Images the human attached to the change, as on `start`; the packs of the role that owns the
     * changed artifact list them (the Architect's, the Designer's, the BA's, the provider task's).
     * New in 5.12.0.
     */
    attachments: z.array(AttachmentPathSchema).max(ATTACHMENTS.max).optional(),
  })
  .refine((input) => (input.artifact === "interface_contract") === (input.task !== undefined), {
    message: "task is required for, and only allowed with, interface_contract",
    path: ["task"],
  });
export type ChangeRequestInput = z.infer<typeof ChangeRequestInputSchema>;

/** A CR becomes an escalation with reason `change_request` the human decides (§6.2). */
export const ChangeRequestResultSchema = z.strictObject({
  run: RunIdSchema,
  escalation: EscalationIdSchema,
});
export type ChangeRequestResult = z.infer<typeof ChangeRequestResultSchema>;

/**
 * `consult` (§5.4 "called through the Lead"; spine §5 reading 25): the human asked the Lead for
 * an advisor. The engine checks that `advisor` is an advisor role (`RoleContract.kind`), that the
 * run's advisor budget (`budgets.advisor_usd`) is not spent, writes the pack (the question and the
 * inputs) and returns the `spawn_role` action. The Lead spawns it and submits its `RoleResult`
 * with `submit`, so the call is logged (`role.dispatched` / `role.submitted` with prompt SHA and
 * model) and priced like any role. Advice changes nothing by itself: acting on it goes through
 * `start`, `change_request` or `answer`.
 */
export const ConsultInputSchema = z.strictObject({
  run: RunIdSchema.optional(),
  advisor: RoleIdSchema,
  question: z.string().min(1).max(4000),
  /** Artifacts the advisor should read, by type and path (e.g. `cost_history`, `run_status`). */
  inputs: z.array(ArtifactRefSchema).max(20).default([]),
});
export type ConsultInput = z.infer<typeof ConsultInputSchema>;

/** A consult the Lead runs in its own session: the `spawn_role` to spawn (4.1.0). */
export const InSessionConsultResultSchema = z.strictObject({
  run: RunIdSchema,
  action: SpawnRoleActionSchema,
});

/**
 * A consult the engine launched itself (spine §5 reading 267): where the run's Lead host runs its
 * roles headless (a Codex Lead, `ROLE_DISPATCH_BY_LEAD_HOST`), the advisor runs as an
 * engine-launched headless run on that host, like every other role. No action comes back: the
 * engine relays the advisor's answer (or why it failed) once, in a later `NextResult.notices`,
 * with the path of its full result. New in 5.13.0.
 */
export const LaunchedConsultResultSchema = z.strictObject({
  run: RunIdSchema,
  launched: z.strictObject({ action_id: SlugSchema, host: HostIdSchema }),
});

/** The output of `consult`: in-session, or launched headless (5.13.0). */
export const ConsultResultSchema = z.union([
  InSessionConsultResultSchema,
  LaunchedConsultResultSchema,
]);
export type ConsultResult = z.infer<typeof ConsultResultSchema>;

/**
 * `cancel` (spine §5 reading 268): the human ends a run started by mistake or no longer wanted.
 * The engine stops the run's headless role runs, turns off every automatic merge it enabled and
 * finishes the run (`run.finished`, outcome `aborted`, actor `human`), so the repo may `start`
 * another. Its open escalations end with it. Worktrees and branches the run made stay for the
 * human (`worktrees_left`). A human-only tool (`HUMAN_ONLY_TOOLS`). New in 5.13.0.
 */
export const CancelResultSchema = z.strictObject({
  run: RunIdSchema,
  phase: PhaseSchema,
  /** Headless role runs the engine stopped. */
  stopped_runs: z.int().nonnegative(),
  /** Open escalations that ended with the run. */
  closed_escalations: z.int().nonnegative(),
  /** Task worktrees (repo-relative) the run leaves for the human to keep or remove. */
  worktrees_left: z.array(RelPathSchema).max(200),
});
export type CancelResult = z.infer<typeof CancelResultSchema>;

export const RunControlResultSchema = z.strictObject({
  run: RunIdSchema,
  paused: z.boolean(),
  phase: PhaseSchema,
  /**
   * Whether the repo's automation kill switch is set after the call (`vtc pause` sets it, `vtc
   * resume` clears it; AD-27 rule 7). Absent from an engine before 5.4.0. New in 5.4.0.
   */
  automation_paused: z.boolean().optional(),
});
export type RunControlResult = z.infer<typeof RunControlResultSchema>;

/**
 * `pause` / `resume` when the repo has no run to act on (reading 212(15) closed): the call still
 * sets or clears the automation kill switch and says so. Where 5.3.0 answered such a call with
 * the `no_run` error, 5.4.0 answers with this. New in 5.4.0.
 */
export const NoRunControlResultSchema = z.strictObject({
  run: z.null(),
  automation_paused: z.boolean(),
});
export type NoRunControlResult = z.infer<typeof NoRunControlResultSchema>;

/** The output of `pause` and `resume` (AD-4): a run's state, or the kill switch alone. New in 5.4.0. */
export const ControlResultSchema = z.union([RunControlResultSchema, NoRunControlResultSchema]);
export type ControlResult = z.infer<typeof ControlResultSchema>;

/** The run summary: `status` tool output and `GET /api/status` (for the active run). */
export const StatusResultSchema = z.strictObject({
  run: RunSchema,
  tasks_by_status: z.partialRecord(TaskStatusSchema, z.int().nonnegative()),
  /** Parked tasks with their reason and, for reason `risk_rule`, the rule that fired. */
  parked: z
    .array(
      z
        .strictObject({
          task: TaskIdSchema,
          reason: ParkReasonSchema,
          risk_rule: RiskRuleReasonRuleSchema.optional(),
        })
        .superRefine((entry, ctx) => {
          checkParkRiskRule({ park_reason: entry.reason, risk_rule: entry.risk_rule }, ctx);
        }),
    )
    .default([]),
  /** Every feature with its state; parked features park as a unit (§6.7a). */
  features: z.array(FeatureSchema).default([]),
  open_escalations: z.int().nonnegative(),
  // `budget_usd` 0 is no cap yet (no feature budget and no run-scope budget.updated, e.g. a quick
  // fix before PLAN): `vtc status` shows "Spent: $x (no cap)" (spine §5 reading 264)
  budget: z.strictObject({
    budget_usd: z.number().nonnegative(),
    spent_usd: z.number().nonnegative(),
  }),
  usage: UsageReportSchema,
  /** Role runs the engine launched itself and that are still running (AD-25). New in 4.5.0. */
  headless_runs: z.array(HeadlessRunSummarySchema).optional(),
  /**
   * The run is on autopilot (`run.started.autopilot`): how many questions and gates the engine
   * decided for the human so far. Absent: not on autopilot. New in 5.14.0.
   */
  autopilot: z.strictObject({ decisions: z.int().nonnegative() }).optional(),
});
export type StatusResult = z.infer<typeof StatusResultSchema>;

export const EscalationListSchema = z.strictObject({
  run: RunIdSchema,
  escalations: z.array(EscalationSchema),
});
export type EscalationList = z.infer<typeof EscalationListSchema>;

// --------------------------------------------------------------- HTTP / SSE

export const HealthResultSchema = z.strictObject({
  ok: z.literal(true),
  /** `live` = the repo's engine daemon; `snapshot` = `vtc dashboard` over committed `.vtc/` (AD-5). */
  mode: z.enum(["live", "snapshot"]),
  engine_version: z.string().min(1).max(64),
  contracts_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /**
   * Origin of the separate prototype server (`http://127.0.0.1:<port>/`), or `null` when the
   * run has no prototype. The dashboard embeds it only in `<iframe sandbox="allow-scripts">`.
   */
  prototype_url: z
    .string()
    .regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/$/, "expected http://127.0.0.1:<port>/")
    .nullable(),
});
export type HealthResult = z.infer<typeof HealthResultSchema>;

export const RunListSchema = z.strictObject({
  runs: z.array(
    RunSchema.pick({
      id: true,
      track: true,
      phase: true,
      paused: true,
      started_at: true,
      finished_at: true,
    }),
  ),
});
export type RunList = z.infer<typeof RunListSchema>;

/** Paging for `GET /api/runs/:run/events?after=<seq>&limit=<n>`. */
export const EVENT_PAGE_LIMIT = { default: 500, max: 2000 } as const;

export const EventPageSchema = z.strictObject({
  run: RunIdSchema,
  events: z.array(EventSchema),
  /** Pass as `after` to read the next page; `null` = no more events right now. */
  next_after: z.int().nonnegative().nullable(),
});
export type EventPage = z.infer<typeof EventPageSchema>;

export const TaskListSchema = z.strictObject({
  run: RunIdSchema,
  tasks: z.array(TaskSchema),
});
export type TaskList = z.infer<typeof TaskListSchema>;

/** One role run of a task, for the drill-down's timeline and prompt version (§17). */
export const RoleRunSummarySchema = z.strictObject({
  action_id: SlugSchema,
  role: RoleIdSchema,
  mode: SlugSchema.optional(),
  subject: VerdictSubjectSchema.optional(),
  /** Prompt version: content SHA of the compiled agent prompt (§13). */
  prompt_sha: Sha256HexSchema,
  host: HostIdSchema,
  /** The dispatched model id, or `SESSION_DEFAULT_MODEL` when none was resolved (D-ae). */
  model: z.string().min(1).max(200),
  /**
   * The tier the run started on and why (`role.dispatched.tier` / `tier_reason`, H-9, D-cm), for
   * the task view; absent for a dispatch logged before 5.4.0. New in 5.4.0.
   */
  tier: ModelTierSchema.optional(),
  tier_reason: TierReasonSchema.optional(),
  tier_clamped: z.boolean().optional(),
  dispatched_at: IsoDateTimeSchema,
  /** `null` while the run is in flight, failed or was rejected. */
  exit: RoleExitSchema.nullable(),
  verdicts: z
    .array(z.strictObject({ subject: VerdictSubjectSchema, verdict: VerdictSchema }))
    .default([]),
});
export type RoleRunSummary = z.infer<typeof RoleRunSummarySchema>;

/**
 * Drill-down for one task (§17): the task, its findings, gate reports, escalations, role runs
 * (with prompt versions), the commits its diff spans and its evidence bundle.
 */
export const TaskDetailSchema = z.strictObject({
  run: RunIdSchema,
  task: TaskSchema,
  plan_file: RelPathSchema,
  findings: z.array(FindingSchema).default([]),
  gate_reports: z.array(GateReportSchema).default([]),
  escalations: z.array(EscalationSchema).default([]),
  role_runs: z.array(RoleRunSummarySchema).default([]),
  /** Base and head of the task's latest verified diff; `null` before the first build. */
  diff: z.strictObject({ base: GitShaSchema, head: GitShaSchema }).nullable(),
  /** `.vtc/evidence/T-n/bundle.json` once written (`EvidenceBundle`, read via the artifacts route). */
  evidence_bundle: RelPathSchema.nullable(),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const FeatureListSchema = z.strictObject({
  run: RunIdSchema,
  features: z.array(FeatureSchema),
});
export type FeatureList = z.infer<typeof FeatureListSchema>;

/** Largest patch text a diff response carries; longer patches are cut and flagged. */
export const TASK_DIFF_MAX_PATCH_CHARS = 1_000_000;

/** `GET /api/runs/:run/tasks/:task/diff`: the task's diff from git (§17 drill-down). */
export const TaskDiffSchema = z.strictObject({
  run: RunIdSchema,
  task: TaskIdSchema,
  base: GitShaSchema,
  head: GitShaSchema,
  files: z.array(
    z.strictObject({
      path: RelPathSchema,
      status: z.enum(["added", "modified", "deleted", "renamed"]),
      old_path: RelPathSchema.optional(),
      additions: z.int().nonnegative(),
      deletions: z.int().nonnegative(),
    }),
  ),
  patch: z.string().max(TASK_DIFF_MAX_PATCH_CHARS),
  truncated: z.boolean(),
});
export type TaskDiff = z.infer<typeof TaskDiffSchema>;

/** Largest artifact the artifacts route returns, in bytes. */
export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * True for paths the artifacts route may serve: git-tracked run artifacts under `.vtc/` (spec,
 * architecture, design, plan files, evidence, events), never `.vtc/state/` (transcripts, raw
 * unredacted output). Rejects `.` and empty segments so no spelling reaches `.vtc/state/`. The
 * engine also resolves symlinks and refuses any real path outside `<repo>/.vtc/`.
 */
export const isServableArtifactPath = (path: string): boolean => {
  if (!RelPathSchema.safeParse(path).success) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === ".")) return false;
  return segments[0] === ".vtc" && segments.length > 1 && segments[1] !== "state";
};

/**
 * `GET /api/runs/:run/artifacts?path=<rel>`: one run artifact, always as JSON (served with
 * `X-Content-Type-Options: nosniff`), never as a renderable file, so agent-written HTML cannot
 * run on the API origin. Binary files come base64-encoded.
 */
export const ArtifactContentSchema = z.strictObject({
  run: RunIdSchema,
  path: RelPathSchema.refine(
    isServableArtifactPath,
    "artifacts are served from .vtc/ only, never .vtc/state/",
  ),
  sha256: Sha256HexSchema,
  size: z.int().nonnegative().max(ARTIFACT_MAX_BYTES),
  media_type: z.string().min(1).max(100),
  encoding: z.enum(["utf8", "base64"]),
  content: z.string(),
});
export type ArtifactContent = z.infer<typeof ArtifactContentSchema>;

/** Browser sessions (AD-5 rule 2): a single-use nonce from `vtc dashboard`, then a session token. */
export const ENGINE_SESSION = {
  /** A nonce is valid this long after it is minted, and only once. */
  nonceTtlMs: 60_000,
  /** A session token expires this long after the exchange, and on daemon exit. */
  sessionTtlMs: 12 * 60 * 60 * 1000,
  /** Largest exchange body in bytes. */
  maxBodyBytes: 512,
} as const;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** `POST /api/session/nonce` (install token only): what `vtc dashboard` puts in the URL fragment. */
export const SessionNonceResultSchema = z.strictObject({
  nonce: z.string().regex(TOKEN_PATTERN),
  expires_at: IsoDateTimeSchema,
});
export type SessionNonceResult = z.infer<typeof SessionNonceResultSchema>;

/** `POST /api/session` body: the nonce the dashboard read from `#nonce=` in its URL. */
export const SessionExchangeInputSchema = z.strictObject({
  nonce: z.string().regex(TOKEN_PATTERN),
});
export type SessionExchangeInput = z.infer<typeof SessionExchangeInputSchema>;

/**
 * A random session token, never the install token. The dashboard keeps it in memory or
 * `sessionStorage` and sends `Authorization: Bearer <session>`; there are no cookies.
 */
export const SessionExchangeResultSchema = z.strictObject({
  session: z.string().regex(TOKEN_PATTERN),
  expires_at: IsoDateTimeSchema,
});
export type SessionExchangeResult = z.infer<typeof SessionExchangeResultSchema>;

export const IngestResultSchema = z.strictObject({ ok: z.literal(true) });
export type IngestResult = z.infer<typeof IngestResultSchema>;

/** Largest accepted design review body in bytes (AD-5: size-limited). */
export const DESIGN_REVIEW_MAX_BYTES = 8192;

/**
 * A click-to-pin comment from Flow Studio's design review (§17). The engine appends it to
 * `.vtc/design/reviews/<screen>.jsonl` and nothing else; approval still happens in the Lead chat.
 */
export const DesignReviewCommentInputSchema = z.strictObject({
  screen: SlugSchema,
  state: SlugSchema,
  viewport: z.int().min(200).max(4000),
  theme: z.enum(["light", "dark"]),
  /** Pin position as a percentage of the rendered frame. */
  x_pct: z.number().min(0).max(100),
  y_pct: z.number().min(0).max(100),
  comment: z.string().min(1).max(2000),
  author: z.string().min(1).max(100).optional(),
});
export type DesignReviewCommentInput = z.infer<typeof DesignReviewCommentInputSchema>;

export const DesignReviewResultSchema = z.strictObject({
  ok: z.literal(true),
  /** Where the comment was appended (always under `.vtc/design/reviews/`). */
  path: RelPathSchema.refine(
    (p) => p.startsWith(".vtc/design/reviews/"),
    "design review writes stay under .vtc/design/reviews/",
  ),
});
export type DesignReviewResult = z.infer<typeof DesignReviewResultSchema>;

/** Error body for every non-2xx response. */
export const HttpErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "bad_request",
      "unauthorized",
      "forbidden",
      "not_found",
      "payload_too_large",
      "snapshot_mode",
      "internal",
    ]),
    message: z.string().max(500),
  }),
});
export type HttpError = z.infer<typeof HttpErrorSchema>;

/**
 * Content-Security-Policy of every prototype response (§17 design review). Agent-written HTML
 * runs sandboxed with an opaque origin (no `allow-same-origin`), can reach no network, submit
 * no form, and may be framed only by a loopback page.
 */
export const PROTOTYPE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors http://127.0.0.1:*",
  "sandbox allow-scripts",
].join("; ");

/**
 * Localhost HTTP API (§15, AD-5): bound to 127.0.0.1 only, Host and Origin checked, no CORS
 * headers, no cookies. `auth` per route: `token` = `Authorization: Bearer` with the install token
 * (cli, shim) or a browser session token; `install` = the install token only; `nonce` = no bearer,
 * the body carries a single-use nonce. Read-only except two size-limited, validated data writes
 * that cannot execute anything (the statusline ingest, design-review pins) and the two session
 * routes, which write nothing to disk.
 */
export const ENGINE_HTTP = {
  bindHost: "127.0.0.1",
  tokenHeader: "authorization",
  tokenScheme: "Bearer",
  routes: {
    health: { method: "GET", path: "/api/health", auth: "token", response: "HealthResult" },
    status: { method: "GET", path: "/api/status", auth: "token", response: "StatusResult" },
    runs: { method: "GET", path: "/api/runs", auth: "token", response: "RunList" },
    runEvents: {
      method: "GET",
      path: "/api/runs/:run/events",
      auth: "token",
      response: "EventPage",
    },
    tasks: { method: "GET", path: "/api/runs/:run/tasks", auth: "token", response: "TaskList" },
    task: {
      method: "GET",
      path: "/api/runs/:run/tasks/:task",
      auth: "token",
      response: "TaskDetail",
    },
    taskDiff: {
      method: "GET",
      path: "/api/runs/:run/tasks/:task/diff",
      auth: "token",
      response: "TaskDiff",
    },
    features: {
      method: "GET",
      path: "/api/runs/:run/features",
      auth: "token",
      response: "FeatureList",
    },
    /** `?path=<rel>` (`isServableArtifactPath`): spec, design, plan files, evidence bundles… */
    artifact: {
      method: "GET",
      path: "/api/runs/:run/artifacts",
      auth: "token",
      response: "ArtifactContent",
    },
    /** `?scope=project|task_dag|task&task=T-n` (§17 zoom levels). */
    graph: {
      method: "GET",
      path: "/api/runs/:run/graph",
      auth: "token",
      response: "WorkflowGraph",
    },
    escalations: {
      method: "GET",
      path: "/api/runs/:run/escalations",
      auth: "token",
      response: "EscalationList",
    },
    usage: { method: "GET", path: "/api/usage", auth: "token", response: "UsageReport" },
    /**
     * Cost per client (§14): the project's client scope from the VTC home's spend record. New in
     * 4.9.0.
     */
    clientSpend: {
      method: "GET",
      path: "/api/spend",
      auth: "token",
      response: "ClientSpendReport",
    },
    /**
     * Automatic issues and PRs of this repo (D-ca, AD-27): whether automation is on and why not,
     * what VTC opened, and the latest skips. New in 5.0.0.
     */
    automation: {
      method: "GET",
      path: "/api/automation",
      auth: "token",
      response: "AutomationReport",
    },
    /** SSE over `fetch` (the dashboard sends the bearer header): one Event per message,
     * `id: <run>:<seq>` (`sseEventId`). */
    stream: { method: "GET", path: "/api/stream", auth: "token", response: "Event", sse: true },
    sessionNonce: {
      method: "POST",
      path: "/api/session/nonce",
      auth: "install",
      response: "SessionNonceResult",
      maxBodyBytes: ENGINE_SESSION.maxBodyBytes,
    },
    session: {
      method: "POST",
      path: "/api/session",
      auth: "nonce",
      request: "SessionExchangeInput",
      response: "SessionExchangeResult",
      maxBodyBytes: ENGINE_SESSION.maxBodyBytes,
    },
    statuslineIngest: {
      method: "POST",
      path: "/api/ingest/claude-statusline",
      auth: "install",
      request: "StatuslineIngest",
      response: "IngestResult",
      maxBodyBytes: STATUSLINE_INGEST_MAX_BYTES,
    },
    designReviews: {
      method: "POST",
      path: "/api/design/reviews",
      auth: "token",
      request: "DesignReviewCommentInput",
      response: "DesignReviewResult",
      maxBodyBytes: DESIGN_REVIEW_MAX_BYTES,
    },
  },
  /**
   * The prototype server (§17 design review): a separate listener on its own 127.0.0.1 port, so
   * agent-written HTML never shares an origin with the API. It serves only files under `root`,
   * needs no token (the files are git-tracked, no run data), checks Host, sends
   * {@link PROTOTYPE_CSP} on every response and exposes no API route.
   */
  prototype: {
    bindHost: "127.0.0.1",
    root: ".vtc/design/prototype/",
    csp: PROTOTYPE_CSP,
    /** The dashboard's iframe attribute. Never add `allow-same-origin`. */
    iframeSandbox: "allow-scripts",
  },
} as const;
export type EngineHttpRouteName = keyof typeof ENGINE_HTTP.routes;
