import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EVENT_PAYLOAD_SCHEMAS,
  EventSchema,
  GateReportSchema,
  parseEventLog,
  ReplayResultSchema,
  UsageReportSchema,
  type CoreEventType,
  type GateReport,
  type ReplayResult,
  type UsageReport,
  type VtcEvent,
  type VtcEventInput,
} from "@vtc/shared";

/**
 * Engine core's recorded wave-3 samples (`fixtures/golden-run/samples/`): a short log of its own
 * run (`golden-wave3`), the `ReplayResult` its replay names, a gate report with a visual summary
 * and a usage report with each host's billing. Tests build on these instead of hand-written
 * samples; a case the samples lack is made by changing one sample event ({@link variant}), which
 * is checked against its contract, so it can never drift from what the engine may write.
 */
const dir = `${resolve(import.meta.dirname, "../../../fixtures/golden-run/samples")}/`;
const read = (name: string): string => readFileSync(`${dir}${name}`, "utf8");

/** The samples' run id. */
export const SAMPLE_RUN = "golden-wave3";

const log = parseEventLog(read("wave3-events.jsonl"));
if (log.invalidLines.length > 0) throw new Error("the golden wave-3 samples do not parse");

/** The recorded sample log, oldest first. */
export const SAMPLE_EVENTS: readonly VtcEvent[] = log.events;

/** The sample event with this `seq`. */
export const sample = (seq: number): VtcEvent => {
  const event = SAMPLE_EVENTS.find((e) => e.seq === seq);
  if (event === undefined) throw new Error(`no sample event ${String(seq)}`);
  return event;
};

/** Every sample event of `type`, oldest first. */
export const samplesOfType = (type: CoreEventType): VtcEvent[] =>
  SAMPLE_EVENTS.filter((e) => e.type === type);

/** The first sample event of `type`. */
export const firstSample = (type: CoreEventType): VtcEvent => {
  const [event] = samplesOfType(type);
  if (event === undefined) throw new Error(`no sample ${type} event`);
  return event;
};

/**
 * A copy of `base` at `seq` with `data` merged into its payload (and `envelope` into the event),
 * validated against the contract.
 */
export const variant = (
  base: VtcEvent,
  seq: number,
  data: Record<string, unknown> = {},
  envelope: Partial<VtcEventInput> = {},
): VtcEvent => {
  const merged = { ...(base.data as Record<string, unknown>), ...data };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  EVENT_PAYLOAD_SCHEMAS[base.type as CoreEventType].parse(merged);
  return EventSchema.parse({ ...base, seq, ...envelope, data: merged });
};

/** A new event of `type` in the sample run, validated against its contract. */
export const sampleEvent = (
  seq: number,
  type: CoreEventType,
  data: Record<string, unknown>,
  envelope: Partial<VtcEventInput> = {},
): VtcEvent => {
  EVENT_PAYLOAD_SCHEMAS[type].parse(data);
  return EventSchema.parse({
    v: 1,
    seq,
    ts: `2026-10-14T11:${String(seq % 60).padStart(2, "0")}:00.000Z`,
    run: SAMPLE_RUN,
    type,
    actor: "engine",
    data,
    ...envelope,
  });
};

/** `events` as one page of `GET /api/runs/:run/events`. */
export const samplePage = (events: readonly VtcEvent[] = SAMPLE_EVENTS, run = SAMPLE_RUN) => ({
  run,
  events: events.map((e) => ({ ...e, run })),
  next_after: null,
});

/** `replay-p-engineer-1.json`: the `ReplayResult` the sample `lookback.replay_finished` names. */
export const SAMPLE_REPLAY_TEXT = read("replay-p-engineer-1.json");
export const SAMPLE_REPLAY: ReplayResult = ReplayResultSchema.parse(JSON.parse(SAMPLE_REPLAY_TEXT));

/** `gate-report-visual.json`: a gate report whose visual summary names its toolchain. */
export const SAMPLE_GATE_REPORT: GateReport = GateReportSchema.parse(
  JSON.parse(read("gate-report-visual.json")),
);

/** `usage-billing.json`: a usage report with each host's billing (D-bq). */
export const SAMPLE_USAGE: UsageReport = UsageReportSchema.parse(
  JSON.parse(read("usage-billing.json")),
);
