import type {
  AutoResumeCheck,
  HealthResult,
  HeadlessEnded,
  HeadlessPreflight,
  HeadlessRunSummary,
  HostErrorCause,
  StatusResult,
  VtcEvent,
} from "@vtc/shared";
import { eventsOfType } from "./events";
import { formatGateDuration } from "./gates";
import { refusedFallbacks, roleRunNotes, type RoleRunNote } from "./role-run-notes";
import type { StatusMeta } from "./states";

/**
 * Role runs the engine launched itself (spec §6.9, spine AD-25): a Codex Lead's roles, and
 * auto-resume with no live Lead. History comes from `headless.started` / `headless.ended`;
 * `StatusResult.headless_runs` adds what is in flight right now.
 */
export const HEADLESS_CAUSES: Readonly<Record<HostErrorCause, string>> = {
  timeout: "wall-clock timeout",
  idle: "no output (idle timeout)",
  killed: "killed",
  max_turns: "turn cap reached",
  budget: "budget cap reached",
  exit_code: "exited without a final result",
  spawn: "the process never started",
  model_refused: "the host refused the model (dispatched again on its default)",
};

export const PREFLIGHT_CHECKS: Readonly<Record<AutoResumeCheck, string>> = {
  paused: "the run is paused (vtc pause)",
  config: "the config changed since the run started",
  usage: "too little of the usage window is left",
  auth: "the host is not logged in",
  budget: "the budget is spent",
};

export const PREFLIGHT_PURPOSES: Readonly<Record<HeadlessPreflight["purpose"], string>> = {
  role: "role run",
  auto_resume: "auto-resume",
  cross_family_review: "cross-family review",
  lookback_replay: "lookback replay",
};

const outcomeMeta = (ended: HeadlessEnded, refusedAgain = false): StatusMeta => {
  switch (ended.outcome) {
    case "done":
      return { label: "Done", tone: "ok" };
    case "limit":
      return { label: "Stopped at a usage limit", tone: "warn" };
    case "auth":
      return { label: "Host login failed", tone: "danger" };
    case "error":
      // D-cx: a refused model is not a role failure; the engine dispatches the run once more.
      // The fallback dispatch refused too is an ordinary error (reading 244): none follows.
      if (ended.cause === "model_refused" && refusedAgain)
        return { label: "Error: the host refused its default model too", tone: "danger" };
      if (ended.cause === "model_refused")
        return { label: "Model refused: dispatched again on the host default", tone: "warn" };
      return {
        label: `Error: ${ended.cause === undefined ? "unknown cause" : HEADLESS_CAUSES[ended.cause]}`,
        tone: "danger",
      };
  }
};

export const headlessOutcomeMeta = outcomeMeta;

export interface HeadlessRunView {
  readonly actionId: string;
  readonly role: string;
  readonly host: string;
  readonly task: string | null;
  readonly startedAt: string;
  readonly status: StatusMeta;
  readonly detail: string;
  /** Its cost once submitted (H-12) and the model fallback of its dispatch (D-cx). */
  readonly note: RoleRunNote | null;
}

const minutes = (ms: number): string => `${String(Math.round(ms / 60_000))} min`;

const RUNNING: StatusMeta = { label: "Running", tone: "accent", live: true };
/** Started, never ended, and the run has finished (e.g. the engine stopped mid-run). */
const DID_NOT_FINISH: StatusMeta = { label: "Did not finish", tone: "warn" };
/** Started, never ended, and the live engine does not report it in flight. */
const NO_END: StatusMeta = { label: "No end recorded", tone: "warn" };

/** Contracts version from which a live engine sends `StatusResult.headless_runs` (4.5.0). */
const HEADLESS_RUNS_SINCE: readonly number[] = [4, 5, 0];

const atLeast = (version: string, min: readonly number[]): boolean => {
  const parts = version.split(".").map(Number);
  for (const [i, want] of min.entries()) {
    const have = parts[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
};

/**
 * What the engine reports in flight for `run`, for {@link headlessRuns}. A live engine on
 * contracts 4.5.0+ leaves `headless_runs` out when none is in flight, so for its active run an
 * absent field means `[]`. `null` (not known) for another run, a snapshot or an older engine.
 */
export const inFlightHeadless = (
  status: StatusResult | undefined,
  run: string,
  health: HealthResult | null,
): readonly HeadlessRunSummary[] | null => {
  if (status?.run.id !== run) return null;
  if (status.headless_runs !== undefined) return status.headless_runs;
  return health?.mode === "live" && atLeast(health.contracts_version, HEADLESS_RUNS_SINCE)
    ? []
    : null;
};

/**
 * Engine-launched runs, newest first. `inFlight` is the active run's
 * `StatusResult.headless_runs`, or `null` when that is not known (another run, an older engine,
 * a snapshot): only then is a start with no end taken to be still running.
 */
export const headlessRuns = (
  events: readonly VtcEvent[],
  inFlight: readonly HeadlessRunSummary[] | null = null,
): HeadlessRunView[] => {
  const ended = new Map(eventsOfType(events, "headless.ended").map((e) => [e.data.action_id, e]));
  const live = new Set((inFlight ?? []).map((r) => r.action_id));
  const runEnded = eventsOfType(events, "run.finished").length > 0;
  const notes = roleRunNotes(events);
  const refusedAgain = refusedFallbacks(events);
  const unended = (actionId: string): StatusMeta => {
    if (live.has(actionId)) return RUNNING;
    if (runEnded) return DID_NOT_FINISH;
    return inFlight === null ? RUNNING : NO_END;
  };
  const runs: HeadlessRunView[] = eventsOfType(events, "headless.started").map(
    ({ event, data }) => {
      const end = ended.get(data.action_id)?.data;
      const parts = [
        data.resume === null
          ? data.pid === null
            ? null
            : `pid ${String(data.pid)}`
          : `Resumes session ${data.resume.id}`,
        `limits ${minutes(data.wall_timeout_ms)}, idle ${minutes(data.idle_timeout_ms)}`,
        end === undefined ? null : `ran ${formatGateDuration(end.duration_ms)}`,
        end?.exit_code === null || end?.exit_code === undefined
          ? null
          : `exit ${String(end.exit_code)}`,
      ];
      return {
        actionId: data.action_id,
        role: event.role ?? "unknown role",
        host: event.host ?? "unknown host",
        task: event.task ?? null,
        startedAt: event.ts,
        status:
          end === undefined
            ? unended(data.action_id)
            : outcomeMeta(end, refusedAgain.has(data.action_id)),
        detail: parts.filter((p) => p !== null).join(" · "),
        note: notes.get(data.action_id) ?? null,
      };
    },
  );
  const known = new Set(runs.map((r) => r.actionId));
  for (const r of inFlight ?? []) {
    if (known.has(r.action_id)) continue;
    runs.push({
      actionId: r.action_id,
      role: r.role,
      host: r.host,
      task: r.task ?? null,
      startedAt: r.started_at,
      status: RUNNING,
      detail: r.pid === null ? "In flight" : `pid ${String(r.pid)}`,
      note: notes.get(r.action_id) ?? null,
    });
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};
