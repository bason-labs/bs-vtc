/**
 * Engine-launched headless role runs (spec §6.9, §12; spine AD-17 rules 2 and 5, AD-25; Lead
 * decision D-ba, human decision H-1). `planDispatch` stays the only routing decision: a step the
 * engine hands out as `headless` is launched here through `HostAdapter.spawnRole` (or `resume`),
 * never as a Lead action. Before every unattended start or resume the `headless.preflight` checks
 * run in order (pause flag, config hash, usage, the host's own sign-in check, budget); the first
 * one that fails stops the launch, and a failed sign-in check pauses the run with an incident
 * instead of retrying. The run is supervised with the project's `HeadlessPolicy`, its usage
 * events feed the usage store, and its outcome comes from the stream (`HostOutcome`), submitted
 * through the same `handleSubmit` path as a Lead's.
 */
import {
  fromStructuredOutput,
  headlessPolicyFor,
  jsonSchemaFor,
  resolveRoleMode,
  type DispatchPurpose,
  type HeadlessPreflight,
  type HeadlessRun,
  type HeadlessRunSummary,
  type HostCapabilities,
  type HostId,
  type HostOutcome,
  type SpawnResult,
  type SpawnRoleRequest,
  type SubmitInput,
} from "@vtc/shared";
import { budgetState } from "./budget.js";
import { dispatchWriteScope } from "./dispatch-scope.js";
import { dispatchPrepared, pendingSteps, refuseInSession, type StepSpec } from "./dispatch.js";
import { protectedFiles } from "./jobs.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { deferForUsage, limitWait, stillLimited } from "./limits.js";
import { inFlight } from "./queries.js";
import { parkTask } from "./parking.js";
import { headlessPlatformRefusal, roleSandboxProblem, roleSandboxRequest } from "./sandbox.js";
import { handleSubmit } from "./submit.js";

const NO_CAPABILITIES: Pick<HostCapabilities, "subagents" | "headless"> = {
  subagents: false,
  headless: false,
};

/** What a host can do for `planDispatch`; an uninstalled host can do nothing. */
export const capabilitiesOf = (
  k: Kernel,
  host: HostId,
): Pick<HostCapabilities, "subagents" | "headless"> =>
  k.deps.adapters[host]?.capabilities ?? NO_CAPABILITIES;

/**
 * The checks before an engine-launched start or resume (AD-25 rule 3), in order: the run is not
 * paused; the config files still give the run's `pipeline_config_hash`; the host's five-hour
 * window is not used up; the host's own sign-in check (`HostAdapter.authStatus`, when the adapter
 * has one) says logged in; the task (or the run) has budget left.
 */
export const headlessPreflight = async (
  k: Kernel,
  h: RunHandle,
  step: Pick<StepSpec, "task">,
  host: HostId,
  purpose: DispatchPurpose,
): Promise<HeadlessPreflight> => {
  const fail = (failed: NonNullable<HeadlessPreflight["failed"]>, detail: string) => ({
    host,
    purpose,
    ok: false,
    failed,
    detail: detail.slice(0, 500),
  });
  const state = h.state;
  if (state.run.paused) return fail("paused", "the run is paused (vtc resume to continue)");
  const hash = k.diskConfigHash();
  if (hash !== state.run.pipeline_config_hash)
    return fail(
      "config",
      hash === null
        ? "project.yaml or gates.yml no longer parses"
        : `project.yaml or gates.yml changed since the run started (${hash.slice(0, 12)}, the run has ${state.run.pipeline_config_hash.slice(0, 12)})`,
    );
  const reset = stillLimited(k, host);
  if (reset !== null) return fail("usage", `${host}'s five-hour window is used up until ${reset}`);
  const adapter = k.deps.adapters[host];
  if (adapter?.authStatus !== undefined) {
    const status = await adapter.authStatus().catch(() => null);
    if (status?.logged_in !== true)
      return fail(
        "auth",
        status === null || status.logged_in === null
          ? `${host}'s sign-in status command could not be run`
          : `${host}'s sign-in status command says it is not signed in`,
      );
  }
  const task = step.task === undefined ? undefined : state.tasks.get(step.task);
  if (task !== undefined && budgetState(task.spent_usd, task.budget_usd) === "exhausted")
    return fail(
      "budget",
      `${task.id} spent $${task.spent_usd.toFixed(2)} of its $${task.budget_usd.toFixed(2)} budget`,
    );
  const run = state.runBudget;
  if (run !== null && run.spent_usd >= run.budget_usd)
    return fail(
      "budget",
      `the run spent $${run.spent_usd.toFixed(2)} of its $${run.budget_usd.toFixed(2)} budget`,
    );
  return { host, purpose, ok: true };
};

