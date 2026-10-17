/**
 * Attribution (spec §13; AD-21): which role's dispatch a failure belongs to. Pure over a run's
 * events; the result is appended to `.vtc/lookback/attributions.jsonl` (one `Attribution` per
 * line) by {@link appendAttributions}.
 *
 * 1. **Human labels** at escalation (`escalation.answered.who_should_have_caught`) are the gold
 *    standard: they replace the tree for the escalation's task, feature or run (`none` blames
 *    nobody), and a labelled escalation is a failure of its own even with no other signal.
 * 2. **The deterministic tree** (`ATTRIBUTION_TREE`) otherwise. Signals, mapped onto its rules:
 *    - a finding routed `spec_gap` → `missing_req` (BA);
 *    - a `test_adequacy` finding → `req_without_test` (QA);
 *    - a finding routed `bad_test` or of kind `test_defect`, an escaped defect
 *      (`lookback.escaped_defect`), or a reviewer's `patch` finding about behaviour (`correctness`,
 *      `spec_mismatch`) after the task's latest gate run passed (the tests pass, the behaviour is
 *      wrong) → `test_passes_behaviour_wrong` (QA, Engineer secondary);
 *    - a failed product gate run (round, merge queue, Final Review), a tool's `patch` finding, and
 *      any other `patch` finding (the gate failed or never ran, or it is not about behaviour:
 *      maintainability, docs, performance…) → `test_fails` (Engineer).
 *    Credit goes to the first failure upstream: per task, the most upstream rule wins.
 * 3. A task that parked on its round cap or as stuck with no signal is **inconclusive**: it is
 *    returned for an AI tiebreak (method `ai_tiebreak`, with an "unknown" answer allowed).
 *
 * The blamed dispatch is the blamed role's latest dispatch on the task before the failure (or, for
 * roles that work before tasks exist, like the BA, its latest dispatch with no task). A failure
 * whose blamed role has no such dispatch is inconclusive: a dispatch on another task never takes
 * the blame. Only failures are recorded; the scorecards count successes from the events.
 */
import {
  ATTRIBUTION_TREE,
  AttributionSchema,
  eventLogPath,
  isEventOfType,
  LOOKBACK_REPO,
  parsePersisted,
  lookbackTiebreakKey,
  readEventData,
  type Attribution,
  type AttributionRule,
  type Evidence,
  type VtcEvent,
} from "@vtc/shared";
import { join } from "node:path";
import { appendRepoJsonLines, readRoleWrittenText } from "./files.js";
import { buildTraces, traceRef, traceSplit, type LockedShaFor, type Trace } from "./traces.js";

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

