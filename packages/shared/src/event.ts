/**
 * Event contract (§6.8, §16). One JSON object per line in `.vtc/runs/<run>/events.jsonl`.
 * The log is append-only and is the source of truth; the SQLite index is rebuilt from it.
 */
import { z } from "zod";
import {
  EVENT_ENVELOPE_REQUIREMENTS,
  EVENT_PAYLOAD_SCHEMAS,
  isCoreEventType,
  validateEventData,
  type CoreEventType,
  type EventData,
} from "./event-payloads.js";
import { parsePersisted } from "./persisted.js";
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
 * The core event vocabulary, each with a typed payload (`EVENT_PAYLOAD_SCHEMAS`). The set is
 * open: sub-projects add types (as a MINOR contract change), and consumers ignore types they do
 * not know.
 */
export const CORE_EVENT_TYPES = Object.keys(EVENT_PAYLOAD_SCHEMAS) as CoreEventType[];

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
    /** Typed per core type (`EVENT_PAYLOAD_SCHEMAS`); free-form for other types. */
    data: z.record(z.string(), z.unknown()).default({}),
    prompt_sha: Sha256HexSchema.optional(),
    host: HostIdSchema.optional(),
    model: z.string().min(1).max(200).optional(),
    /** `null` = the host did not report spend (counted as unknown, never 0). */
    tokens: TokenUsageSchema.nullable().optional(),
    /** List-price-equivalent USD (§11). `null` = model missing from the price table (an error, never $0). */
    cost_usd: z.number().nonnegative().nullable().optional(),
  })
  .superRefine((event, ctx) => {
    if (event.actor === "role" && event.role === undefined) {
      ctx.addIssue({ code: "custom", path: ["role"], message: "role events must name the role" });
    }
    if (!isCoreEventType(event.type)) return;
    for (const field of EVENT_ENVELOPE_REQUIREMENTS[event.type] ?? []) {
      if (event[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${event.type} events must carry ${field}`,
        });
      }
    }
    const check = validateEventData(event.type, event.data);
    if (!check.ok) {
      // Keep each issue's code (e.g. `unrecognized_keys`), so `parsePersisted` can tell a field a
      // newer writer added from a real error.
      for (const issue of check.issues) ctx.addIssue({ ...issue, path: ["data", ...issue.path] });
    }
  });
export type VtcEvent = z.infer<typeof EventSchema>;
export type VtcEventInput = z.input<typeof EventSchema>;

/** Relative location of a run's event log (§4.3). */
export const eventLogPath = (run: string): string =>
  `.vtc/runs/${RunIdSchema.parse(run)}/events.jsonl`;

/**
 * `.vtc/runs/<run>/request.md`: the engine's projection of `run.started.request` (git-tracked,
 * regenerated from the log, never read back as input, like plan-file frontmatter, AD-7 rule 8).
 */
export const runRequestPath = (run: string): string =>
  `.vtc/runs/${RunIdSchema.parse(run)}/request.md`;

/**
 * `.vtc/runs/<run>/attachments/<n>-<name>`: the engine's copy of the request's `n`-th attachment
 * (1-based, `StartInput.attachments`, spine §5 reading 262), git-tracked with the run like
 * `request.md`. `name` is the file's base name reduced to `[A-Za-z0-9._-]` (at most 80 characters).
 */
export const runAttachmentPath = (run: string, n: number, sourcePath: string): string => {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`attachment number ${String(n)}`);
  const base = sourcePath.split(/[\\/]/).pop() ?? "";
  const name =
    base
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "")
      .slice(-80) || "attachment";
  return `.vtc/runs/${RunIdSchema.parse(run)}/attachments/${String(n)}-${name}`;
};

/** Serialises one event as a JSONL line (validated, trailing newline). */
export const toEventLine = (event: VtcEventInput): string =>
  `${JSON.stringify(EventSchema.parse(event))}\n`;

export interface ParsedEventLog {
  readonly events: VtcEvent[];
  /** 1-based line numbers that failed to parse or validate. */
  readonly invalidLines: number[];
  /**
   * 1-based line numbers that parsed only after dropping keys this version does not know (a
   * field a newer MINOR vtc added, AD-3 rule 2). Not corruption: replay uses the event.
   */
  readonly strippedLines: number[];
  /** True when the last line had no trailing newline (a torn write after a crash). */
  readonly truncatedTail: boolean;
}

/**
 * Parses a JSONL event log. Blank lines are skipped; invalid lines are reported, never
 * thrown, so replay can surface an incident instead of crashing (§15 incident reports). A reader
 * of persisted data, so unknown keys are dropped, not errors (`parsePersisted`, AD-3 rule 2).
 */
export const parseEventLog = (text: string): ParsedEventLog => {
  const events: VtcEvent[] = [];
  const invalidLines: number[] = [];
  const strippedLines: number[] = [];
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
    const parsed = parsePersisted(EventSchema, raw);
    if (!parsed.success) {
      invalidLines.push(index + 1);
      return;
    }
    events.push(parsed.data);
    if (parsed.stripped.length > 0) strippedLines.push(index + 1);
  });
  return { events, invalidLines, strippedLines, truncatedTail };
};

/** Narrows an event to a core type, so `data` can be read with {@link readEventData}. */
export const isEventOfType = <T extends CoreEventType>(
  event: VtcEvent,
  type: T,
): event is VtcEvent & { type: T } => event.type === type;

/** The typed payload of a core event (defaults applied). Throws if the payload is invalid. */
export const readEventData = <T extends CoreEventType>(
  event: VtcEvent & { type: T },
): EventData<T> => EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.data) as EventData<T>;

// ------------------------------------------------------------------ SSE ids

/** SSE message id for an event (AD-5 rule 6): `<run>:<seq>`. */
export const sseEventId = (run: string, seq: number): string => {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError("seq must be a positive integer");
  return `${RunIdSchema.parse(run)}:${String(seq)}`;
};

/** Parses a `Last-Event-ID` header; `null` when it is not a valid `<run>:<seq>`. */
export const parseSseEventId = (id: string): { run: string; seq: number } | null => {
  const at = id.lastIndexOf(":");
  if (at <= 0) return null;
  const run = RunIdSchema.safeParse(id.slice(0, at));
  const digits = id.slice(at + 1);
  if (!run.success || !/^[1-9]\d{0,15}$/.test(digits)) return null;
  return { run: run.data, seq: Number(digits) };
};