/**
 * How an `incident.recorded` for a failed sign-in check starts, so it can be told from a usage
 * limit until `IncidentKind` has an `auth` kind (contract proposal).
 */
export const AUTH_INCIDENT_PREFIX = "auth: ";

/**
 * A failed preflight: nothing launches, and nothing retries in a loop. `usage` waits for the
 * reset (the timer is scheduled); `auth` records an incident and pauses the run until the human
 * signs in again and resumes; `config` parks the step for the human; `budget` parks its task.
 */
const preflightFailed = (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  check: HeadlessPreflight,
): void => {
  const detail = check.detail ?? "the headless preflight failed";
  switch (check.failed) {
    case "paused":
    case undefined:
      return;
    case "usage": {
      const reset = stillLimited(k, check.host);
      if (reset !== null) deferForUsage(k, h, check.host, reset);
      return;
    }
    case "auth":
      // Never a retry loop: the human signs in again, then resumes (AD-25 rule 3; AD-9: VTC
      // reads no credential, only the host's own status command). The run pauses rather than
      // parking the step: every later step on the host would fail the same check. IncidentKind
      // has no `auth` kind yet (proposed), so the detail starts with `AUTH_INCIDENT_PREFIX`.
      k.emit(h, {
        type: "incident.recorded",
        actor: "engine",
        ...(step.task === undefined ? {} : { task: step.task }),
        data: {
          kind: "limit",
          detail:
            `${AUTH_INCIDENT_PREFIX}the engine did not start ${step.role} headless: ${detail}`.slice(
              0,
              2000,
            ),
        },
      });
      k.emit(h, {
        type: "run.paused",
        actor: "engine",
        data: {
          reason:
            `${check.host} is not signed in (${detail}): sign in to ${check.host} again, then vtc resume`.slice(
              0,
              300,
            ),
        },
      });
      return;
    case "budget":
      if (step.task !== undefined) {
        // the task keeps its checkpoint; the human raises the budget or drops it (§6.5)
        parkTask(k, h, step.task, {
          reason: "budget",
          detail,
          evidence: [{ type: "file", ref: `.vtc/tasks/${step.task}.md` }],
        });
        return;
      }
      k.emit(h, {
        type: "run.paused",
        actor: "engine",
        data: { reason: `${detail}: raise the budget, then vtc resume`.slice(0, 300) },
      });
      return;
    case "config":
      refuseInSession(
        k,
        h,
        step,
        `the engine did not start ${step.role} unattended: ${detail}; commit or revert the change (the run keeps the config it started with), then answer this escalation to retry`,
      );
  }
};

/**
 * What the engine submits for a finished headless run: a done run's final structured output
 * re-validated as a `RoleResult` (`fromStructuredOutput`); an output that is not one is an error
 * (it counts toward the step's failures, so an unattended run cannot loop on it); every other
 * outcome is the failure it reports.
 */
export const submitInputFor = (actionId: string, outcome: HostOutcome): SubmitInput => {
  if (outcome.kind !== "done") return { kind: "failure", action_id: actionId, outcome };
  const parsed = fromStructuredOutput("RoleResult", outcome.output);
  if (!parsed.success)
    return {
      kind: "failure",
      action_id: actionId,
      outcome: {
        kind: "error",
        message: `the role's final output is not a RoleResult: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`.slice(0, 2000),
        retryable: true,
        tokens: outcome.tokens,
        cost_usd: outcome.cost_usd,
      },
    };
  return {
    kind: "result",
    action_id: actionId,
    result: parsed.data,
    usage: { model: outcome.model, tokens: outcome.tokens, cost_usd: outcome.cost_usd },
    ...(outcome.session_ref === null ? {} : { session_ref: outcome.session_ref }),
  };
};

const spawnError = (message: string): HostOutcome => ({
  kind: "error",
  message: message.slice(0, 2000),
  retryable: true,
  cause: "spawn",
  tokens: null,
  cost_usd: null,
});

