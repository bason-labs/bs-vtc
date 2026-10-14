/**
 * Usage limits (§6.8, §6.9; AD-17). A limit hit marks the step `interrupted`, keeps its inputs,
 * worktree and session, persists the reset time and pending steps (`limit.hit`) and schedules the
 * OS timer at the reset plus 1–2 minutes of jitter. In plugin-only mode the engine launches
 * nothing itself: `next` answers `wait` until then, re-reads usage, and then hands the Lead a
 * `spawn_role` that resumes the same session (`lead_redispatch`). With `headless_allowed` and no
 * live Lead the timer's wake resumes the steps as engine-launched runs (AD-17 rule 2, AD-25).
 */
import type { HostFailureOutcome, HostId, TaskStatus } from "@vtc/shared";
import type { Kernel, RunHandle } from "./kernel.js";
import { setTaskStatus } from "./parking.js";
import type { RoleRunRecord } from "./state.js";

/** Jitter after the reset (§6.9 step 4): 1–2 minutes. */
export const RESUME_JITTER_MS = { min: 60_000, max: 120_000 } as const;
/** Without a reset time, back off this long and re-read usage (§6.9 step 5). */
export const UNKNOWN_RESET_BACKOFF_MS = 15 * 60_000;
/** Re-parks after a still-limited re-read before resuming anyway (§6.9 step 5 "up to a cap"). */
export const MAX_LIMIT_BACKOFFS = 3;

const INTERRUPTIBLE: readonly TaskStatus[] = [
  "ready",
  "tests_authored",
  "building",
  "verifying",
  "fixing",
];

const resumeAt = (k: Kernel, resetsAt: string | null): string => {
  const jitter =
    RESUME_JITTER_MS.min +
    Math.floor(k.deps.random() * (RESUME_JITTER_MS.max - RESUME_JITTER_MS.min));
  const base =
    resetsAt === null ? k.now().getTime() + UNKNOWN_RESET_BACKOFF_MS : Date.parse(resetsAt);
  return new Date(Math.max(base, k.now().getTime()) + jitter).toISOString();
};

const schedule = (k: Kernel, at: string): void => {
  void k.deps.autoResume.schedule(k.deps.repoRoot, new Date(at)).catch(() => undefined);
};

/** A role run hit a usage limit (§6.9 steps 1–4). */
export const recordLimit = (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  outcome: Extract<HostFailureOutcome, { kind: "limit" }>,
): void => {
  const at = resumeAt(k, outcome.resets_at);
  k.emit(h, {
    type: "limit.hit",
    actor: "engine",
    ...(run.task === undefined ? {} : { task: run.task }),
    // D-at (spine §5 reading 77): what the host reports the run cost before the limit counts,
    // on the event like a failed run's, so the run's shares and the advisor budget include it
    role: run.role,
    ...(outcome.cost_usd === null ? {} : { cost_usd: outcome.cost_usd }),
    data: {
      host: run.host,
      window: outcome.window,
      model: outcome.model,
      resets_at: outcome.resets_at,
      session_ref: outcome.session_ref,
      pending_action_ids: [run.action_id],
      auto_resume_at: at,
    },
  });
  const task = run.task === undefined ? undefined : h.state.tasks.get(run.task);
  if (task !== undefined && INTERRUPTIBLE.includes(task.status)) {
    setTaskStatus(k, h, task.id, "interrupted");
  }
  schedule(k, at);
};

/**
 * An engine-launched start or resume found the host still limited (the headless preflight's
 * `usage` check, AD-25 rule 3): nothing launches, dispatching waits until the reset plus jitter,
 * and the timer is scheduled, as after a limit hit (§6.9 steps 2–4).
 */
export const deferForUsage = (k: Kernel, h: RunHandle, host: HostId, resetsAt: string): void => {
  const at = resumeAt(k, resetsAt);
  k.emit(h, {
    type: "limit.hit",
    actor: "engine",
    data: {
      host,
      window: "five_hour",
      model: null,
      resets_at: resetsAt,
      session_ref: h.state.limit?.sessionRef ?? null,
      pending_action_ids: [...(h.state.limit?.pendingActionIds ?? [])],
      auto_resume_at: at,
    },
  });
  schedule(k, at);
};

/** While a limit is active, when dispatching may resume; `null` when nothing is waiting. */
export const limitWait = (k: Kernel, h: RunHandle): string | null => {
  const at = h.state.limit?.autoResumeAt ?? null;
  if (at === null) return null;
  return Date.parse(at) > k.now().getTime() ? at : null;
};

/** The reset time while `host`'s five-hour window is used up, else `null` (§6.9 step 5). */
export const stillLimited = (k: Kernel, host: HostId): string | null => {
  const window = k.usage.get(host)?.windows.find((w) => w.kind === "five_hour");
  if (window?.used_pct === null || window === undefined || window.used_pct < 100) return null;
  if (window.resets_at === null || Date.parse(window.resets_at) <= k.now().getTime()) return null;
  return window.resets_at;
};

/**
 * At or after the scheduled time (§6.9 steps 5–6): re-read usage; still limited → back off and
 * re-park (up to {@link MAX_LIMIT_BACKOFFS}); otherwise the interrupted steps return to their
 * checkpoints and are re-dispatched, resuming their sessions.
 */
export const maybeAutoResume = (k: Kernel, h: RunHandle): boolean => {
  const limit = h.state.limit;
  if (limit?.autoResumeAt == null || h.state.run.paused) return false;
  if (Date.parse(limit.autoResumeAt) > k.now().getTime()) return false;
  const lastResume = [...h.state.events].reverse().find((e) => e.type === "run.resumed")?.seq ?? 0;
  const backoffs =
    h.state.events.filter((e) => e.type === "limit.hit" && e.seq > lastResume).length - 1;
  const reset = stillLimited(k, limit.host);
  if (reset !== null && backoffs < MAX_LIMIT_BACKOFFS) {
    const at = resumeAt(k, reset);
    k.emit(h, {
      type: "limit.hit",
      actor: "engine",
      data: {
        host: limit.host,
        window: "five_hour",
        model: null,
        resets_at: reset,
        session_ref: limit.sessionRef,
        pending_action_ids: [...limit.pendingActionIds],
        auto_resume_at: at,
      },
    });
    schedule(k, at);
    return false;
  }
  // Resuming re-dispatches the interrupted steps: through the Lead (plugin-only,
  // `lead_redispatch`), or, with no live Lead and `headless_allowed`, as engine-launched resumes
  // (`Engine.wake`, `drive` in headless.ts).
  k.emit(h, { type: "run.resumed", actor: "engine", data: { auto: true } });
  for (const task of [...h.state.tasks.values()]) {
    if (task.status !== "interrupted") continue;
    setTaskStatus(k, h, task.id, h.state.checkpoints.get(task.id) ?? "building");
  }
  void k.deps.autoResume.cancel(k.deps.repoRoot).catch(() => undefined);
  return true;
};
