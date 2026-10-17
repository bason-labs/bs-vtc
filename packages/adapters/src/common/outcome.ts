/**
 * The parts of an engine-launched run's outcome both hosts share (AD-25 rules 4–5). What the
 * stream says always decides first: a finished, limited or signed-out run is that, whatever the
 * exit code or the launcher did. These helpers cover the rest: a run that never started, a stream
 * error with no cause of its own after the launcher stopped the run, and a process that ended
 * without a terminal event (`error` with `cause`: the launcher's stop, a kill from outside, or a
 * bare exit).
 */
import { redactSecrets, type HostOutcome, type TokenUsage } from "@vtc/shared";
import type { RunExit } from "./headless-run.js";

/** 128 + SIGINT, SIGKILL, SIGTERM: a process killed by a signal it did not survive. */
const KILLED_EXIT_CODES: ReadonlySet<number> = new Set([130, 137, 143]);

/** The process was ended by a signal (or exited with the status a signal leaves, such as 143). */
const wasKilled = (exit: RunExit): boolean =>
  exit.signal !== null || (exit.code !== null && KILLED_EXIT_CODES.has(exit.code));

/** A host binary that could not be started (not on PATH, not executable): retrying cannot help. */
export const spawnFailure = (binary: string, error: Error): HostOutcome => ({
  kind: "error",
  message: `could not start ${binary}: ${error.message}`,
  retryable: false,
  cause: "spawn",
  tokens: null,
  cost_usd: null,
});

/**
 * How the process ended, as the start of a message: the launcher's reason when it stopped the run,
 * else the exit status or signal, followed by `what` was missing and the stderr tail with every
 * secret-shaped value redacted (the message goes into the event log, AD-18).
 */
export const describeExit = (binary: string, exit: RunExit, what: string): string => {
  const stderr = redactSecrets(exit.stderrTail.trim());
  const how =
    exit.stop?.message ??
    `${binary} ${exit.code === null ? `was stopped by ${exit.signal ?? "a signal"}` : `exited ${String(exit.code)}`}`;
  return `${how} ${what}${stderr === "" ? "" : `: ${stderr}`}`;
};

/**
 * A process that ended without a terminal stream event and without a limit or sign-in signal:
 * the launcher's stop cause, a kill from outside, or a bare exit status. Never `done`, and
 * retryable: the engine's retry caps decide whether it runs again.
 */
export const endedWithoutResult = (
  message: string,
  exit: RunExit,
  spend: { readonly tokens: TokenUsage | null; readonly cost_usd: number | null } = {
    tokens: null,
    cost_usd: null,
  },
): HostOutcome => ({
  kind: "error",
  message,
  retryable: true,
  cause: exit.stop?.cause ?? (wasKilled(exit) ? "killed" : "exit_code"),
  tokens: spend.tokens,
  cost_usd: spend.cost_usd,
});

/**
 * A terminal stream outcome after the launcher stopped the run: `done`, `limit`, `auth` and an
 * error with its own cause (a turn or budget cap) stand; an error without one (the turn the host
 * ended on SIGINT) takes the stop's cause and says why first.
 */
export const withStopCause = (outcome: HostOutcome, exit: RunExit): HostOutcome =>
  outcome.kind === "error" && outcome.cause === undefined && exit.stop !== null
    ? { ...outcome, cause: exit.stop.cause, message: `${exit.stop.message}: ${outcome.message}` }
    : outcome;