/** The run ended (or never started): logged, then submitted like a Lead's `submit`. */
const finishHeadless = async (
  k: Kernel,
  h: RunHandle,
  actionId: string,
  outcome: HostOutcome,
  startedAt: number,
): Promise<void> => {
  k.headless.delete(actionId);
  const run = h.state.roleRuns.get(actionId);
  if (run === undefined) return;
  k.emit(h, {
    type: "headless.ended",
    actor: "engine",
    role: run.role,
    host: run.host,
    ...(run.task === undefined ? {} : { task: run.task }),
    data: {
      action_id: actionId,
      outcome: outcome.kind,
      ...(outcome.kind === "error" && outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      exit_code: null,
      duration_ms: Math.max(0, k.now().getTime() - startedAt),
    },
  });
  if (run.status !== "in_flight") return; // superseded (a resume) while it ran
  // killed by the engine's shutdown: not the role's failure; the run stays in flight, as after a
  // crash, and the next `vtc resume` supersedes it
  if (k.stopping.aborted) return;
  await handleSubmit(k, h, submitInputFor(actionId, outcome));
};

/** Reads the run's stream (its usage events reach the usage store), then its outcome. */
const watch = async (
  k: Kernel,
  h: RunHandle,
  host: HostId,
  actionId: string,
  process: HeadlessRun,
  startedAt: number,
): Promise<void> => {
  const adapter = k.deps.adapters[host];
  try {
    for await (const line of process.lines()) {
      const usage = adapter?.parseEvents([line]).usage ?? null;
      if (usage !== null) k.ingestUsage(usage);
    }
  } catch {
    // the outcome below says what happened
  }
  const outcome = await process.wait().catch((error: unknown): HostOutcome => ({
    kind: "error",
    message: `the headless run could not be awaited: ${error instanceof Error ? error.message : String(error)}`,
    retryable: true,
    cause: "exit_code",
    tokens: null,
    cost_usd: null,
  }));
  await k.serial(h, () => finishHeadless(k, h, actionId, outcome, startedAt));
};

/**
 * Launches one step as an engine-launched headless run (a resume of the step's interrupted
 * session when it has one): the platform rule (`headlessPlatformRefusal`), the preflight, the dispatch record and `role.dispatched` (dispatch
 * `headless`), the role's sandbox profile (refused when unsafe, D-ac), the `HeadlessPolicy`
 * limits, then `spawnRole` / `resume` and `headless.started`. Callers hold the run's lock.
 * Returns whether a run was launched.
 */
export const launchHeadless = async (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  host: HostId,
  purpose: DispatchPurpose,
): Promise<boolean> => {
  const adapter = k.deps.adapters[host];
  const contract = k.deps.roles.get(step.role);
  // a call, not the property: the shutdown may land during any await below
  const stopped = (): boolean => k.stopping.aborted;
  if (adapter === undefined || contract === undefined || stopped()) return false;
  // every engine-launched run (role, auto_resume, cross_family_review) passes the platform rule
  // (`crossFamilyHost` already leaves out a reviewer whose host would be refused here, so the
  // cross-family slot is skipped, never parked)
  const refusal = headlessPlatformRefusal(k, step, host);
  if (refusal !== null) {
    if (purpose !== "cross_family_review") refuseInSession(k, h, step, refusal);
    return false;
  }
  const check = await headlessPreflight(k, h, step, host, purpose);
  k.emit(h, {
    type: "headless.preflight",
    actor: "engine",
    role: step.role,
    ...(step.task === undefined ? {} : { task: step.task }),
    data: check,
  });
  if (!check.ok) {
    preflightFailed(k, h, step, check);
    return false;
  }
  const prepared = await dispatchPrepared(k, h, step, host, "headless");
  if (prepared === null) return false;
  const { action, cwd, model } = prepared;
  const startedAt = k.now().getTime();
  const roleRun = h.state.roleRuns.get(action.action_id);
  const fail = async (message: string): Promise<false> => {
    await finishHeadless(k, h, action.action_id, spawnError(message), startedAt);
    return false;
  };
  if (roleRun === undefined) return fail("the dispatch was not recorded");
  const effective = resolveRoleMode(contract, step.mode);
  const tools = effective.ok ? effective.contract.tools : contract.tools;
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  const sandbox = adapter.sandboxProfile(
    roleSandboxRequest(
      { tools },
      {
        cwd,
        writablePaths: dispatchWriteScope(k.deps.repoRoot, h.state, roleRun)?.worktree_globs ?? [],
        protectedPaths:
          task === undefined ? [] : (await protectedFiles(k, h, task)).map((p) => p.path),
      },
    ),
  );
  const problem = roleSandboxProblem(sandbox);
  if (problem !== null) {
    await fail(problem);
    refuseInSession(k, h, step, problem);
    return false;
  }
  const policy = headlessPolicyFor(k.config().hosts.headless);
  const request: SpawnRoleRequest = {
    role: step.role,
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    model,
    dispatch: "headless",
    cwd,
    prompt: action.prompt,
    outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
    sandbox,
    timeoutMs: policy.wallTimeoutMs,
    idleTimeoutMs: policy.idleTimeoutMs,
    ...(task === undefined
      ? {}
      : {
          maxBudgetUsd: Math.max(0.01, Math.round((task.budget_usd - task.spent_usd) * 100) / 100),
        }),
  };
  // the engine's shutdown may have landed during the awaits above, after `killHeadless` took its
  // snapshot: nothing starts now (the dispatch stays in flight, as after a crash, for vtc resume)
  if (stopped()) return false;
  let spawned: SpawnResult;
  try {
    spawned =
      action.resume === undefined
        ? await adapter.spawnRole(request)
        : await adapter.resume(action.resume, request);
  } catch (error) {
    return fail(
      `${host} could not start the run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (spawned.dispatch !== "headless")
    return fail(`${host} returned a subagent instruction for a headless run`);
  const process = spawned.run;
  if (stopped()) {
    // the shutdown landed while the host was starting it: no watch would run (`Kernel.spawn` is
    // a no-op once stopping) and `killHeadless` already ran, so it is killed here (AD-25: no
    // orphaned processes)
    await process.kill().catch(() => undefined);
    return false;
  }
  const summary: HeadlessRunSummary = {
    action_id: action.action_id,
    role: step.role,
    host,
    ...(step.task === undefined ? {} : { task: step.task }),
    pid: process.pid !== null && process.pid > 0 ? process.pid : null,
    started_at: new Date(startedAt).toISOString(),
  };
  k.headless.set(action.action_id, { run: h.state.id, summary, process });
  k.emit(h, {
    type: "headless.started",
    actor: "engine",
    role: step.role,
    host,
    ...(step.task === undefined ? {} : { task: step.task }),
    data: {
      action_id: action.action_id,
      pid: summary.pid,
      resume: action.resume ?? null,
      wall_timeout_ms: policy.wallTimeoutMs,
      idle_timeout_ms: policy.idleTimeoutMs,
    },
  });
  k.spawn(h, `headless:${action.action_id}`, () =>
    watch(k, h, host, action.action_id, process, startedAt),
  );
  return true;
};

/**
 * Launches every step the engine wants now as a headless run on `host`, within the concurrency
 * limit (reviewers count, §6.6). Callers hold the run's lock and decided `headless` with
 * `planDispatch`. A step that may not run on this platform parks with the refusal
 * (`headlessPlatformRefusal`, checked in {@link launchHeadless}).
 */
export const dispatchHeadless = async (
  k: Kernel,
  h: RunHandle,
  host: HostId,
  purpose: DispatchPurpose,
): Promise<void> => {
  const stop = (): boolean => h.state.run.paused || limitWait(k, h) !== null;
  let free = k.config().concurrency - inFlight(h.state).length;
  for (const step of pendingSteps(k, h, host)) {
    if (free <= 0 || stop()) return;
    // the cross-family reviewer runs on the other family's host (§12.4)
    const where = step.host ?? host;
    const why = step.host === undefined ? purpose : "cross_family_review";
    if (await launchHeadless(k, h, step, where, why)) free -= 1;
  }
};

/**
 * Kills every engine-launched run of `run` (`vtc pause`), or of every run (the engine's shutdown);
 * AD-25 rule 4: no orphans.
 */
export const killHeadless = async (k: Kernel, run?: string): Promise<void> => {
  const entries = [...k.headless.values()].filter((e) => run === undefined || e.run === run);
  await Promise.allSettled(entries.map((e) => e.process.kill()));
};

/** `StatusResult.headless_runs` of one run. */
export const headlessRunsOf = (k: Kernel, run: string): HeadlessRunSummary[] =>
  [...k.headless.values()].filter((e) => e.run === run).map((e) => e.summary);
