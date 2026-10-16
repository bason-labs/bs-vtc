/**
 * The G2 coverage loop (H-13; spine §5 reading 237; replaces reading 146's "reject G2 so the design
 * roles fix it"). When every DESIGN role is done, the engine runs the DESIGN check
 * (`designCoverage`) before G2 is shown and logs each check as `design.coverage_checked`:
 * - coverage complete (`designCoverageComplete`): the run moves to G2;
 * - a gap: the roles `designCoverageRedispatch` names (the Architect first, then the Designer,
 *   which works from the Architect's output) run again with the gaps (`TaskPack.coverage_gaps`,
 *   `designCoverageGaps`), and the check runs again once they are done;
 * - at most `DESIGN_COVERAGE_LOOP.maxRounds` fix rounds; the same gaps after a round is stuck (the
 *   stuck detection of the other fix loops). At the cap or stuck the run parks with a DESIGN-phase
 *   escalation (reason `cap` or `stuck`) that names the uncovered REQs and offers
 *   `DESIGN_COVERAGE_ESCALATION_OPTIONS`: `change_spec` (back to SPECIFY and G1, the human's text
 *   reaching the BA) or `instruct_architect` (the human's text reaching the Architect as
 *   `TaskPack.answer`, and the loop runs again with a fresh round budget).
 * `directions_problem` is not coverage: it keeps reading 174's rule (`g2.ts`). Everything here is
 * read from the run's log, so a restart resumes the loop where it was.
 */
import {
  DESIGN_COVERAGE_ESCALATION_OPTIONS,
  DESIGN_COVERAGE_LOOP,
  designCoverageComplete,
  designCoverageGaps,
  designCoverageRedispatch,
  EscalationSchema,
  type DesignCoverageChecked,
  type DesignCoverageGaps,
  type DesignCoverageReport,
  type DesignCoverageRole,
  type EscalationAnswer,
  type EscalationOption,
} from "@vtc/shared";
import type { Kernel, RunHandle } from "./kernel.js";
import { nextEscalationId, phaseEnteredSeq } from "./queries.js";

type Events = RunHandle["state"]["events"];

interface Check {
  readonly seq: number;
  readonly data: DesignCoverageChecked;
}

const [CHANGE_SPEC, INSTRUCT_ARCHITECT] = DESIGN_COVERAGE_ESCALATION_OPTIONS;

/** The `design.coverage_checked` events after `since`, in log order. */
const checksAfter = (events: Events, since: number): Check[] =>
  events
    .filter((e) => e.type === "design.coverage_checked" && e.seq > since)
    .map((e) => ({ seq: e.seq, data: e.data as DesignCoverageChecked }));

/** The seq the run last entered DESIGN (0 when it never did). */
const designEntered = (h: RunHandle): number => phaseEnteredSeq(h.state, "design") ?? 0;

/**
 * The human's answer to the coverage loop's escalation of this DESIGN entry, with the seq it was
 * logged at, when there is one and it came after the latest check.
 */
const loopAnswer = (
  h: RunHandle,
): { readonly seq: number; readonly answer: EscalationAnswer } | undefined => {
  const events = h.state.events;
  const last = checksAfter(events, designEntered(h)).at(-1);
  const escalation = last?.data.escalation;
  if (last === undefined || escalation === undefined) return undefined;
  const answered = events.find(
    (e) =>
      e.type === "escalation.answered" &&
      e.seq > last.seq &&
      (e.data as { escalation?: string }).escalation === escalation,
  );
  return answered === undefined
    ? undefined
    : { seq: answered.seq, answer: (answered.data as { answer: EscalationAnswer }).answer };
};

/**
 * The seq the loop's round budget counts from: the run's latest DESIGN entry, or the human's
 * `instruct_architect` answer after a park (a fresh round budget, reading 237(5)).
 */
const loopEpoch = (h: RunHandle): number => {
  const entered = designEntered(h);
  let epoch = entered;
  for (const check of checksAfter(h.state.events, entered)) {
    if (check.data.escalation === undefined) continue;
    const answered = h.state.events.find(
      (e) =>
        e.type === "escalation.answered" &&
        e.seq > check.seq &&
        (e.data as { escalation?: string; answer?: EscalationAnswer }).escalation ===
          check.data.escalation &&
        (e.data as { answer: EscalationAnswer }).answer.option === INSTRUCT_ARCHITECT,
    );
    if (answered !== undefined) epoch = Math.max(epoch, answered.seq);
  }
  return epoch;
};

