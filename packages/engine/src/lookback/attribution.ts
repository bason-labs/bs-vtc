/**
 * Attribution (spec §13; AD-21): which role's dispatch a failure belongs to. Pure over a run's
 * events; the result is appended to `.vtc/lookback/attributions.jsonl` (one `Attribution` per
 * line) by {@link appendAttributions}.
 *
 * 1. **Human labels** at escalation (`escalation.answered.who_should_have_caught`) are the gold
 *    standard: they replace the tree for the escalation's task (`none` blames nobody).
 * 2. **The deterministic tree** (`ATTRIBUTION_TREE`) otherwise. Signals, mapped onto its rules:
 *    - a finding routed `spec_gap` → `missing_req` (BA);
 *    - a `test_adequacy` finding → `req_without_test` (QA);
 *    - a finding routed `bad_test`, a reviewer's `patch` finding (the tests passed, the behaviour
 *      is wrong) or an escaped defect (`lookback.escaped_defect`) → `test_passes_behaviour_wrong`
 *      (QA, Engineer secondary);
 *    - a failed product gate run (round, merge queue, Final Review) or a tool's `patch` finding →
 *      `test_fails` (Engineer).
 *    Credit goes to the first failure upstream: per task, the most upstream rule wins.
 * 3. A task that parked on its round cap or as stuck with no signal is **inconclusive**: it is
 *    returned for an AI tiebreak (method `ai_tiebreak`, with an "unknown" answer allowed).
 *
 * The blamed dispatch is the blamed role's latest dispatch on the task before the failure (or in
 * the run, for roles that work before tasks exist, like the BA). Only failures are recorded; the
 * scorecards count successes from the events.
 */
import {
  ATTRIBUTION_TREE,
  AttributionSchema,
  eventLogPath,
  isEventOfType,
  LOOKBACK_REPO,
  parsePersisted,
  readEventData,
  splitForTrace,
  type Attribution,
  type AttributionRule,
  type Evidence,
  type VtcEvent,
} from "@vtc/shared";
import { join } from "node:path";
import { appendJsonLines, readJsonLines } from "./files.js";
import { buildTraces, traceRef, type LockedShaFor, type Trace } from "./traces.js";

/** Rules from the most upstream (BA) to the most downstream (Engineer). */
export const RULES_UPSTREAM_FIRST: readonly AttributionRule[] = [
  "missing_req",
  "req_without_test",
  "test_passes_behaviour_wrong",
  "test_fails",
];

/** Confidence of a tree attribution: one rule fired, or several and the upstream one won. */
export const TREE_CONFIDENCE = { single: 1, contested: 0.7 } as const;

const GATE_REASONS = new Set(["round", "merge_queue", "final_review"]);

export interface FailureSignal {
  readonly run: string;
  readonly seq: number;
  readonly task?: string;
  readonly feature?: string;
  /** `null`: the tree cannot say (an AI tiebreak may). */
  readonly rule: AttributionRule | null;
  readonly what: string;
  readonly evidence: readonly Evidence[];
}

interface HumanLabel {
  readonly run: string;
  readonly seq: number;
  readonly task?: string;
  readonly feature?: string;
  readonly role: string;
}

const at = (event: VtcEvent): Evidence => ({
  type: "log_line",
  ref: `${eventLogPath(event.run)}#seq=${String(event.seq)}`,
});

const scope = (
  event: VtcEvent,
  task?: string,
  feature?: string,
): { run: string; seq: number; task?: string; feature?: string } => {
  const t = task ?? event.task;
  const f = feature ?? event.feature;
  return {
    run: event.run,
    seq: event.seq,
    ...(t === undefined ? {} : { task: t }),
    ...(f === undefined ? {} : { feature: f }),
  };
};

