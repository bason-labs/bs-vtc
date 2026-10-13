/**
 * Engine surfaces other packages build against (AD-4, AD-5):
 * - the MCP tool surface the Lead calls (§4.2), every tool with an input and an output contract;
 * - the localhost HTTP/SSE routes the dashboard and the statusline shim call (§6.9, §15, §17),
 *   every route with a response contract (and a request contract for the two writes).
 * Contracts are referenced by their `CONTRACT_SCHEMAS` name; `engine-api.test.ts` fails when a
 * tool or route names a contract that does not exist.
 */
import { z } from "zod";
import { EscalationAnswerSchema, EscalationSchema } from "./escalation.js";
import { EventSchema } from "./event.js";
import { FindingSchema } from "./finding.js";
import { GateReportSchema } from "./gate-result.js";
import { HostFailureOutcomeSchema, SubagentInstructionSchema } from "./interfaces/host-adapter.js";
import {
  EscalationIdSchema,
  FeatureIdSchema,
  IsoDateTimeSchema,
  RelPathSchema,
  RoleIdSchema,
  RunIdSchema,
  SessionRefSchema,
  SlugSchema,
  TaskIdSchema,
  TokenUsageSchema,
} from "./primitives.js";
import { RoleResultSchema } from "./role-result.js";
import {
  FrozenArtifactSchema,
  HumanGateIdSchema,
  IntakeClassificationSchema,
  PhaseSchema,
  RunSchema,
} from "./run.js";
import { RejectReasonSchema } from "./event-payloads.js";
import { ParkReasonSchema, TaskSchema, TaskStatusSchema } from "./task.js";
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
    name: "pause",
    purpose:
      "Kill switch: stop dispatching and merging; in-flight steps finish or are interrupted.",
    input: "RunScopedInput",
    output: "RunControlResult",
  },
  {
    name: "resume",
    purpose: "Resume a paused or interrupted run, rebuilding state from the event log.",
    input: "RunScopedInput",
    output: "RunControlResult",
  },
] as const;
export type EngineMcpToolName = (typeof ENGINE_MCP_TOOLS)[number]["name"];

/** Tools act on the active run when `run` is omitted. */
export const RunScopedInputSchema = z.strictObject({ run: RunIdSchema.optional() });
export type RunScopedInput = z.infer<typeof RunScopedInputSchema>;

/**
 * `start` carries the Lead's INTAKE classification (§6.1): the Lead classifies, the engine
 * cannot. The human may override the track (§6.2) before the Lead calls `start`.
 */
export const StartInputSchema = z.strictObject({
  request: z.string().min(1).max(20000),
  ...IntakeClassificationSchema.shape,
});
export type StartInput = z.infer<typeof StartInputSchema>;

export const StartResultSchema = z.strictObject({
  run: RunIdSchema,
  track: IntakeClassificationSchema.shape.track,
  phase: PhaseSchema,
});
export type StartResult = z.infer<typeof StartResultSchema>;

/**
 * One action from `next` (§4.2 step 1). The Lead only dispatches what the engine returns.
 * `spawn_role` is always a subagent spawn the Lead performs; headless runs are launched by the
 * engine itself and never appear here (AD-4 rule 4).
 */
export const LeadActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("spawn_role"),
    /** Echoed back in `submit`; results for unknown or stale action ids are rejected. */
    action_id: SlugSchema,
    role: RoleIdSchema,
    mode: SlugSchema.optional(),
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    /** The task pack the role reads (§6.3 step 1). */
    pack: RelPathSchema,
    ...SubagentInstructionSchema.shape,
    /** Resume this host session (patch rounds, answers: §6.3 step 8, §6.5), when the host can. */
    resume: SessionRefSchema.optional(),
  }),
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
});
export type NextResult = z.infer<typeof NextResultSchema>;