/**
 * The seq after which a DESIGN role must hand in its work again for the loop (0: none): a role the
 * latest check re-dispatched, or the Architect after the human told it what to do.
 */
export const coverageRedoSince = (h: RunHandle, role: string): number => {
  const answered = loopAnswer(h);
  if (answered?.answer.option === INSTRUCT_ARCHITECT)
    return role === "architect" ? answered.seq : 0;
  const last = checksAfter(h.state.events, designEntered(h)).at(-1);
  return last?.data.outcome === "fixing" &&
    last.data.redispatched.includes(role as DesignCoverageRole)
    ? last.seq
    : 0;
};

/**
 * The gaps a DESIGN role's re-dispatch fixes (`TaskPack.coverage_gaps`), while the latest check
 * re-dispatched it; `undefined` otherwise.
 */
export const coverageGapsFor = (h: RunHandle, role: string): DesignCoverageGaps | undefined => {
  const last = checksAfter(h.state.events, designEntered(h)).at(-1);
  if (last?.data.outcome !== "fixing") return undefined;
  if (!last.data.redispatched.includes(role as DesignCoverageRole)) return undefined;
  return designCoverageGaps(last.data.report, last.data.check);
};

/**
 * Whether the Designer waits for the Architect in a fix round that re-dispatches both: the
 * Designer works from the Architect's output (Architect first).
 */
export const coverageWaitsForArchitect = (
  h: RunHandle,
  role: string,
  architectSubmittedSince: (seq: number) => boolean,
): boolean => {
  if (role !== "designer") return false;
  const last = checksAfter(h.state.events, designEntered(h)).at(-1);
  if (last?.data.outcome !== "fixing") return false;
  return last.data.redispatched.includes("architect") && !architectSubmittedSince(last.seq);
};

/**
 * The human's `change_spec` answer to a coverage escalation given after `since`, which reaches the
 * BA's next SPECIFY dispatch (reading 237(5)).
 */
export const changeSpecAnswer = (h: RunHandle, since: number): EscalationAnswer | undefined => {
  const parked = new Set(
    checksAfter(h.state.events, 0).flatMap((c) =>
      c.data.escalation === undefined ? [] : [c.data.escalation],
    ),
  );
  const answered = h.state.events.findLast(
    (e) =>
      e.type === "escalation.answered" &&
      e.seq > since &&
      parked.has((e.data as { escalation: string }).escalation) &&
      (e.data as { answer: EscalationAnswer }).answer.option === CHANGE_SPEC,
  );
  return (answered?.data as { answer: EscalationAnswer } | undefined)?.answer;
};

/** Whether `escalation` is a coverage-loop park and the human chose to change the spec. */
export const isChangeSpecAnswer = (h: RunHandle, escalation: string, option: string): boolean =>
  option === CHANGE_SPEC &&
  checksAfter(h.state.events, 0).some((c) => c.data.escalation === escalation);

/** The coverage gaps, ignoring the round they were found in (the stuck comparison). */
const gapsKey = (report: DesignCoverageReport): string => {
  const { round: _round, ...gaps } = designCoverageGaps(report, 1);
  return JSON.stringify(gaps);
};

/** The REQs a failed check leaves uncovered, in order, each once. */
const uncoveredReqs = (report: DesignCoverageReport): string[] => [
  ...new Set([...report.reqs_without_component, ...report.reqs_without_screen]),
];

/** What a failed check says, one clause per gap (also the escalation's detail). */
export const coverageProblems = (r: DesignCoverageReport): string[] => [
  ...r.reqs_without_component.map((id) => `${id} is mapped to no AD or component`),
  ...(r.screens_problem === undefined ? [] : [r.screens_problem]),
  ...r.reqs_without_screen.map((id) => `${id} has no screen`),
  ...r.screens_without_req.map((id) => `screen ${id} covers no requirement`),
  ...r.components_unregistered.map((id) => `component ${id} is not registered`),
];