/** Finding categories about behaviour: only these can mean "the tests pass, the behaviour is wrong". */
const BEHAVIOUR_CATEGORIES = new Set(["correctness", "spec_mismatch"]);

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
  /** The verdict of each task's latest gate run so far (`run:task`). */
  const lastGatePassed = new Map<string, boolean>();
  for (const event of events) {
    if (isEventOfType(event, "gate.result")) {
      const report = readEventData(event);
      const gatedTask = report.task ?? event.task;
      if (gatedTask !== undefined)
        lastGatePassed.set(`${event.run}:${gatedTask}`, report.verdict === "pass");
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
      const task = finding.task ?? event.task;
      const gatePassed =
        task === undefined ? undefined : lastGatePassed.get(`${event.run}:${task}`);
      let rule: AttributionRule | undefined;
      if (finding.route === "spec_gap") rule = "missing_req";
      else if (finding.category === "test_adequacy") rule = "req_without_test";
      else if (finding.route === "bad_test" || finding.kind === "test_defect")
        rule = "test_passes_behaviour_wrong";
      else if (finding.route === "patch") {
        const behaviourWrong =
          finding.source === "role" &&
          BEHAVIOUR_CATEGORIES.has(finding.category) &&
          gatePassed === true;
        rule = behaviourWrong ? "test_passes_behaviour_wrong" : "test_fails";
      }
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
      // autopilot's choice is the engine's, not a human's label (spine §5 reading 271)
      if (data.autopilot === true) continue;
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

/** Signals and labels group by task, else feature, else the run. */
const groupKey = (s: { readonly task?: string; readonly feature?: string }): string =>
  s.task ?? (s.feature === undefined ? "run" : `feature:${s.feature}`);

/**
 * The blamed role's dispatch for a failure at `scope` before `seq`: its latest on the failure's
 * task (or, for a feature-scoped failure, in the feature; for a run-scoped one, in the run), else
 * its latest dispatch with no task (roles that work before tasks exist, like the BA) of the same
 * feature or none. A dispatch on another task never takes the blame: `undefined` then.
 */
const blamedTrace = (
  traces: readonly Trace[],
  role: string,
  scope: { readonly task?: string; readonly feature?: string },
  seq: number,
): Trace | undefined => {
  const before = traces.filter((t) => t.role === role && t.seq < seq);
  if (scope.task === undefined && scope.feature === undefined) return before.at(-1);
  const inScope =
    scope.task !== undefined
      ? before.filter((t) => t.task === scope.task).at(-1)
      : before.filter((t) => t.feature === scope.feature).at(-1);
  return (
    inScope ??
    before
      .filter(
        (t) =>
          t.task === undefined &&
          (t.feature === undefined || scope.feature === undefined || t.feature === scope.feature),
      )
      .at(-1)
  );
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
        split: traceSplit(trace),
        attributed_at: attributedAt,
        ...fields,
        evidence: fields.evidence.slice(0, 20),
      }),
    );
  };

  const groups = new Map<string, FailureSignal[]>();
  for (const signal of signals) {
    const key = groupKey(signal);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [signal]);
    else list.push(signal);
  }
  // A labelled escalation is a failure signal of its own, at task, feature or run scope.
  for (const label of labels) if (!groups.has(groupKey(label))) groups.set(groupKey(label), []);

  for (const [key, group] of groups) {
    const scoped = labels.filter((l) => groupKey(l) === key);
    if (scoped.length > 0) {
      for (const label of scoped) {
        if (label.role === "none") continue;
        record(blamedTrace(traces, label.role, label, label.seq), {
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
    const blamed = blamedTrace(traces, blame.primary, first, first.seq);
    if (blamed === undefined) {
      // The blamed role never worked on this failure's scope: left to the AI tiebreak.
      inconclusive.push(...group);
      continue;
    }
    record(blamed, {
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
    split: traceSplit(input.trace),
    evidence: input.evidence.slice(0, 20),
    attributed_at: input.now.toISOString(),
  });
};

/** Absolute path of the project's attributions file. */
export const attributionsPath = (projectRoot: string): string =>
  join(projectRoot, LOOKBACK_REPO.attributions);

/**
 * The attribution names the failure of the role it blames, on that role's own dispatch: a row
 * that blames nobody (an AI tiebreak's "unknown") or another role counts against no version.
 */
export const isRoleFailure = (a: Attribution): boolean =>
  a.outcome === "failure" && a.blamed_role !== null && a.blamed_role === a.prompt.role;

/**
 * A role failure in the train split. The split is recomputed from the trace ({@link traceSplit}),
 * never taken from the row: the file is git-tracked, and a planted `train` row must not hand a
 * held-out trace to the lookback role (AD-21 rule 6).
 */
export const isTrainFailure = (a: Attribution): boolean =>
  isRoleFailure(a) && a.split === "train" && traceSplit(a) === "train";

/** The events attributions are checked against: every run they may name. */
export interface AttributionHistory {
  /** Events of every run whose attributions count (the runs the scorecards cover). */
  readonly history: readonly VtcEvent[];
  readonly lockedShaFor: LockedShaFor;
  /**
   * {@link tiebreakKey}s of the AI tiebreak answers the engine itself recorded, somewhere no role
   * can write. A tiebreak cannot be derived again from the events, so an `ai_tiebreak` row of the
   * git-tracked file counts only when it matches one; none are trusted without this.
   */
  readonly tiebreaks?: ReadonlySet<string>;
}

/**
 * The digest that ties an `ai_tiebreak` row to the engine's own record of that answer
 * (`LookbackTiebreakRecord.tiebreak_key`): `@vtc/shared`'s `lookbackTiebreakKey`, frozen from this
 * function in 4.10.0 with the same digest (spine §5 reading 175), so core can key a record it
 * writes without importing lookback.
 */
export const tiebreakKey: (a: Attribution) => string = lookbackTiebreakKey;

/** The same prompt version: role, mode, host and all three hashes. */
export const samePrompt = (a: Attribution["prompt"], b: Attribution["prompt"]): boolean =>
  a.role === b.role &&
  a.mode === b.mode &&
  a.host === b.host &&
  a.locked_sha256 === b.locked_sha256 &&
  a.editable_sha256 === b.editable_sha256 &&
  a.effective_sha256 === b.effective_sha256;

/**
 * The attributions the engine can stand behind (pure). `attributions.jsonl` is git-tracked and a
 * role can write it, so a row counts only when it names a dispatch of a run in `history`, with the
 * prompt version that dispatch ran, and:
 * - a `tree` or `human` row is one the engine derives again from that run's events (same method
 *   and blamed role); the derived row is returned, with the row's `attributed_at`;
 * - an `ai_tiebreak` row names a dispatch whose run has an inconclusive failure in the dispatch's
 *   task, its feature or the run as a whole, and matches a tiebreak the engine recorded
 *   (`tiebreaks`; the answer itself cannot be re-derived, and a hand-edited or planted row must
 *   not mark a dispatch as failed).
 * Rows of a run outside `history`, of an invented dispatch, of a success the events do not show
 * failing, or whose split is not the trace's split are dropped. One row per trace.
 */
export const trustedAttributions = (
  rows: readonly Attribution[],
  { history, lockedShaFor, tiebreaks }: AttributionHistory,
): Attribution[] => {
  const byRun = new Map<string, VtcEvent[]>();
  for (const event of history) {
    const list = byRun.get(event.run);
    if (list === undefined) byRun.set(event.run, [event]);
    else list.push(event);
  }
  const traces = new Map(buildTraces(history, lockedShaFor).map((t) => [traceRef(t), t]));
  const derived = new Map<string, Attribution>();
  const inconclusive = new Set<string>();
  for (const [run, events] of byRun) {
    const result = attributeRun({ events, lockedShaFor, now: new Date(0) });
    for (const a of result.attributions) derived.set(traceRef(a), a);
    for (const s of result.inconclusive) inconclusive.add(`${run}\n${groupKey(s)}`);
  }
  const trusted: Attribution[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const ref = traceRef(row);
    const trace = traces.get(ref);
    if (
      seen.has(ref) ||
      row.outcome !== "failure" ||
      row.split !== traceSplit(row) ||
      trace?.prompt === undefined ||
      !samePrompt(trace.prompt, row.prompt)
    )
      continue;
    const own = derived.get(ref);
    if (own !== undefined) {
      if (row.method !== own.method || row.blamed_role !== own.blamed_role) continue;
      trusted.push({ ...own, attributed_at: row.attributed_at });
    } else {
      const groups = [
        ...(trace.task === undefined ? [] : [trace.task]),
        ...(trace.feature === undefined ? [] : [`feature:${trace.feature}`]),
        "run",
      ];
      if (
        row.method !== "ai_tiebreak" ||
        tiebreaks?.has(tiebreakKey(row)) !== true ||
        !groups.some((g) => inconclusive.has(`${row.run}\n${g}`))
      )
        continue;
      trusted.push(row);
    }
    seen.add(ref);
  }
  return trusted;
};

/**
 * The recorded attributions the engine can stand behind ({@link trustedAttributions}): the only
 * way to read the file, so every consumer (run end, replay tasks, proposal checks) gets checked
 * rows. Lines that do not validate are skipped.
 */
export const readAttributions = async (
  projectRoot: string,
  against: AttributionHistory,
): Promise<Attribution[]> => {
  const rows: Attribution[] = [];
  // a repo-tracked file: never read through a link the repo commits there (reading 249)
  const read = await readRoleWrittenText(attributionsPath(projectRoot), ATTRIBUTIONS_MAX_BYTES);
  const values: unknown[] = [];
  if (read.kind === "text") {
    for (const line of read.text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        values.push(JSON.parse(line) as unknown);
      } catch {
        // a torn or hand-edited line: skipped, the rest still counts
      }
    }
  }
  for (const value of values) {
    const parsed = parsePersisted(AttributionSchema, value);
    if (parsed.success) rows.push(parsed.data);
  }
  return trustedAttributions(rows, against);
};

/**
 * The most of `attributions.jsonl` Lookback reads (a row is well under 2 KiB): a bigger file is
 * refused whole rather than read in part.
 */
const ATTRIBUTIONS_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Appends attributions (validated) to the repo's `attributions.jsonl`, never through a link the
 * repo commits at the file or a directory on the way (`appendRepoJsonLines`, reading 249).
 */
export const appendAttributions = async (
  projectRoot: string,
  rows: readonly Attribution[],
): Promise<void> => {
  await appendRepoJsonLines(
    projectRoot,
    LOOKBACK_REPO.attributions,
    rows.map((row) => AttributionSchema.parse(row)),
  );
};
