/**
 * How the steps the engine wants now are run (§4.2 step 2, §6.9; spine AD-4 rule 4, AD-17,
 * AD-25): `planDispatch(purpose, mode, capabilities, leadHost)` is the only decision. `subagent`
 * steps become `spawn_role` actions for the Lead; `headless` steps are launched by the engine
 * itself (`headless.ts`) and never appear as Lead actions; a host that can do neither pauses the
 * run with the reason. The Lead's host decides the default (`ROLE_DISPATCH_BY_LEAD_HOST`, H-1): a
 * Codex Lead's role steps run as headless Codex runs, a Claude Code Lead's as its subagents.
 */
import {
  CODEX_IN_SESSION_REFUSED_REASON,
  planDispatch,
  ROLE_DISPATCH_BY_LEAD_HOST,
  type DispatchPurpose,
  type HostId,
  type LeadAction,
} from "@vtc/shared";
import { checkGitNow, sweepDispatches } from "./dispatch-guard.js";
import {
  dispatchGuarded,
  inSessionRefusal,
  pendingSteps,
  refuseInSession,
  type StepSpec,
} from "./dispatch.js";
import { capabilitiesOf, dispatchHeadless, launchHeadless } from "./headless.js";
import { hostWebRouteFor } from "./host-web.js";
import type { CallContext, Kernel, RunHandle } from "./kernel.js";
import { limitWait } from "./limits.js";
import { replayHostOf } from "./replay.js";
import { inFlight } from "./queries.js";

/**
 * New role runs within the concurrency limit (reviewers count, §6.6): the Lead's subagents as
 * `spawn_role` actions, or the engine's own headless launches (which return no action). A step a
 * Codex Lead's host cannot launch headless parks with `CODEX_IN_SESSION_REFUSED_REASON`, which
 * names `vtc doctor` and a Claude Lead as the remedy (reading 99).
 */
export const dispatchNow = async (
  k: Kernel,
  h: RunHandle,
  call: CallContext,
  held: { noLead: number } = { noLead: 0 },
): Promise<LeadAction[]> => {
  if (h.state.run.paused || h.state.run.finished_at !== undefined) return [];
  // Runs that ended without a check (a failure, a limit, a restart) are checked before a new
  // baseline is recorded; a git change made while a role runs stops everything (AD-7 rule 7).
  if ((await sweepDispatches(k, h)).issues.length > 0 || checkGitNow(k, h)) return [];
  if (limitWait(k, h) !== null) return [];
  const host = k.hostFor(call);
  const config = k.config();
  const leadHost = k.leadHostFor(h.state.id, call);
  const capabilities = k.deps.adapters[host]?.capabilities ?? { subagents: true, headless: false };
  const plan = planDispatch("role", config.hosts.dispatch, capabilities, leadHost);
  if (plan === "headless") {
    await dispatchHeadless(k, h, host, "role");
    return [];
  }
  if (plan !== "subagent") {
    const pending = pendingSteps(k, h, host);
    if (pending.length === 0) return [];
    if (leadHost !== undefined && ROLE_DISPATCH_BY_LEAD_HOST[leadHost] === "headless") {
      // a Codex Lead's roles run only headless (reading 82): this host cannot launch them
      for (const step of pending) refuseInSession(k, h, step, CODEX_IN_SESSION_REFUSED_REASON);
      return [];
    }
    k.emit(h, {
      type: "run.paused",
      actor: "engine",
      data: {
        reason: `${host} has no role subagents and cannot run them headless (hosts.dispatch ${config.hosts.dispatch}${capabilities.headless ? "" : ", no headless support"}); run the Lead on a host with subagents or set hosts.dispatch headless_allowed, then vtc resume`,
      },
    });
    return [];
  }
  const actions: LeadAction[] = [];
  let free = config.concurrency - inFlight(h.state).length;
  for (const step of pendingSteps(k, h, host)) {
    if (free <= 0) break;
    if (step.purpose === "lookback_replay") {
      // D-cg (reading 201): a replay trial is an engine-launched headless run, never a subagent
      if (await launchReplayTrial(k, h, step, host, leadHost)) free -= 1;
      continue;
    }
    if (step.host !== undefined) {
      // the cross-family reviewer runs headless on the other family's host (§12.4)
      if (await launchHeadless(k, h, step, step.host, "cross_family_review")) free -= 1;
      continue;
    }
    // D-cf: a host_web role whose route is another host runs headless there; as this host's
    // subagent the compiled agent's own profile governs its web search (Claude Code's denies the
    // credential stores)
    const web = hostWebRouteFor(k, step, leadHost, host);
    if (web !== null && web.host !== host) {
      if (!web.hostWeb) k.relay(h.state.id, web.notice);
      if (await launchHeadless(k, h, step, web.host, "role", 1, web.hostWeb)) free -= 1;
      continue;
    }
    const refusal = inSessionRefusal(k, h, step, host, call);
    if (refusal !== null) {
      // only the run's Lead reporting its sandbox off or unknown parks the step; a caller that
      // is not the Lead, with no Lead to ask, leaves it pending ({@link NO_LEAD_WAIT_REASON})
      if (k.leadless(h.state.id, call)) held.noLead += 1;
      else refuseInSession(k, h, step, refusal);
      continue;
    }
    const action = await dispatchGuarded(k, h, step, host);
    if (action === null) break;
    actions.push(action);
    free -= 1;
  }
  return actions;
};

