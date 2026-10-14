/**
 * Scorecards per prompt version (spec §13; AD-21 rule 5), committed at
 * `.vtc/lookback/scorecards/<role>/<host>/<sha8>/scorecard.json`, plus the index Flow Studio lists
 * (`.vtc/lookback/scorecards/index.json`). Pure computation over the events of the runs in the
 * window and the recorded attributions; {@link writeScorecards} does the IO.
 *
 * For each dispatch of a version (a trace), its window runs until the same role's next dispatch on
 * the same task:
 * - `first_round_gate_pass`: of first-round dispatches whose round gate ran in the window, the
 *   share that passed;
 * - `review_pass`: of `built` results, the share with no reviewer finding in the window;
 * - `rounds_to_done`: the mean round at which the version's tasks reached `done`;
 * - `escalations_per_100` / `cap_hits_per_100`: dispatches followed in their window by an
 *   escalation / a park on the round cap, per 100 dispatches;
 * - `tokens_per_success`: input plus output tokens per successful dispatch (submitted and not
 *   attributed a failure), over dispatches whose host reported tokens.
 * Proportions carry n and a Wilson interval; below `LOOKBACK_LIMITS.minScorecardN` a metric's
 * value is `null` ("insufficient data"). Engineer metrics also break down by discipline × stack
 * pack × host.
 */
import {
  isEventOfType,
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  parsePersisted,
  readEventData,
  ScorecardIndexSchema,
  ScorecardSchema,
  scorecardPath,
  wilsonInterval,
  type Attribution,
  type Discipline,
  type Scorecard,
  type ScorecardIndex,
  type ScorecardMetricId,
  type VtcEvent,
} from "@vtc/shared";
import { join } from "node:path";
import { isRoleFailure } from "./attribution.js";
import { readTextIfExists, writeAtomic } from "./files.js";
import { buildTraces, traceRef, type LockedShaFor, type Trace } from "./traces.js";

type MetricValue = NonNullable<Scorecard["metrics"][ScorecardMetricId]>;
type Metrics = Scorecard["metrics"];

const insufficient = (n: number): MetricValue => ({ value: null, ci_low: null, ci_high: null, n });

const proportion = (x: number, n: number, scale = 1): MetricValue | undefined => {
  if (n === 0) return undefined;
  if (n < LOOKBACK_LIMITS.minScorecardN) return insufficient(n);
  const { low, high } = wilsonInterval(x, n);
  return { value: (x / n) * scale, ci_low: low * scale, ci_high: high * scale, n };
};

const mean = (sum: number, n: number): MetricValue | undefined => {
  if (n === 0) return undefined;
  if (n < LOOKBACK_LIMITS.minScorecardN) return insufficient(n);
  return { value: sum / n, ci_low: null, ci_high: null, n };
};

/** What happened in one trace's window. */
interface TraceOutcome {
  readonly trace: Trace;
  readonly firstRound: boolean;
  /** The round gate's verdict in the window, if it ran. */
  readonly gatePassed?: boolean;
  readonly reviewFailed: boolean;
  readonly escalated: boolean;
  readonly capHit: boolean;
  readonly success: boolean;
}

interface TaskInfo {
  readonly discipline?: Discipline;
  readonly stackPacks: readonly string[];
  /** Round at which the task reached `done`. */
  doneRound?: number;
}

const taskKey = (run: string, task: string): string => `${run}:${task}`;

