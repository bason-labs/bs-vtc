/**
 * Engine surfaces other packages build against:
 * - the MCP tool surface the Lead calls (§4.2), with input/output schemas;
 * - the localhost HTTP/SSE routes the dashboard and the statusline shim call (§6.9, §15, §17).
 */
import { z } from "zod";
import { EscalationAnswerSchema } from "./escalation.js";
import {
  EscalationIdSchema,
  FeatureIdSchema,
  IsoDateTimeSchema,
  RelPathSchema,
  RoleIdSchema,
  RunIdSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
} from "./primitives.js";
import { TrackSchema } from "./project-config.js";
import { RoleResultSchema } from "./role-result.js";

// ------------------------------------------------------------------ MCP tools

/** Lead-facing MCP tools (server name `vtc`). Role-facing tools are added by later sub-projects. */
export const ENGINE_MCP_TOOLS = [
  {
    name: "start",
    purpose: "Start a run from an idea or change request; the engine classifies the track.",
  },
  {
    name: "next",
    purpose:
      "Return the next actions for the Lead: spawn a role, ask the human, approve a gate, wait, or done.",
  },
  {
    name: "submit",
    purpose:
      "Submit a role result for a dispatched action; validated, claim-checked and scope-checked.",
  },
  {
    name: "status",
    purpose: "Summarise the run: phase, tasks by state, parked items, budget and usage.",
  },
  {
    name: "escalations",
    purpose: "List open escalations (batched) with evidence, options and the recommended option.",
  },
  {
    name: "answer",
    purpose: "Record the human's answer to an escalation and resume the parked task.",
  },
  {
    name: "approve",
    purpose: "Record the human's decision on gate G1 (spec) or G2 (architecture + design).",
  },
  {
    name: "change_request",
    purpose: "Open a change request against a frozen artifact (spec, architecture or design).",
  },
  {
    name: "pause",
    purpose:
      "Kill switch: stop dispatching and merging; in-flight steps finish or are interrupted.",
  },
  {
    name: "resume",
    purpose: "Resume a paused or interrupted run, rebuilding state from the event log.",
  },
] as const;
export type EngineMcpToolName = (typeof ENGINE_MCP_TOOLS)[number]["name"];

export const GateIdSchema = z.enum(["G1", "G2"]);
export type GateId = z.infer<typeof GateIdSchema>;

export const RunScopedInputSchema = z.strictObject({ run: RunIdSchema.optional() });

export const StartInputSchema = z.strictObject({
  request: z.string().min(1).max(20000),
  /** Human override of the intake classification (§6.2). */
  track: TrackSchema.optional(),
});

/** One action from `next` (§4.2 step 1). The Lead only dispatches what the engine returns. */
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
    dispatch: z.enum(["subagent", "headless"]),
  }),
  z.strictObject({
    type: z.literal("ask_human"),
    escalations: z.array(EscalationIdSchema).min(1),
  }),
  z.strictObject({
    type: z.literal("approve_gate"),
    /** Quick-fix track combines G1 + G2 on one screen (§6.2). */
    gates: z.array(GateIdSchema).min(1).max(2),
    artifacts: z.array(RelPathSchema).min(1),
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

export const SubmitInputSchema = z.strictObject({
  action_id: SlugSchema,
  result: RoleResultSchema,
});
export type SubmitInput = z.infer<typeof SubmitInputSchema>;

export const AnswerInputSchema = z.strictObject({
  escalation: EscalationIdSchema,
  answer: EscalationAnswerSchema,
});
export type AnswerInput = z.infer<typeof AnswerInputSchema>;

export const ApproveInputSchema = z.strictObject({
  gates: z.array(GateIdSchema).min(1).max(2),
  decision: z.enum(["approve", "reject"]),
  /** Content hash of what was shown; the approved artifact freezes at this hash (§6.2). */
  artifact_sha256: Sha256HexSchema,
  note: z.string().max(4000).optional(),
});
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export const ChangeRequestInputSchema = z.strictObject({
  artifact: z.enum(["spec", "architecture", "design"]),
  summary: z.string().min(1).max(300),
  detail: z.string().min(1).max(8000),
});
export type ChangeRequestInput = z.infer<typeof ChangeRequestInputSchema>;

// --------------------------------------------------------------- HTTP / SSE

/**
 * Localhost HTTP API (§15): bound to 127.0.0.1 only, per-install token required, Host and
 * Origin checked. All routes are read-only except the statusline ingest.
 */
export const ENGINE_HTTP = {
  bindHost: "127.0.0.1",
  tokenHeader: "authorization",
  tokenScheme: "Bearer",
  /** Cookie set after the one-time `?token=` exchange so EventSource can authenticate. */
  sessionCookie: "vtc_session",
  routes: {
    health: { method: "GET", path: "/api/health" },
    status: { method: "GET", path: "/api/status" },
    runs: { method: "GET", path: "/api/runs" },
    runEvents: { method: "GET", path: "/api/runs/:run/events" },
    tasks: { method: "GET", path: "/api/runs/:run/tasks" },
    task: { method: "GET", path: "/api/runs/:run/tasks/:task" },
    graph: { method: "GET", path: "/api/runs/:run/graph" },
    escalations: { method: "GET", path: "/api/runs/:run/escalations" },
    usage: { method: "GET", path: "/api/usage" },
    stream: { method: "GET", path: "/api/stream" },
    statuslineIngest: { method: "POST", path: "/api/ingest/claude-statusline" },
  },
} as const;