/**
 * Launches a `lookback_replay` trial as the engine's own headless run on `host` (D-cg, spine §5
 * reading 201: `planDispatch` sends every trial headless whenever the host can, without
 * `headless_allowed`); a host that cannot measures nothing, and the replay waits for the next
 * RETRO. Returns whether a run was launched.
 */
const launchReplayTrial = async (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  host: HostId,
  leadHost: HostId | undefined,
): Promise<boolean> => {
  if (
    planDispatch(
      "lookback_replay",
      k.config().hosts.dispatch,
      capabilitiesOf(k, host),
      leadHost,
    ) !== "headless"
  ) {
    refuseInSession(k, h, step, `${host} cannot launch a headless run now`);
    return false;
  }
  return launchHeadless(k, h, step, host, "lookback_replay");
};

/**
 * Launches the replay trials RETRO wants now on the run's Lead host (D-cg): the engine drives them
 * itself, so a trial starts when the one before it is graded, not only on the Lead's next call.
 * Callers hold the run's lock.
 */
const driveReplayTrials = async (k: Kernel, h: RunHandle, lead: HostId): Promise<void> => {
  if (h.state.run.phase !== "retro") return;
  let free = k.config().concurrency - inFlight(h.state).length;
  for (const step of pendingSteps(k, h, lead)) {
    if (free <= 0) return;
    if (step.purpose !== "lookback_replay") continue;
    if ((await sweepDispatches(k, h)).issues.length > 0 || checkGitNow(k, h)) return;
    if (await launchReplayTrial(k, h, step, lead, k.liveLeadHost(h.state.id))) free -= 1;
  }
};

/**
 * The engine drives a run itself (after one of its jobs ends, and when the auto-resume timer
 * fires) when `planDispatch` says its steps run headless now: a Codex Lead's role steps (H-1), or,
 * with `headless_allowed` and no live Lead, a run the timer resumed (`Kernel.unattended`,
 * purpose `auto_resume`). Otherwise the Lead dispatches on its next `next`, and this does nothing.
 * Callers hold the run's lock.
 */
export const drive = async (k: Kernel, h: RunHandle): Promise<void> => {
  const state = h.state;
  if (state.run.finished_at !== undefined || state.run.paused || limitWait(k, h) !== null) return;
  const lead = k.liveLeadHost(state.id);
  let purpose: DispatchPurpose;
  let host: HostId;
  if (lead !== undefined) {
    purpose = "role";
    host = lead;
  } else if (k.unattended.has(state.id)) {
    purpose = "auto_resume";
    host = state.limit?.host ?? k.hostFor({ host: null });
  } else {
    // RETRO's replay trials are the engine's own runs, on the run's Lead host (D-cg)
    await driveReplayTrials(k, h, replayHostOf(k, h));
    return;
  }
  const plan = planDispatch(purpose, k.config().hosts.dispatch, capabilitiesOf(k, host), lead);
  if (plan !== "headless") {
    await driveReplayTrials(k, h, lead ?? host);
    return;
  }
  if ((await sweepDispatches(k, h)).issues.length > 0 || checkGitNow(k, h)) return;
  await dispatchHeadless(k, h, host, purpose);
};
