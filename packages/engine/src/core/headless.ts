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
import { rmSync } from "node:fs";
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
  type PluginLoadProof,
  type SpawnResult,
  type SpawnRoleRequest,
  type SubmitInput,
} from "@vtc/shared";
import { budgetState } from "./budget.js";
import { dispatchWriteScope } from "./dispatch-scope.js";
import { dispatchPrepared, pendingSteps, refuseInSession, type StepSpec } from "./dispatch.js";
import { protectedFiles } from "./jobs.js";
import { resolveModel } from "./roles.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { deferForUsage, limitWait, stillLimited } from "./limits.js";
import { inFlight } from "./queries.js";
import { parkTask } from "./parking.js";
import {
  armPluginNotLoaded,
  deferReplays,
  recordTrialIsolation,
  replayTrialOf,
  trialProtectedFiles,
  trialReadDeny,
} from "./replay.js";
import { headlessPlatformRefusal, roleSandboxProblem, roleSandboxRequest } from "./sandbox.js";
import { hostWebRouteFor } from "./host-web.js";
import { PARSE_FAILURE_PREFIX } from "./state.js";
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
 * The model id a step runs on `host` (`resolveModel`), or `undefined`: the host session's model,
 * which no price table can price.
 */
const stepModel = (
  k: Kernel,
  step: Pick<StepSpec, "role" | "mode" | "tier">,
  host: HostId,
): string | undefined => {
  const contract = k.deps.roles.get(step.role);
  return contract === undefined
    ? undefined
    : resolveModel(contract, host, k.config(), {
        ...(step.mode === undefined ? {} : { mode: step.mode }),
        ...(step.tier === undefined ? {} : { tier: step.tier }),
      }).model;
};

/**
 * Why a run on `host` cannot be budget-checked, or `null` (§11, H-1; spine §5 reading 152): a
 * host that cannot cap its own spend (`HostCapabilities.budgetCap` false: Codex, which reports no
 * cost either) is priced from the user's price table, so its model needs an id and a price there.
 * A model missing from the price table is an error, never $0.
 */
export const unpricedRun = (
  k: Kernel,
  step: Pick<StepSpec, "role" | "mode" | "tier">,
  host: HostId,
): string | null => {
  const adapter = k.deps.adapters[host];
  if (adapter === undefined || adapter.capabilities.budgetCap) return null;
  const model = stepModel(k, step, host);
  if (model === undefined)
    return `${step.role} has no ${host} model id (set hosts.models.${host} in .vtc/project.yaml), so its run cannot be priced and budget-checked (§11)`;
  if (k.deps.prices?.[model] === undefined)
    return `no list price for ${host} model ${model} in ~/.vtc/config.yaml prices: ${host} reports no cost, so the engine prices its tokens to budget-check the run (§11: a model missing from the price table is an error)`;
  return null;
};

/** Whether a failed budget check was {@link unpricedRun}'s (the fix is a price, not a raise). */
const unpricedDetail = (detail: string): boolean =>
  detail.includes("cannot be priced") || detail.includes("no list price");

/**
 * The checks before an engine-launched start or resume (AD-25 rule 3), in order: the run is not
 * paused; the config files still give the run's `pipeline_config_hash`; the host's five-hour
 * window is not used up; the host's own sign-in check (`HostAdapter.authStatus`, when the adapter
 * has one) says logged in (an API-key login is allowed, and who pays is kept on the host's usage
 * snapshot for the API-key billing warning: D-bq, spine §5 reading 171); the budget: the run can be priced
 * ({@link unpricedRun}, when the step names its role) and the task (or the run) has budget left.
 */
export const headlessPreflight = async (
  k: Kernel,
  h: RunHandle,
  step: Pick<StepSpec, "task"> & Partial<Pick<StepSpec, "role" | "mode" | "tier">>,
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
    // D-bq (reading 171, supersedes reading 141): an API-key login runs roles; who pays reaches
    // `UsageSnapshot.billing`, so Flow Studio shows `API_KEY_BILLING_WARNING`
    k.recordBilling(host, status.billing ?? null);
  }
  const unpriced =
    step.role === undefined ? null : unpricedRun(k, { ...step, role: step.role }, host);
  if (unpriced !== null) return fail("budget", unpriced);
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
 * A failed preflight: nothing launches, and nothing retries in a loop. `usage` waits for the
 * reset (the timer is scheduled); `auth` records an incident and pauses the run until the human
 * signs in again and resumes; `config` parks the step for the human; `budget` parks its task.
 * A Lookback replay trial pauses nothing (reading 176): the replays stop and wait for the next
 * RETRO, and the delivered run finishes (`deferReplays`; a sign-in failure is still an incident).
 */