/** Spend of a subagent run as the host reported it to the Lead (§11 cost capture). */
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
    /** G2: UNVERIFIED research claims the human waives (§8.2). */
    waived_facts: z.array(SlugSchema).default([]),
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
    if (input.decision === "reject" && input.design_direction !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["design_direction"],
        message: "a rejection does not choose a design direction",
      });
    }
  });
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export const ChangeRequestInputSchema = z.strictObject({
  run: RunIdSchema.optional(),
  artifact: z.enum(["spec", "architecture", "design"]),
  summary: z.string().min(1).max(300),
  detail: z.string().min(1).max(8000),
});
export type ChangeRequestInput = z.infer<typeof ChangeRequestInputSchema>;

/** A CR becomes an escalation with reason `change_request` the human decides (§6.2). */
export const ChangeRequestResultSchema = z.strictObject({
  run: RunIdSchema,
  escalation: EscalationIdSchema,
});
export type ChangeRequestResult = z.infer<typeof ChangeRequestResultSchema>;

export const RunControlResultSchema = z.strictObject({
  run: RunIdSchema,
  paused: z.boolean(),
  phase: PhaseSchema,
});
export type RunControlResult = z.infer<typeof RunControlResultSchema>;

/** The run summary: `status` tool output and `GET /api/status` (for the active run). */
export const StatusResultSchema = z.strictObject({
  run: RunSchema,
  tasks_by_status: z.partialRecord(TaskStatusSchema, z.int().nonnegative()),
  parked: z.array(z.strictObject({ task: TaskIdSchema, reason: ParkReasonSchema })).default([]),
  open_escalations: z.int().nonnegative(),
  budget: z.strictObject({
    budget_usd: z.number().nonnegative(),
    spent_usd: z.number().nonnegative(),
  }),
  usage: UsageReportSchema,
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

/** Drill-down for one task (§17): the task, its findings, gate reports and escalations. */
export const TaskDetailSchema = z.strictObject({
  run: RunIdSchema,
  task: TaskSchema,
  plan_file: RelPathSchema,
  findings: z.array(FindingSchema).default([]),
  gate_reports: z.array(GateReportSchema).default([]),
  escalations: z.array(EscalationSchema).default([]),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

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
 * Localhost HTTP API (§15, AD-5): bound to 127.0.0.1 only, per-install token required on every
 * route, Host and Origin checked, no CORS headers ever. Read-only except two size-limited,
 * validated writes that cannot execute anything: the statusline ingest and design review pins.
 */
export const ENGINE_HTTP = {
  bindHost: "127.0.0.1",
  tokenHeader: "authorization",
  tokenScheme: "Bearer",
  /** Cookie set after the one-time `?token=` exchange so EventSource can authenticate. */
  sessionCookie: "vtc_session",
  routes: {
    health: { method: "GET", path: "/api/health", response: "HealthResult" },
    status: { method: "GET", path: "/api/status", response: "StatusResult" },
    runs: { method: "GET", path: "/api/runs", response: "RunList" },
    runEvents: { method: "GET", path: "/api/runs/:run/events", response: "EventPage" },
    tasks: { method: "GET", path: "/api/runs/:run/tasks", response: "TaskList" },
    task: { method: "GET", path: "/api/runs/:run/tasks/:task", response: "TaskDetail" },
    /** `?scope=project|task_dag|task&task=T-n` (§17 zoom levels). */
    graph: { method: "GET", path: "/api/runs/:run/graph", response: "WorkflowGraph" },
    escalations: { method: "GET", path: "/api/runs/:run/escalations", response: "EscalationList" },
    usage: { method: "GET", path: "/api/usage", response: "UsageReport" },
    /** SSE: each message is one Event; `id: <run>:<seq>` (`sseEventId`). */
    stream: { method: "GET", path: "/api/stream", response: "Event", sse: true },
    statuslineIngest: {
      method: "POST",
      path: "/api/ingest/claude-statusline",
      request: "StatuslineIngest",
      response: "IngestResult",
      maxBodyBytes: STATUSLINE_INGEST_MAX_BYTES,
    },
    designReviews: {
      method: "POST",
      path: "/api/design/reviews",
      request: "DesignReviewCommentInput",
      response: "DesignReviewResult",
      maxBodyBytes: DESIGN_REVIEW_MAX_BYTES,
    },
  },
} as const;
export type EngineHttpRouteName = keyof typeof ENGINE_HTTP.routes;