/** The failure signals of a run, in log order. */
export const failureSignals = (events: readonly VtcEvent[]): FailureSignal[] => {
  const signals: FailureSignal[] = [];
  for (const event of events) {
    if (isEventOfType(event, "gate.result")) {
      const report = readEventData(event);
      const product = report.results.some(
        (r) =>
          r.blocking &&
          (r.status === "fail" || r.status === "error") &&
          r.failure_class === "product",
      );
      if (report.verdict === "fail" && product && GATE_REASONS.has(report.reason)) {
        signals.push({
          ...scope(event, report.task, report.feature),
          rule: "test_fails",
          what: `gate run (${report.reason}) failed`,
          evidence: [at(event)],
        });
      }
    } else if (isEventOfType(event, "finding.recorded")) {
      const { finding } = readEventData(event);
      let rule: AttributionRule | undefined;
      if (finding.route === "spec_gap") rule = "missing_req";
      else if (finding.category === "test_adequacy") rule = "req_without_test";
      else if (finding.route === "bad_test") rule = "test_passes_behaviour_wrong";
      else if (finding.route === "patch")
        rule = finding.source === "role" ? "test_passes_behaviour_wrong" : "test_fails";
      if (rule !== undefined) {
        signals.push({
          ...scope(event, finding.task, finding.feature),
          rule,
          what: `finding ${finding.rule_id} (${finding.route})`,
          evidence: [at(event), finding.evidence],
        });
      }
    } else if (isEventOfType(event, "lookback.escaped_defect")) {
      const defect = readEventData(event);
      const tasks = defect.tasks.length > 0 ? defect.tasks : [undefined];
      for (const task of tasks) {
        signals.push({
          ...scope(event, task),
          rule: "test_passes_behaviour_wrong",
          what: `escaped defect (${defect.kind})`,
          evidence: [at(event), { type: "commit", ref: defect.merge_commit }],
        });
      }
    } else if (isEventOfType(event, "task.status_changed")) {
      const change = readEventData(event);
      if (
        change.to === "parked" &&
        (change.park_reason === "cap" || change.park_reason === "stuck")
      ) {
        signals.push({
          ...scope(event),
          rule: null,
          what: `parked (${change.park_reason})`,
          evidence: [at(event)],
        });
      }
    }
  }
  return signals;
};

/** Human attribution labels from answered escalations. */
export const humanLabels = (events: readonly VtcEvent[]): HumanLabel[] => {
  const opened = new Map<string, { task?: string; feature?: string }>();
  const labels: HumanLabel[] = [];
  for (const event of events) {
    if (isEventOfType(event, "escalation.opened")) {
      const { escalation } = readEventData(event);
      opened.set(escalation.id, {
        ...(escalation.task === undefined ? {} : { task: escalation.task }),
        ...(escalation.feature === undefined ? {} : { feature: escalation.feature }),
      });
    } else if (isEventOfType(event, "escalation.answered")) {
      const data = readEventData(event);
      const where = opened.get(data.escalation) ?? {};
      labels.push({
        run: event.run,
        seq: event.seq,
        ...where,
        role: data.answer.who_should_have_caught,
      });
    }
  }
  return labels;
};

/** The blamed role's latest dispatch on the task before `seq`, else its latest in the run. */
const blamedTrace = (
  traces: readonly Trace[],
  role: string,
  task: string | undefined,
  seq: number,
): Trace | undefined => {
  const before = traces.filter((t) => t.role === role && t.seq < seq);
  return before.filter((t) => task !== undefined && t.task === task).at(-1) ?? before.at(-1);
};

export interface AttributionResult {
  readonly attributions: Attribution[];
  /** Failures the tree could not attribute, for an AI tiebreak. */
  readonly inconclusive: FailureSignal[];
  /** Failures whose blamed dispatch has no prompt version (recorded before contracts 4.5.0). */
  readonly unversioned: number;
}

