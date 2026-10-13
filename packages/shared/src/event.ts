/**
 * Event contract (§6.8, §16). One JSON object per line in `.vtc/runs/<run>/events.jsonl`.
 * The log is append-only and is the source of truth; the SQLite index is rebuilt from it.
 */
import { z } from "zod";
import {
  FeatureIdSchema,
  HostIdSchema,
  IsoDateTimeSchema,
  RoleIdSchema,
  RunIdSchema,
  Sha256HexSchema,
  TaskIdSchema,
  TokenUsageSchema,
} from "./primitives.js";

/** Event log format version. A breaking change to this schema bumps it. */
export const EVENT_SCHEMA_VERSION = 1;

/** Dotted lower-case type, `<entity>.<verb>`, e.g. `task.status_changed`. */
export const EventTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    "expected a dotted event type like task.status_changed",
  );
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * The initial event vocabulary. The set is open (new sub-projects add types without a schema
 * bump), so consumers must ignore types they do not know.
 */
export const CORE_EVENT_TYPES = [
  "run.started",
  "run.resumed",
  "run.paused",
  "run.finished",
  "gate.approved",
  "task.created",
  "task.status_changed",
  "feature.status_changed",
  "role.dispatched",
  "role.submitted",
  "role.rejected",
  "gate.result",
  "finding.recorded",
  "finding.status_changed",
  "escalation.opened",
  "escalation.answered",
  "budget.updated",
  "usage.updated",
  "limit.hit",
  "merge.completed",
  "incident.recorded",
] as const satisfies readonly EventType[];

export const EventActorSchema = z.enum(["engine", "role", "human"]);
export type EventActor = z.infer<typeof EventActorSchema>;

export const EventSchema = z
  .strictObject({
    v: z.literal(EVENT_SCHEMA_VERSION),
    /** Per-run monotonic sequence number, starting at 1. Also the SSE event id. */
    seq: z.int().positive(),
    ts: IsoDateTimeSchema,
    run: RunIdSchema,
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    type: EventTypeSchema,
    actor: EventActorSchema,
    /** Required when actor is `role`. */
    role: RoleIdSchema.optional(),
    data: z.record(z.string(), z.unknown()).default({}),
    prompt_sha: Sha256HexSchema.optional(),
    host: HostIdSchema.optional(),
    model: z.string().min(1).max(200).optional(),
    tokens: TokenUsageSchema.optional(),
    /** List-price-equivalent USD (§11). `null` = model missing from the price table (an error, never $0). */
    cost_usd: z.number().nonnegative().nullable().optional(),
  })
  .superRefine((event, ctx) => {
    if (event.actor === "role" && event.role === undefined) {
      ctx.addIssue({ code: "custom", path: ["role"], message: "role events must name the role" });
    }
  });
export type VtcEvent = z.infer<typeof EventSchema>;
export type VtcEventInput = z.input<typeof EventSchema>;

/** Relative location of a run's event log (§4.3). */
export const eventLogPath = (run: string): string =>
  `.vtc/runs/${RunIdSchema.parse(run)}/events.jsonl`;

/** Serialises one event as a JSONL line (validated, trailing newline). */
export const toEventLine = (event: VtcEventInput): string =>
  `${JSON.stringify(EventSchema.parse(event))}\n`;

export interface ParsedEventLog {
  readonly events: VtcEvent[];
  /** 1-based line numbers that failed to parse or validate. */
  readonly invalidLines: number[];
  /** True when the last line had no trailing newline (a torn write after a crash). */
  readonly truncatedTail: boolean;
}

/**
 * Parses a JSONL event log. Blank lines are skipped; invalid lines are reported, never
 * thrown, so replay can surface an incident instead of crashing (§15 incident reports).
 */
export const parseEventLog = (text: string): ParsedEventLog => {
  const events: VtcEvent[] = [];
  const invalidLines: number[] = [];
  const lines = text.split("\n");
  const truncatedTail = text.length > 0 && !text.endsWith("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      invalidLines.push(index + 1);
      return;
    }
    const parsed = EventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else invalidLines.push(index + 1);
  });
  return { events, invalidLines, truncatedTail };
};