const OPTIONS: readonly EscalationOption[] = [
  {
    id: CHANGE_SPEC,
    label:
      "Change the spec: the run goes back to SPECIFY and G1 with your note for the BA, then DESIGN runs again",
    effect: "replan",
  },
  {
    id: INSTRUCT_ARCHITECT,
    label:
      "Tell the Architect what to do: your note reaches the Architect, and the coverage loop runs again with a fresh round budget",
    effect: "hint",
  },
];

/** The DESIGN-phase escalation of a loop that hit its cap or got stuck (reading 237(5)). */
const parkLoop = (
  k: Kernel,
  h: RunHandle,
  report: DesignCoverageReport,
  reason: "cap" | "stuck",
  why: string,
): string => {
  const id = nextEscalationId(h.state);
  const reqs = uncoveredReqs(report);
  const spec = h.state.run.gates.G1.frozen.find((f) => f.path.startsWith(".vtc/spec/"));
  const escalation = EscalationSchema.parse({
    id,
    run: h.state.id,
    phase: "design",
    reason,
    detail: `${why}. ${coverageProblems(report).join("; ")}`.slice(0, 2000),
    question: (reqs.length > 0
      ? `The design still leaves ${reqs.join(", ")} uncovered (${why}). Change the spec, or tell the Architect what to do?`
      : `The design still fails the coverage check (${why}): ${coverageProblems(report).join("; ")}. Change the spec, or tell the Architect what to do?`
    ).slice(0, 1000),
    options: OPTIONS,
    recommended: INSTRUCT_ARCHITECT,
    evidence: [{ type: "file", ref: spec?.path ?? ".vtc/spec" }],
    blocks: [],
    created_at: k.now().toISOString(),
  });
  k.emit(h, { type: "escalation.opened", actor: "engine", data: { escalation } });
  return id;
};

/**
 * What the loop does now that every DESIGN role is done: `complete` (G2 may show), `fixing` (the
 * re-dispatched roles run next), `parked` (an escalation is open), or `held` (the loop's escalation
 * is still unanswered, nothing to do, and the design is not read). `check` runs the DESIGN check;
 * `roles` are the DESIGN roles this run has.
 */
export const runCoverageCheck = (
  k: Kernel,
  h: RunHandle,
  check: () => DesignCoverageReport,
  roles: readonly string[],
): "complete" | "fixing" | "parked" | "held" => {
  const entered = designEntered(h);
  const last = checksAfter(h.state.events, entered).at(-1);
  if (last?.data.outcome === "parked" && loopAnswer(h) === undefined) return "held";
  const report = check();
  const epoch = loopEpoch(h);
  const checks = checksAfter(h.state.events, epoch);
  const n = checks.length + 1;
  const base = { check: n, max_rounds: DESIGN_COVERAGE_LOOP.maxRounds, report };
  const log = (data: Omit<DesignCoverageChecked, "check" | "max_rounds" | "report">): void => {
    k.emit(h, { type: "design.coverage_checked", actor: "engine", data: { ...base, ...data } });
  };
  if (designCoverageComplete(report)) {
    log({ outcome: "complete", redispatched: [] });
    return "complete";
  }
  const redispatch = designCoverageRedispatch(report).filter((r) => roles.includes(r));
  const previous = checks.at(-1);
  const park = (reason: "cap" | "stuck", why: string): "parked" => {
    const escalation = parkLoop(k, h, report, reason, why);
    log({ outcome: "parked", redispatched: [], park_reason: reason, escalation });
    return "parked";
  };
  if (previous?.data.outcome === "fixing" && gapsKey(previous.data.report) === gapsKey(report))
    return park("stuck", `the same gaps after fix round ${String(previous.data.check)}`);
  if (n > DESIGN_COVERAGE_LOOP.maxRounds)
    return park(
      "cap",
      `${String(DESIGN_COVERAGE_LOOP.maxRounds)} coverage fix rounds did not close the gaps`,
    );
  if (redispatch.length === 0)
    return park("stuck", "no DESIGN role of this run can close these gaps");
  log({ outcome: "fixing", redispatched: redispatch });
  return "fixing";
};