/** Attributes the failures of one run's events (pure). */
export const attributeRun = (input: {
  readonly events: readonly VtcEvent[];
  readonly lockedShaFor: LockedShaFor;
  readonly now: Date;
  /** `traceRef`s already attributed (a re-run after a restart adds nothing twice). */
  readonly already?: ReadonlySet<string>;
}): AttributionResult => {
  const traces = buildTraces(input.events, input.lockedShaFor);
  const signals = failureSignals(input.events);
  const labels = humanLabels(input.events);
  const attributedAt = input.now.toISOString();
  const out = new Map<string, Attribution>();
  const inconclusive: FailureSignal[] = [];
  let unversioned = 0;

  const record = (
    trace: Trace | undefined,
    fields: Pick<Attribution, "blamed_role" | "method" | "confidence" | "evidence"> &
      Partial<Pick<Attribution, "rule" | "secondary_role">>,
  ): void => {
    if (
      trace === undefined ||
      out.has(traceRef(trace)) ||
      input.already?.has(traceRef(trace)) === true
    )
      return;
    if (trace.prompt === undefined) {
      unversioned += 1;
      return;
    }
    out.set(
      traceRef(trace),
      AttributionSchema.parse({
        v: 1,
        trace: trace.trace,
        run: trace.run,
        ...(trace.task === undefined ? {} : { task: trace.task }),
        ...(trace.feature === undefined ? {} : { feature: trace.feature }),
        prompt: trace.prompt,
        outcome: "failure",
        split: splitForTrace(trace.trace),
        attributed_at: attributedAt,
        ...fields,
        evidence: fields.evidence.slice(0, 20),
      }),
    );
  };

  const groups = new Map<string, FailureSignal[]>();
  for (const signal of signals) {
    const key = signal.task ?? (signal.feature === undefined ? "run" : `feature:${signal.feature}`);
    groups.set(key, [...(groups.get(key) ?? []), signal]);
  }

  for (const [key, group] of groups) {
    const scoped = labels.filter((l) =>
      l.task !== undefined
        ? l.task === key
        : l.feature !== undefined && `feature:${l.feature}` === key,
    );
    if (scoped.length > 0) {
      for (const label of scoped) {
        if (label.role === "none") continue;
        record(blamedTrace(traces, label.role, label.task, label.seq), {
          blamed_role: label.role,
          method: "human",
          confidence: 1,
          evidence: [
            { type: "log_line", ref: `${eventLogPath(label.run)}#seq=${String(label.seq)}` },
          ],
        });
      }
      continue;
    }
    const rules = RULES_UPSTREAM_FIRST.filter((rule) => group.some((s) => s.rule === rule));
    const rule = rules[0];
    if (rule === undefined) {
      inconclusive.push(...group);
      continue;
    }
    const first = group.find((s) => s.rule === rule);
    if (first === undefined) continue;
    const blame = ATTRIBUTION_TREE[rule];
    record(blamedTrace(traces, blame.primary, first.task, first.seq), {
      blamed_role: blame.primary,
      ...(blame.secondary === null ? {} : { secondary_role: blame.secondary }),
      method: "tree",
      rule,
      confidence: rules.length === 1 ? TREE_CONFIDENCE.single : TREE_CONFIDENCE.contested,
      evidence: group.filter((s) => s.rule === rule).flatMap((s) => s.evidence),
    });
  }
  return { attributions: [...out.values()], inconclusive, unversioned };
};

/** An AI tiebreak's answer for an inconclusive failure (`unknown` blames nobody). */
export const tiebreakAttribution = (input: {
  readonly trace: Trace;
  /** The role the tiebreak blamed, or `unknown`. */
  readonly blamed: string;
  readonly confidence: number;
  readonly evidence: readonly Evidence[];
  readonly now: Date;
}): Attribution | undefined => {
  if (input.trace.prompt === undefined) return undefined;
  return AttributionSchema.parse({
    v: 1,
    trace: input.trace.trace,
    run: input.trace.run,
    ...(input.trace.task === undefined ? {} : { task: input.trace.task }),
    ...(input.trace.feature === undefined ? {} : { feature: input.trace.feature }),
    prompt: input.trace.prompt,
    outcome: "failure",
    blamed_role: input.blamed === "unknown" ? null : input.blamed,
    method: "ai_tiebreak",
    confidence: input.confidence,
    split: splitForTrace(input.trace.trace),
    evidence: input.evidence.slice(0, 20),
    attributed_at: input.now.toISOString(),
  });
};

/** Absolute path of the project's attributions file. */
export const attributionsPath = (projectRoot: string): string =>
  join(projectRoot, LOOKBACK_REPO.attributions);

/** Every recorded attribution (lines that do not validate are skipped). */
export const readAttributions = async (projectRoot: string): Promise<Attribution[]> => {
  const rows: Attribution[] = [];
  for (const value of await readJsonLines(attributionsPath(projectRoot))) {
    const parsed = parsePersisted(AttributionSchema, value);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
};

/** Appends attributions (validated). */
export const appendAttributions = async (
  projectRoot: string,
  rows: readonly Attribution[],
): Promise<void> => {
  await appendJsonLines(
    attributionsPath(projectRoot),
    rows.map((row) => AttributionSchema.parse(row)),
  );
};