const preflightFailed = (
  k: Kernel,
  h: RunHandle,
  step: StepSpec,
  check: HeadlessPreflight,
): void => {
  const detail = check.detail ?? "the headless preflight failed";
  if (step.replay !== undefined && check.failed !== undefined && check.failed !== "paused") {
    if (check.failed === "auth")
      k.emit(h, {
        type: "incident.recorded",
        actor: "engine",
        data: {
          kind: "auth",
          detail:
            `the engine did not start a replay trial of ${step.role} headless: ${detail}`.slice(
              0,
              2000,
            ),
        },
      });
    deferReplays(
      k,
      h,
      `a headless trial of ${step.role} could not start (${check.failed}): ${detail}`,
      // a limit (D-cg): the budget, or the host's usage window; anything else is no limit
      check.failed === "budget" ? "budget" : check.failed === "usage" ? "weekly_window" : null,
    );
    return;
  }
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
      // parking the step: every later step on the host would fail the same check (spine §5
      // reading 111)
      k.emit(h, {
        type: "incident.recorded",
        actor: "engine",
        ...(step.task === undefined ? {} : { task: step.task }),
        data: {
          kind: "auth",
          detail: `the engine did not start ${step.role} headless: ${detail}`.slice(0, 2000),
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
        data: {
          reason: (unpricedDetail(detail)
            ? `${detail}; then vtc resume`
            : `${detail}: raise the budget, then vtc resume`
          ).slice(0, 300),
        },
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
        message:
          `${PARSE_FAILURE_PREFIX} the role's final output is not a RoleResult: ${parsed.error.issues
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

/**
 * What a run `vtc pause` killed ended with: unless it finished first, a failure with cause
 * `killed`. Its `headless.ended` after the logged pause marks the run `stopped` (state.ts), so it
 * never counts toward the stuck limit; what the host reported it cost still counts (D-at).
 */
export const pausedOutcome = (outcome: HostOutcome): HostOutcome => {
  if (outcome.kind === "done") return outcome;
  const detail = outcome.kind === "error" || outcome.kind === "auth" ? outcome.message : "a limit";
  return {
    kind: "error",
    message: `stopped by vtc pause (the kill switch): ${detail}`.slice(0, 2000),
    retryable: true,
    cause: "killed",
    tokens: outcome.kind === "auth" ? null : outcome.tokens,
    cost_usd: outcome.kind === "auth" ? null : outcome.cost_usd,
  };
};

/**
 * What a run the engine stopped on budget ended with (§11: the task parked, its in-flight runs
 * stop): unless it finished first, a failure with cause `budget`, marked stopped in the state
 * (its task is parked), so it never counts toward the stuck limit; its reported cost still counts.
 */
export const budgetStoppedOutcome = (outcome: HostOutcome): HostOutcome => {
  if (outcome.kind === "done") return outcome;
  const detail = outcome.kind === "error" || outcome.kind === "auth" ? outcome.message : "a limit";
  return {
    kind: "error",
    message: `stopped by the engine: the task's budget is used up (${detail})`.slice(0, 2000),
    retryable: false,
    cause: "budget",
    tokens: outcome.kind === "auth" ? null : outcome.tokens,
    cost_usd: outcome.kind === "auth" ? null : outcome.cost_usd,
  };
};

/** Whether the step's task, or the run, has spent its whole budget (the preflight parks it). */
const budgetUsedUp = (h: RunHandle, step: Pick<StepSpec, "task">): boolean => {
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  if (task !== undefined && budgetState(task.spent_usd, task.budget_usd) === "exhausted")
    return true;
  const run = h.state.runBudget;
  return run !== null && run.spent_usd >= run.budget_usd;
};

/**
 * The USD cap of a headless run (§11; `SpawnRoleRequest.maxBudgetUsd`, which Claude enforces with
 * `--max-budget-usd`): what is left of its pool (its task's budget, else the run's, which a
 * task-less step's spend counts toward), less what the pool's in-flight headless runs were capped
 * at, split evenly over the `share` runs launched from it together. `null` when no budget applies
 * yet (before the plan sets one). A cap under one cent means nothing may launch from the pool now.
 */
export const headlessBudgetCap = (
  k: Pick<Kernel, "headless">,
  h: RunHandle,
  step: Pick<StepSpec, "task">,
  share = 1,
): { readonly pool: string; readonly capUsd: number } | null => {
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  // before the first spend is recorded, the run's budget is its features' (submit.ts `recordSpend`)
  const features = [...h.state.features.values()];
  const run =
    h.state.runBudget ??
    (features.length === 0
      ? null
      : {
          budget_usd: features.reduce((sum, f) => sum + f.budget_usd, 0),
          spent_usd: features.reduce((sum, f) => sum + f.spent_usd, 0),
        });
  const pool =
    task !== undefined
      ? { key: `task:${task.id}`, left: task.budget_usd - task.spent_usd }
      : run !== null
        ? { key: "run", left: run.budget_usd - run.spent_usd }
        : null;
  if (pool === null) return null;
  let allotted = 0;
  for (const entry of k.headless.values())
    if (entry.run === h.state.id && entry.budget?.pool === pool.key)
      allotted += entry.budget.capUsd;
  const capUsd = Math.floor((Math.max(0, pool.left - allotted) / Math.max(1, share)) * 100) / 100;
  return { pool: pool.key, capUsd };
};

/**
 * Why a replay trial run with its own arm plugin did not prove that copy loaded (D-cg, spine §5
 * reading 201), or `null` when it did: the adapter's `HeadlessRun.pluginLoad` must report the
 * directory the engine passed.
 */
export const pluginLoadProblem = (
  pluginDir: string,
  proof: PluginLoadProof | undefined,
): string | null => {
  if (proof === undefined) return "the host adapter cannot prove which plugin copy the run loaded";
  if (!proof.loaded) return `the arm plugin did not load: ${proof.reason}`;
  return proof.dir === pluginDir ? null : "the run loaded another plugin copy than the arm's";
};

/** The run ended (or never started): logged, then submitted like a Lead's `submit`. */
const finishHeadless = async (
  k: Kernel,
  h: RunHandle,
  actionId: string,
  ended: HostOutcome,
  startedAt: number,
  proof?: PluginLoadProof,
): Promise<void> => {
  const entry = k.headless.get(actionId);
  const outcome =
    entry?.stoppedByPause === true
      ? pausedOutcome(ended)
      : entry?.stoppedByBudget === true
        ? budgetStoppedOutcome(ended)
        : ended;
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
  const pluginDir = entry?.pluginDir;
  if (pluginDir !== undefined) {
    // the host has exited: the arm's plugin copy is no longer loaded from
    rmSync(pluginDir, { recursive: true, force: true });
    const problem =
      entry?.stoppedByPause === true || entry?.stoppedByBudget === true
        ? null
        : pluginLoadProblem(pluginDir, proof);
    const trial = problem === null ? undefined : replayTrialOf(k, h, actionId);
    if (problem !== null && trial !== undefined) {
      // gate_infra, never a verdict: the trial measured nothing, and its run ends as a failure
      armPluginNotLoaded(k, h, trial, actionId, problem);
      await handleSubmit(k, h, {
        kind: "failure",
        action_id: actionId,
        outcome: {
          kind: "error",
          message: `the replay trial did not run its arm's plugin: ${problem}`.slice(0, 2000),
          retryable: false,
          cause: "spawn",
          tokens: outcome.kind === "auth" || outcome.kind === "limit" ? null : outcome.tokens,
          cost_usd: outcome.kind === "auth" || outcome.kind === "limit" ? null : outcome.cost_usd,
        },
      });
      return;
    }
  }
  // a done run's failure is the engine's parse failure, worded by the engine (AD-8)
  await handleSubmit(
    k,
    h,
    submitInputFor(actionId, outcome),
    outcome.kind === "done" ? "engine" : "reported",
  );
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
  // D-cg: a run with an arm plugin proves which copy it loaded, after wait()
  const proof =
    k.headless.get(actionId)?.pluginDir === undefined
      ? undefined
      : await (process.pluginLoad?.() ?? Promise.resolve(undefined)).catch(
          (error: unknown): PluginLoadProof => ({
            loaded: false,
            reason: `the load proof could not be read: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
  await k.serial(h, () => finishHeadless(k, h, actionId, outcome, startedAt, proof));
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
  share = 1,
  /** `false`: a `host_web` role runs without its host's web search (D-cf, `hostWebRoute`). */
  hostWeb = true,
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
  // §11: a pool whose budget the in-flight runs already hold launches nothing until they end
  const budget = headlessBudgetCap(k, h, step, share);
  if (budget !== null && budget.capUsd < 0.01 && !budgetUsedUp(h, step)) return false;
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
  const { action, cwd, model, roleCore } = prepared;
  const startedAt = k.now().getTime();
  const roleRun = h.state.roleRuns.get(action.action_id);
  const fail = async (message: string): Promise<false> => {
    if (prepared.pluginDir !== undefined)
      rmSync(prepared.pluginDir, { recursive: true, force: true });
    await finishHeadless(k, h, action.action_id, spawnError(message), startedAt);
    return false;
  };
  if (roleRun === undefined) return fail("the dispatch was not recorded");
  // reading 145: never a role run without its role (the host cannot load the compiled agent)
  if (roleCore === null)
    return fail(
      `the compiled role instructions of ${step.role} are missing from the ${host} plugin or do not match its manifest`,
    );
  const effective = resolveRoleMode(contract, step.mode);
  const declared = effective.ok ? effective.contract.tools : contract.tools;
  // D-cf: no safe host web search on the route, so none at all (the engine's fetchers remain)
  const tools = hostWeb ? declared : { ...declared, host_web: false };
  const task = step.task === undefined ? undefined : h.state.tasks.get(step.task);
  const sandbox = adapter.sandboxProfile(
    roleSandboxRequest(
      { tools },
      {
        cwd,
        writablePaths: dispatchWriteScope(k.deps.repoRoot, h.state, roleRun)?.worktree_globs ?? [],
        protectedPaths: (step.replay !== undefined
          ? await trialProtectedFiles(k, step.replay)
          : task === undefined
            ? []
            : await protectedFiles(k, h, task)
        ).map((p) => p.path),
        // reading 178: a trial may read neither the user's repo nor its git directory
        ...(step.replay === undefined ? {} : { readDeny: await trialReadDeny(k) }),
      },
    ),
  );
  const problem = roleSandboxProblem(sandbox);
  if (problem !== null) {
    await fail(problem);
    refuseInSession(k, h, step, problem);
    return false;
  }
  // what the host enforced goes to Lookback with the trial (`ReplayResult.isolation`)
  if (step.replay !== undefined)
    recordTrialIsolation(k, h, step.replay, sandbox.enforced.readDeny === true);
  const policy = headlessPolicyFor(k.config().hosts.headless);
  const request: SpawnRoleRequest = {
    role: step.role,
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    model,
    dispatch: "headless",
    cwd,
    prompt: roleCore === undefined ? action.prompt : `${roleCore}\n\n---\n\n${action.prompt}`,
    outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
    sandbox,
    timeoutMs: policy.wallTimeoutMs,
    idleTimeoutMs: policy.idleTimeoutMs,
    // §11: a task-less step is capped from the run's budget; steps launched together share it
    ...(budget === null ? {} : { maxBudgetUsd: Math.max(0.01, budget.capUsd) }),
    // D-cg: a replay arm's own compiled plugin
    ...(prepared.pluginDir === undefined ? {} : { pluginDir: prepared.pluginDir }),
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
  k.headless.set(action.action_id, {
    run: h.state.id,
    summary,
    process,
    ...(budget === null ? {} : { budget: { pool: budget.pool, capUsd: budget.capUsd } }),
    ...(prepared.pluginDir === undefined ? {} : { pluginDir: prepared.pluginDir }),
  });
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
  const steps = pendingSteps(k, h, host);
  // §11: the steps of one budget pool launched in this pass split what is left of it
  const pool = (step: StepSpec): string => (step.task === undefined ? "run" : `task:${step.task}`);
  const left = new Map<string, number>();
  for (const step of steps.slice(0, Math.max(0, free)))
    left.set(pool(step), (left.get(pool(step)) ?? 0) + 1);
  for (const step of steps) {
    if (free <= 0 || stop()) return;
    // a host_web role goes where its host's web search is safe, or runs without it (D-cf)
    const web =
      step.host === undefined && step.purpose === undefined
        ? hostWebRouteFor(k, step, k.leadHostFor(h.state.id, { host: null }), host)
        : null;
    if (web !== null && !web.hostWeb) k.relay(h.state.id, web.notice);
    // the cross-family reviewer runs on the other family's host (§12.4)
    const where = step.host ?? web?.host ?? host;
    const why = step.host === undefined ? (step.purpose ?? purpose) : "cross_family_review";
    const share = left.get(pool(step)) ?? 1;
    left.set(pool(step), Math.max(1, share - 1));
    if (await launchHeadless(k, h, step, where, why, share, web?.hostWeb ?? true)) free -= 1;
  }
};

/**
 * Kills every engine-launched run of `run` (`vtc pause`: each is then submitted as stopped, not
 * failed, {@link pausedOutcome}), or of every run (the engine's shutdown); AD-25 rule 4: no
 * orphans.
 */
export const killHeadless = async (k: Kernel, run?: string): Promise<void> => {
  const entries = [...k.headless.values()].filter((e) => run === undefined || e.run === run);
  // the pause, not the role, ended these (the shutdown's are left in flight instead)
  if (run !== undefined) for (const entry of entries) entry.stoppedByPause = true;
  await Promise.allSettled(entries.map((e) => e.process.kill()));
};

/** `StatusResult.headless_runs` of one run. */
export const headlessRunsOf = (k: Kernel, run: string): HeadlessRunSummary[] =>
  [...k.headless.values()].filter((e) => e.run === run).map((e) => e.summary);