const outcomes = (
  events: readonly VtcEvent[],
  traces: readonly Trace[],
  failed: ReadonlySet<string>,
): TraceOutcome[] => {
  const byTask = new Map<string, VtcEvent[]>();
  for (const event of events) {
    if (event.task === undefined) continue;
    const key = taskKey(event.run, event.task);
    byTask.set(key, [...(byTask.get(key) ?? []), event]);
  }
  const seen = new Set<string>();
  return traces.map((trace, index) => {
    const success = trace.end?.kind === "submitted" && !failed.has(traceRef(trace));
    if (trace.task === undefined) {
      return {
        trace,
        firstRound: false,
        reviewFailed: false,
        escalated: false,
        capHit: false,
        success,
      };
    }
    const roleKey = `${taskKey(trace.run, trace.task)}:${trace.role}:${trace.mode ?? ""}`;
    const firstRound = !seen.has(roleKey);
    seen.add(roleKey);
    const next = traces
      .slice(index + 1)
      .find(
        (t) =>
          t.run === trace.run &&
          t.task === trace.task &&
          t.role === trace.role &&
          t.mode === trace.mode,
      );
    const until = next?.seq ?? Number.POSITIVE_INFINITY;
    const from = trace.end?.seq ?? trace.seq;
    const window = (byTask.get(taskKey(trace.run, trace.task)) ?? []).filter(
      (e) => e.seq > trace.seq && e.seq < until,
    );
    let gatePassed: boolean | undefined;
    let reviewFailed = false;
    let escalated = false;
    let capHit = false;
    for (const event of window) {
      if (isEventOfType(event, "gate.result") && event.seq > from && gatePassed === undefined) {
        const report = readEventData(event);
        if (report.reason === "round") gatePassed = report.verdict === "pass";
      } else if (isEventOfType(event, "finding.recorded") && event.seq > from) {
        if (readEventData(event).finding.source === "role") reviewFailed = true;
      } else if (isEventOfType(event, "escalation.opened")) {
        escalated = true;
      } else if (isEventOfType(event, "task.status_changed")) {
        const change = readEventData(event);
        if (change.to === "parked" && change.park_reason === "cap") capHit = true;
      }
    }
    return {
      trace,
      firstRound,
      ...(gatePassed === undefined ? {} : { gatePassed }),
      reviewFailed,
      escalated,
      capHit,
      success,
    };
  });
};

const metricsOf = (
  rows: readonly TraceOutcome[],
  tasks: ReadonlyMap<string, TaskInfo>,
): Metrics => {
  const metrics: Metrics = {};
  const set = (id: ScorecardMetricId, value: MetricValue | undefined): void => {
    if (value !== undefined) metrics[id] = value;
  };
  const gated = rows.filter((r) => r.firstRound && r.gatePassed !== undefined);
  set(
    "first_round_gate_pass",
    proportion(gated.filter((r) => r.gatePassed === true).length, gated.length),
  );
  const built = rows.filter((r) => r.trace.end?.exit === "built");
  set("review_pass", proportion(built.filter((r) => !r.reviewFailed).length, built.length));
  const doneRounds = new Map<string, number>();
  for (const r of rows) {
    if (r.trace.task === undefined) continue;
    const key = taskKey(r.trace.run, r.trace.task);
    const round = tasks.get(key)?.doneRound;
    if (round !== undefined) doneRounds.set(key, round);
  }
  set(
    "rounds_to_done",
    mean(
      [...doneRounds.values()].reduce((a, b) => a + b, 0),
      doneRounds.size,
    ),
  );
  const ended = rows.filter((r) => r.trace.end !== undefined);
  set(
    "escalations_per_100",
    proportion(ended.filter((r) => r.escalated).length, ended.length, 100),
  );
  set("cap_hits_per_100", proportion(ended.filter((r) => r.capHit).length, ended.length, 100));
  const priced = rows.filter(
    (r) => r.trace.end?.kind === "submitted" && r.trace.end.tokens !== null,
  );
  const successes = priced.filter((r) => r.success).length;
  set(
    "tokens_per_success",
    mean(
      priced.reduce((sum, r) => sum + (r.trace.end?.tokens ?? 0), 0),
      successes,
    ),
  );
  return metrics;
};

const taskInfo = (events: readonly VtcEvent[]): Map<string, TaskInfo> => {
  const tasks = new Map<string, TaskInfo>();
  for (const event of events) {
    if (isEventOfType(event, "task.created")) {
      const { task } = readEventData(event);
      tasks.set(taskKey(event.run, task.id), {
        discipline: task.discipline,
        stackPacks: task.stack_packs,
      });
    } else if (isEventOfType(event, "task.status_changed") && event.task !== undefined) {
      const change = readEventData(event);
      const info = tasks.get(taskKey(event.run, event.task));
      if (change.to === "done" && info !== undefined) info.doneRound = change.round;
    }
  }
  return tasks;
};

