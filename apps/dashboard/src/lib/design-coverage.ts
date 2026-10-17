import type {
  DESIGN_COVERAGE_ESCALATION_OPTIONS,
  DesignCoverageChecked,
  DesignCoverageReport,
  DesignCoverageRole,
  VtcEvent,
} from "@vtc/shared";
import { eventsOfType } from "./events";
import type { StatusMeta } from "./states";

/**
 * The G2 coverage loop before G2 (H-13; spine §5 reading 237): engine core checks that every G1
 * REQ is named by an AD or a component (and every UI REQ has a screen) before it shows G2. A
 * failed check re-dispatches the Architect and, for UI gaps, the Designer with the gaps, then
 * checks again, at most `max_rounds` fix rounds; at the cap, or stuck, the run parks with an
 * escalation that names the uncovered REQs. Each check is a `design.coverage_checked` event.
 * There is no "approve anyway": G2 is shown only after a complete check.
 */
export type CoverageLoopStateId = DesignCoverageChecked["outcome"] | "checking";

const STATES: Readonly<Record<CoverageLoopStateId, StatusMeta>> = {
  checking: { label: "Checking again", tone: "accent", live: true },
  fixing: { label: "Fixing gaps", tone: "warn", live: true },
  complete: { label: "Complete", tone: "ok" },
  parked: { label: "Parked", tone: "danger" },
};

const ROLE_LABELS: Readonly<Record<DesignCoverageRole, string>> = {
  architect: "Architect",
  designer: "Designer",
};

/** The coverage escalation's options (`DESIGN_COVERAGE_ESCALATION_OPTIONS`), as the human reads them. */
export const COVERAGE_ESCALATION_OPTIONS: Readonly<
  Record<(typeof DESIGN_COVERAGE_ESCALATION_OPTIONS)[number], string>
> = {
  change_spec: "change the spec (the run goes back to G1)",
  instruct_architect: "tell the Architect what to do (the loop then runs again)",
};

/** The report's gap lists, from the contract: a list key added later needs a label here. */
type GapId = {
  [K in keyof DesignCoverageReport]-?: DesignCoverageReport[K] extends readonly unknown[]
    ? K
    : never;
}[keyof DesignCoverageReport];

const GAP_LABELS: Readonly<Record<GapId, string>> = {
  reqs_without_component: "Requirements no AD or component names",
  reqs_without_screen: "UI requirements with no screen",
  screens_without_req: "Screens that cover no requirement",
  components_unregistered: "Components not in the registry",
};

const GAP_IDS = Object.keys(GAP_LABELS) as GapId[];

export interface CoverageGapList {
  readonly id: GapId;
  readonly label: string;
  readonly items: readonly string[];
}

export interface CoverageCheckView {
  readonly seq: number;
  readonly at: string;
  readonly check: number;
  readonly outcome: StatusMeta;
  /** How many gaps the check found (each list item, plus a `screens.yaml` problem). */
  readonly gaps: number;
}

export interface CoverageLoopView {
  readonly state: StatusMeta & { readonly id: CoverageLoopStateId };
  /** One sentence for the loop's state. */
  readonly headline: string;
  /** The newest check's number (1 = the first check, before any fix round). */
  readonly check: number;
  readonly maxRounds: number;
  /** Fix rounds started so far, `n of max_rounds`. */
  readonly fixRounds: string;
  /** The roles the newest check re-dispatched, as names (`Architect`, `Designer`). */
  readonly redispatched: readonly string[];
  /** The newest check's non-empty gap lists. */
  readonly gaps: readonly CoverageGapList[];
  readonly screensProblem: string | null;
  /** The REQs still uncovered (no AD or component, or no screen), in id order. */
  readonly uncovered: readonly string[];
  /**
   * Why the loop parked, the escalation that asks the human and whether the human has answered it
   * (`escalation.answered`), or `null`.
   */
  readonly park: {
    readonly reason: string;
    readonly escalation: string | null;
    readonly answered: boolean;
  } | null;
  /** The checks of this loop, oldest first. */
  readonly checks: readonly CoverageCheckView[];
}

const gapCount = (c: DesignCoverageChecked): number =>
  GAP_IDS.reduce((n, id) => n + c.report[id].length, 0) +
  (c.report.screens_problem === undefined ? 0 : 1);

const parkReason = (c: DesignCoverageChecked): string =>
  c.park_reason === "cap"
    ? `the cap of ${String(c.max_rounds)} fix rounds was reached`
    : "stuck: the same gaps remained after a fix round";

const byId = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/**
 * The newest coverage loop of the run, or `null` before any check. A loop starts at check 1, so
 * a loop that runs again (after the human told the Architect what to do, or changed the spec)
 * replaces the one before. A fixing check becomes `checking` once every role it re-dispatched
 * has submitted after it.
 */
export const coverageLoop = (events: readonly VtcEvent[]): CoverageLoopView | null => {
  const all = eventsOfType(events, "design.coverage_checked");
  const startIndex = all.findLastIndex((c) => c.data.check === 1);
  const checks = startIndex === -1 ? all : all.slice(startIndex);
  const last = checks.at(-1);
  if (last === undefined) return null;
  const { event, data } = last;

  let id: CoverageLoopStateId = data.outcome;
  if (data.outcome === "fixing") {
    const submittedAfter = new Set(
      eventsOfType(events, "role.submitted")
        .filter((s) => s.event.seq > event.seq)
        .map((s) => s.event.role),
    );
    if (data.redispatched.every((r) => submittedAfter.has(r))) id = "checking";
  }
  const finished = eventsOfType(events, "run.finished").some((f) => f.event.seq > event.seq);
  const { live: _live, ...settled } = STATES[id];
  const state = { id, ...(finished ? settled : STATES[id]) };

  const max = data.max_rounds;
  const started = data.outcome === "fixing" ? data.check : data.check - 1;
  const of = (n: number): string => `${String(n)} of ${String(max)}`;
  const headline = {
    fixing: `Check ${String(data.check)} found gaps: fix round ${of(data.check)} is running`,
    checking: `Fix round ${of(data.check)} is in: check ${String(data.check + 1)} is running`,
    complete: `Check ${String(data.check)}: every requirement is covered, so G2 follows`,
    parked: `Check ${String(data.check)}: parked, ${parkReason(data)}`,
  }[id];

  const report = data.report;
  return {
    state,
    headline,
    check: data.check,
    maxRounds: max,
    fixRounds: of(Math.min(started, max)),
    redispatched: data.redispatched.map((r) => ROLE_LABELS[r]),
    gaps: GAP_IDS.filter((g) => report[g].length > 0).map((g) => ({
      id: g,
      label: GAP_LABELS[g],
      items: report[g],
    })),
    screensProblem: report.screens_problem ?? null,
    uncovered: [...new Set([...report.reqs_without_component, ...report.reqs_without_screen])].sort(
      byId,
    ),
    park:
      data.outcome === "parked"
        ? {
            reason: parkReason(data),
            escalation: data.escalation ?? null,
            answered:
              data.escalation !== undefined &&
              eventsOfType(events, "escalation.answered").some(
                (a) => a.event.seq > event.seq && a.data.escalation === data.escalation,
              ),
          }
        : null,
    checks: checks.map((c) => ({
      seq: c.event.seq,
      at: c.event.ts,
      check: c.data.check,
      outcome: (({ live: _l, ...m }) => m)(STATES[c.data.outcome]),
      gaps: gapCount(c.data),
    })),
  };
};
