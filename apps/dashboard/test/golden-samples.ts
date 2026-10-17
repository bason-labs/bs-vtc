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

/** The time of a made event: after every sample, one minute per seq. */
const madeAt = (seq: number): string =>
  `2026-10-14T11:${String(seq % 60).padStart(2, "0")}:00.000Z`;

/**
 * A copy of `base` at `seq` (and a later time) with `data` merged into its payload (an
 * `undefined` value drops the key) and `envelope` into the event, validated against the contract.
 */
export const variant = (
  base: VtcEvent,
  seq: number,
  data: Record<string, unknown> = {},
  envelope: Partial<VtcEventInput> = {},
): VtcEvent => {
  const merged = Object.fromEntries(
    Object.entries({ ...base.data, ...data }).filter(([, v]) => v !== undefined),
  );
  EVENT_PAYLOAD_SCHEMAS[base.type as CoreEventType].parse(merged);
  return EventSchema.parse({ ...base, seq, ts: madeAt(seq), ...envelope, data: merged });
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
    ts: madeAt(seq),
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

/** Seq offset of the samples when they are appended to the golden run's own log. */
export const SAMPLE_SEQ_OFFSET = 100;

const goldenPage = JSON.parse(readFileSync(`${dir}../api/events.json`, "utf8")) as {
  run: string;
  events: VtcEvent[];
  next_after: number | null;
};
if (goldenPage.events.some((e) => e.seq >= SAMPLE_SEQ_OFFSET))
  throw new Error("the golden run's log reaches the sample offset");

/** A sample event as it reads in the golden run's log (`golden-1`, seq + {@link SAMPLE_SEQ_OFFSET}). */
export const inGoldenRun = (event: VtcEvent): VtcEvent =>
  EventSchema.parse({ ...event, run: goldenPage.run, seq: event.seq + SAMPLE_SEQ_OFFSET });

/**
 * The golden run's event page (`golden-1`) with the samples (all but their `run.started`)
 * and `extra` appended, re-keyed to the golden run with seq + {@link SAMPLE_SEQ_OFFSET}, for the
 * views that also need the golden run's graph, status and features.
 */
export const goldenPageWithSamples = (
  samples: readonly VtcEvent[] = SAMPLE_EVENTS,
  extra: readonly VtcEvent[] = [],
) => ({
  ...goldenPage,
  events: [
    ...goldenPage.events,
    ...[...samples, ...extra].filter((e) => e.type !== "run.started").map(inGoldenRun),
  ],
});

// ------------------------------------------- cases the samples lack, from a sample

/**
 * Engine-launched runs beside the sample's `a-7` (done): `a-12`, an Engineer run that ended on
 * the idle timeout, and `a-13`, a QA run resuming a session with no end recorded yet.
 */
export const HEADLESS_VARIANTS: readonly VtcEvent[] = [
  variant(firstSample("headless.started"), 40, { action_id: "a-12" }),
  variant(firstSample("headless.ended"), 41, {
    action_id: "a-12",
    outcome: "error",
    cause: "idle",
    exit_code: null,
    duration_ms: 615_000,
  }),
  variant(
    firstSample("headless.started"),
    42,
    { action_id: "a-13", pid: null, resume: { host: "codex", id: "sess-9" } },
    { role: "qa", task: "T-2" },
  ),
];

const preflight = firstSample("merge.preflight");
const checklist = firstSample("feature.checklist");
const SHA40 = (c: string): string => c.repeat(40);

/**
 * Level-3 outcomes beside the samples' passing preflight and checklist: a preflight that fell to
 * Level 2, a checklist whose Final Review item fails, a red base CI after the merge and a revert.
 */
export const LEVEL3_VARIANTS = {
  failedPreflight: variant(preflight, 30, {
    effective_level: 2,
    ok: false,
    failed: ["no_required_checks", "auto_merge_disallowed"],
    policy: {
      ...(preflight.data as { policy: object }).policy,
      auto_merge_allowed: false,
      required_checks: [],
    },
  }),
  failedChecklist: variant(checklist, 31, {
    ok: false,
    items: (
      checklist.data as {
        items: { id: string; ok: boolean; detail: string; evidence: unknown[] }[];
      }
    ).items.map((i) =>
      i.id === "final_review"
        ? { ...i, ok: false, detail: "Final Review pass; gates green; visual skipped" }
        : i.id === "remote_ci"
          ? { ...i, evidence: [{ type: "url", ref: "https://github.com/o/r/pull/12" }] }
          : i,
    ),
  }),
  postMergeRed: sampleEvent(
    32,
    "feature.post_merge_ci",
    {
      merge_commit: SHA40("e"),
      status: "red",
      runs: [{ name: "ci / test", conclusion: "failure", required: true }],
    },
    { feature: "F-1" },
  ),
  reverted: sampleEvent(
    33,
    "feature.reverted",
    {
      merge_commit: SHA40("e"),
      revert: { commit: SHA40("f"), detected_by: "git_log" },
      detail: "Revert of the F-1 merge found on main",
    },
    { feature: "F-1" },
  ),
} as const;

/** An auto-resume that did not start because the host is logged out. */
export const AUTH_PREFLIGHT = variant(
  samplesOfType("headless.preflight").find((e) => !(e.data as { ok: boolean }).ok) ??
    firstSample("headless.preflight"),
  43,
  { purpose: "auto_resume", failed: "auth", detail: "codex login status: not logged in" },
  { role: undefined },
);