/** The scorecard of every prompt version the events dispatched. */
export const computeScorecards = (input: {
  readonly events: readonly VtcEvent[];
  readonly attributions: readonly Attribution[];
  readonly lockedShaFor: LockedShaFor;
  readonly graderBundleSha: string;
  readonly now: Date;
}): Scorecard[] => {
  const traces = buildTraces(input.events, input.lockedShaFor);
  const failed = new Set(input.attributions.filter(isRoleFailure).map(traceRef));
  const rows = outcomes(input.events, traces, failed);
  const tasks = taskInfo(input.events);
  const versions = new Map<string, TraceOutcome[]>();
  for (const row of rows) {
    const prompt = row.trace.prompt;
    if (prompt === undefined) continue;
    const key = `${prompt.role}:${prompt.mode ?? ""}:${prompt.host}:${prompt.effective_sha256}`;
    versions.set(key, [...(versions.get(key) ?? []), row]);
  }
  const cards: Scorecard[] = [];
  for (const group of versions.values()) {
    const prompt = group[0]?.trace.prompt;
    if (prompt === undefined) continue;
    const times = group.map((r) => r.trace.ts).sort();
    const breakdown: Scorecard["breakdown"] = [];
    if (prompt.role === "engineer") {
      const cells = new Map<
        string,
        { discipline?: Discipline; stack_pack?: string; rows: TraceOutcome[] }
      >();
      for (const row of group) {
        const info =
          row.trace.task === undefined
            ? undefined
            : tasks.get(taskKey(row.trace.run, row.trace.task));
        if (info?.discipline === undefined) continue;
        const packs = info.stackPacks.length > 0 ? info.stackPacks : [undefined];
        for (const pack of packs) {
          const key = `${info.discipline}:${pack ?? ""}`;
          const cell = cells.get(key) ?? {
            discipline: info.discipline,
            ...(pack === undefined ? {} : { stack_pack: pack }),
            rows: [],
          };
          cell.rows.push(row);
          cells.set(key, cell);
        }
      }
      for (const cell of cells.values()) {
        breakdown.push({
          ...(cell.discipline === undefined ? {} : { discipline: cell.discipline }),
          ...(cell.stack_pack === undefined ? {} : { stack_pack: cell.stack_pack }),
          host: prompt.host,
          metrics: metricsOf(cell.rows, tasks),
        });
      }
    }
    cards.push(
      ScorecardSchema.parse({
        v: 1,
        prompt,
        grader_bundle_sha: input.graderBundleSha,
        window: { from: times[0], to: times.at(-1) },
        metrics: metricsOf(group, tasks),
        breakdown,
        written_at: input.now.toISOString(),
      }),
    );
  }
  return cards;
};

/** Writes each scorecard at `scorecardPath` and merges them into the index. Returns the paths. */
export const writeScorecards = async (
  projectRoot: string,
  cards: readonly Scorecard[],
): Promise<string[]> => {
  const indexPath = join(projectRoot, LOOKBACK_REPO.scorecardIndex);
  const text = await readTextIfExists(indexPath);
  let index: ScorecardIndex = { v: 1, scorecards: [] };
  if (text !== undefined) {
    try {
      const parsed = parsePersisted(ScorecardIndexSchema, JSON.parse(text) as unknown);
      if (parsed.success) index = parsed.data;
    } catch {
      // A broken index is rebuilt from the cards written now.
    }
  }
  const paths: string[] = [];
  for (const card of cards) {
    const path = scorecardPath(card.prompt.role, card.prompt.host, card.prompt.effective_sha256);
    await writeAtomic(
      join(projectRoot, path),
      `${JSON.stringify(ScorecardSchema.parse(card), null, 2)}\n`,
    );
    paths.push(path);
    index = {
      v: 1,
      scorecards: [
        ...index.scorecards.filter((e) => e.path !== path),
        { prompt: card.prompt, path, written_at: card.written_at },
      ],
    };
  }
  await writeAtomic(indexPath, `${JSON.stringify(ScorecardIndexSchema.parse(index), null, 2)}\n`);
  return paths;
};
