/**
 * Daemon composition (AD-19; owner: engine-core team, sub-project 1). Implements the frozen
 * seam from @vtc/shared: `runDaemon` takes the engine lock, wires core to the injected Gate
 * Runner, host adapters, storage, assets and timer, serves MCP on the local socket and HTTP/SSE
 * on 127.0.0.1, and publishes discovery (AD-12); `serveSnapshot` serves the committed `.vtc/`
 * read-only for `vtc dashboard` (AD-5 rule 7). It may import the core, git, http, mcp, research,
 * lookback and upstream entries (it is where those modules meet core, AD-13 rules 12 and 13); it
 * never imports gates
 * (the Gate Runner arrives in `EngineDeps`) and never loads a storage driver (the cli injects
 * `openStorage`).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  agentNameFor,
  dotenvValues,
  ENGINE_HTTP,
  engineRepoKey,
  ENGINE_INSTANCE,
  engineSocketFile,
  engineWindowsPipe,
  FetcherIdSchema,
  HOST_IDS,
  remainingPct,
  researchScopeFor,
  routingConfigSubject,
  usageFromStatuslineIngest,
  type AutomationSettings,
  type EngineDeps,
  type HostId,
  type ResearchScope,
  type RunDaemon,
  type VtcEvent,
  type RunningDaemon,
  type RunningSnapshot,
  type ServeSnapshot,
} from "@vtc/shared";
import {
  compiledRoleContracts,
  createReadModel,
  createRoleRegistry,
  Engine,
  EngineError,
  INDEX_PATH,
  isReplayTrialEvent,
  loadProjectConfig,
  loadRuns,
  openEventIndex,
  pluginCatalogFrom,
  readClientSpend,
  removeEngineDiscovery,
  replayGraderOf,
  replayTrialActionIds,
  withoutReplayTrialEvents,
  takeEngineLock,
  writeEngineDiscovery,
  type AutomationFact,
  type LookbackRetro,
  type PluginCatalog,
  type RoutingLookback,
  type RoutingProposalCell,
  type RunState,
  type StaleLockReason,
} from "../core/index.js";
import {
  createGhPullRequests,
  createGitOps,
  createGitPlumbing,
  createRemoteRefs,
  createWorkspace,
} from "../git/index.js";
import {
  createHttpApi,
  createPrototypeServer,
  createSessionStore,
  type PrototypeServer,
} from "../http/index.js";
import {
  createLookbackRetro,
  createPromptPins,
  evaluateCanaries,
  graderBundleSha,
  loadPromptVersion,
  lookbackAtRunEnd,
  lookbackRoutingStep,
  lookbackRunEndFacts,
  newAgentReportFields,
  readProposalFiles,
  readTiebreakKeys,
  type InstalledRole,
  type LockedShaFor,
  type NewAgentSignal,
} from "../lookback/index.js";
import { engineSocketAnswers, serveEngineSocket } from "../mcp/index.js";
import { isGitHubRemote, readScorecards, wireAutomation } from "./automation.js";
import { evidenceSnapshot } from "./evidence-snapshot.js";
import {
  bridgeUpstream,
  githubRepoOf,
  readLookbackPrInput,
  type CreateUpstreamModule,
} from "./upstream-bridge.js";
import { createLookbackReplays, liveLookbackConfig } from "./replays.js";
import { createUpstream } from "../upstream/index.js";
import {
  createFetchQuota,
  createFileResearchCache,
  createResearchService,
  type FetchQuota,
  type ResearchEventDraft,
  type ResearchService,
  type ResearchServiceDeps,
} from "../research/index.js";

/**
 * A run's events as Lookback reads them (reading 176): without its replay trials, which measure a
 * version and are no trace of the run's work (no attribution, no scorecard dispatch). A trial is
 * marked in the log (`role.dispatched.purpose`, reading 177), so a clone or a machine without the
 * engine's private `<guard>/replays/` file still leaves it out; `privateTrials` (that file's
 * actions) covers logs written before contracts 4.11.0.
 */
export const lookbackEventsOf = (
  state: Pick<RunState, "events">,
  privateTrials: ReadonlySet<string> = new Set(),
): readonly VtcEvent[] =>
  withoutReplayTrialEvents(
    state.events,
    new Set([...privateTrials, ...replayTrialActionIds(state.events)]),
  );

/**
 * The engine's events as the live SSE stream sends them (reading 177): without a replay trial's
 * `role.*` and `headless.*` events, as the paged event view and the replay on connect leave them
 * out, so the live view and a reload show the same events.
 */
export const liveEvents = (
  engine: Pick<Engine, "onEvent" | "states">,
  listener: (event: VtcEvent) => void,
): (() => void) =>
  engine.onEvent((event) => {
    const state = engine.states().find((s) => s.id === event.run);
    if (state !== undefined && isReplayTrialEvent(state, event)) return;
    listener(event);
  });

export interface ResearchWiringOptions {
  /** Network requests per run for the role tools (`createFetchQuota`'s default when absent). */
  readonly quotaPerRun?: number;
  /** The per-run research quota itself (default `createFetchQuota(quotaPerRun)`). */
  readonly quota?: FetchQuota;
  /** How often the cache is pruned (the first prune runs one interval after the start). */
  readonly pruneEveryMs?: number;
}

/** How often the daemon prunes the research cache (lookback-research's eviction, AD-22). */
export const RESEARCH_PRUNE_MS = 24 * 60 * 60_000;

/**
 * The research module wired into the engine (AD-22, spine §5 reading 120): its handlers serve
 * the role-facing tools (`ROLE_MCP_TOOLS`), and before each G2 it re-fetches stale facts and
 * hands core the re-checked table. A call is served only while a role run that declares the tool
 * is in flight; the fact row records that role. The events it emits go to that run's log. Each
 * run's role calls share one research quota, dropped at `run.finished`, and the cache is pruned on
 * a schedule (spine §5 reading 138). Search runs on the host's own web search in the role session
 * (H-3, reading 156): the keyed `search` fetcher is the user's opt-in (`researchSearchProvider`,
 * no default), handed to the service, and without it that fetcher gets no key, so it sends
 * nothing. Returns the cleanup the daemon runs at shutdown.
 */
export const wireResearch = (
  engine: Engine,
  deps: Pick<
    EngineDeps,
    "repoRoot" | "vtcHome" | "http" | "researchApiKey" | "researchSearchProvider" | "now"
  >,
  options: ResearchWiringOptions = {},
): (() => void) => {
  const scope = ((): ResearchScope => {
    try {
      return researchScopeFor(engine.config().client);
    } catch {
      return researchScopeFor(undefined);
    }
  })();
  const cache = createFileResearchCache(deps.vtcHome);
  // one quota for the daemon's life: the service is built per call, the per-run counts outlive it
  // (the G2 re-check, run undefined, takes none)
  const quota = options.quota ?? createFetchQuota(options.quotaPerRun);
  const keyOf = deps.researchApiKey;
  // H-3 (reading 156): search runs on the host's own web search in the role session; the keyed
  // `search` fetcher is an opt-in with no default, so without a provider it gets no key and sends
  // nothing
  const provider = deps.researchSearchProvider;
  const serviceFor = (run: string | undefined): ResearchService => {
    const service: ResearchServiceDeps = {
      projectRoot: deps.repoRoot,
      cache,
      scope,
      http: deps.http,
      ...(provider === undefined ? {} : { searchProvider: provider }),
      ...(run === undefined ? {} : { quota: quota.forRun(run) }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(keyOf === undefined
        ? {}
        : {
            apiKey: (fetcher: string) => {
              const id = FetcherIdSchema.safeParse(fetcher);
              if (!id.success) return undefined;
              if (id.data === "search" && provider === undefined) return undefined;
              return keyOf(id.data);
            },
          }),
      knownValues: () => engine.secrets(),
      onEvent: (event: ResearchEventDraft) => {
        engine.recordModuleEvent(run, event);
      },
    };
    return createResearchService(service);
  };
  engine.setRoleTools(async (name, input) => {
    const caller = engine.roleCalling(name);
    if (caller === undefined)
      throw new EngineError("forbidden", `no role run in flight declares ${name}`);
    const service = serviceFor(caller.run);
    switch (name) {
      case "research_fetch":
        return service.researchFetch(input);
      case "fact_lookup":
        return service.factLookup(input);
      case "fact_propose":
        return service.factPropose(input, caller.role);
    }
  });
  engine.setFactRefresher(async () => (await serviceFor(undefined).g2Facts([])).facts);
  // a finished run's count is dropped, so the counts do not grow for the daemon's life
  const off = engine.onEvent((event) => {
    if (event.type === "run.finished") quota.forget(event.run);
  });
  // eviction of blobs nothing cites; a failed prune is retried at the next interval
  const prune = setInterval(() => {
    serviceFor(undefined)
      .pruneCache()
      .catch(() => undefined);
  }, options.pruneEveryMs ?? RESEARCH_PRUNE_MS);
  prune.unref();
  return () => {
    off();
    clearInterval(prune);
  };
};

/**
 * The host the lookback role of `state` runs on, and the percent of its weekly window left (AD-21
 * rule 8, spine §5 reading 176): the run's live Lead host, else the host its limit names, else the
 * engine's default host; `null` when that host's weekly window is unknown (then Lookback waits).
 */
export const lookbackWindow = (
  engine: Pick<Engine, "liveLeadHost" | "hostFor" | "usage">,
  state: Pick<RunState, "id" | "limit">,
): { readonly host: HostId; readonly pct: number | null } => {
  const host = engine.liveLeadHost(state.id) ?? state.limit?.host ?? engine.hostFor({ host: null });
  const weekly = engine.usage.get(host)?.windows.find((w) => w.kind === "weekly");
  return { host, pct: weekly === undefined ? null : remainingPct(weekly) };
};

/**
 * The Lookback module wired into the engine (AD-21; spine §5 reading 144):
 * - core's prompt selector (`Engine.setPromptPins`, reading 135(d)): each dispatch of an agent the
 *   plugin compiled without its editable section runs the human's pin or the task's canary arm
 *   from `~/.vtc/lookback/pins.yaml`, re-read when the file changes;
 * - as a canary dispatch ends (`role.submitted` of a dispatch with a `canary_arm`, rule 7), the
 *   project's canaries are evaluated over every run's events, `lookback.canary_evaluated` (and, on
 *   a rollback verdict, the engine's `auto_rollback` and `lookback.rolled_back`) going to that run;
 * - at RETRO, before the run finishes (rules 4 and 8, spine §5 reading 154), core's
 *   `LookbackRetro` (`createLookbackRetro`): the run is attributed, the scorecards rewritten, and
 *   the lookback role queued for each target (`lookback.dispatched`), reading the input the module
 *   renders; its proposal is checked on submit, and an accepted one stored as a candidate version
 *   (`lookback.proposal_recorded`);
 * - then, at RETRO, the replays (rule 6, reading 176, `createLookbackReplays`): every proposal not
 *   yet replayed, its `lookback_replay` trials run in clean checkouts and graded through the Gate
 *   Runner, its `ReplayResult` and `lookback.replay_finished` written; the weekly window checked is
 *   the run's Lead host's ({@link lookbackWindow});
 * - at `run.finished` (an aborted run too) the run's failures are attributed to
 *   `.vtc/lookback/attributions.jsonl` and the scorecards of every version in the history are
 *   rewritten under `.vtc/lookback/scorecards/`. Only the AI tiebreak answers the engine recorded
 *   in the lookback module's tiebreak store (`readTiebreakKeys`) let an `ai_tiebreak` row count.
 *   v1 runs no AI tiebreak (spine §5 reading 182, §7 row "Lookback AI tiebreak"): the store stays
 *   empty, no `ai_tiebreak` row counts, and RETRO logs the failures the tree left inconclusive as
 *   `lookback.unattributed` (the plan's `events`), which the dashboard shows.
 * Lookback work at `run.finished` runs one job at a time and never fails the engine; the returned
 * cleanup waits for the job in flight.
 */
/**
 * A new-agent signal (D-cd) as an automation fact of `run`: its subject is the proposed role (the
 * module fingerprints it), and only `newAgentReportFields`' VTC-side fields may leave the machine
 * (the role only when VTC named it after a shipped discipline).
 */
export const newAgentFact = (run: string, signal: NewAgentSignal, at: string): AutomationFact => {
  const report = newAgentReportFields(signal);
  return {
    target: "upstream",
    kind: "new_agent",
    run,
    source: "lookback.new_agent",
    at,
    subject: signal.proposed_role,
    ...(report.role === undefined ? {} : { role: report.role }),
    ...(report.metrics === undefined ? {} : { metrics: report.metrics }),
    detail: `${String(signal.failures)} failure(s) and ${String(signal.escalations)} escalation(s) point to a missing specialist (${signal.basis})`,
  };
};

// D-cn's seam (`RoutingLookback`, `RoutingProposalCell`) lives in core's index, so the lookback
// module's routing step names the type it implements without importing the daemon (AD-13 rule 12)
export type { RoutingLookback, RoutingProposalCell };

/**
 * A routing proposal (D-cn) as an automation fact of `run`: a `config` improvement whose subject
 * is the cell (`routingConfigSubject`, `routing.<role>.<size>.<risk>`), with the scorecard numbers
 * only; the PR it leads to changes the values of `DEFAULT_ROUTING_TABLE` (spine §5 reading 219).
 */
export const routingConfigFact = (
  run: string,
  cell: RoutingProposalCell,
  at: string,
): AutomationFact => ({
  target: "upstream",
  kind: "config",
  run,
  source: "lookback.routing",
  at,
  subject: routingConfigSubject(cell.role, cell.size, cell.risk),
  ...(cell.metrics === undefined ? {} : { metrics: cell.metrics }),
  detail: cell.detail.slice(0, 2000),
});

export const wireLookback = (
  engine: Engine,
  deps: Pick<EngineDeps, "repoRoot" | "vtcHome" | "now">,
  plugins: PluginCatalog,
  /** After the scorecards are rewritten at a run's end (the automation's cost regressions). */
  onScorecards?: (run: string) => void,
  /**
   * D-cd: the roles this vtc carries, and where Lookback's new-agent signals of a run's end go
   * (the automation's improvements). Absent: no new-agent signals.
   */
  newAgents?: {
    readonly roles: () => readonly InstalledRole[];
    readonly found: (run: string, signals: readonly NewAgentSignal[]) => void;
  },
  /**
   * D-cn (spine §5 reading 219): Lookback's routing step, run at RETRO through the `LookbackRetro`
   * seam once the run's plan is made, and where its proposals go as `config` facts (the
   * automation's improvements). Absent: no routing scorecard and no routing proposal.
   */
  routing?: {
    readonly propose: RoutingLookback;
    readonly found: (run: string, facts: readonly AutomationFact[]) => void;
  },
  /**
   * D-cr (spine §5 reading 226): where a run's end hands Lookback's drift regressions (a prompt
   * version against its own earlier window, `lookbackRunEndFacts`) as `cost` facts (the
   * automation's improvements). Absent: a drift only becomes a lookback target.
   */
  drift?: {
    readonly found: (run: string, facts: readonly AutomationFact[]) => void;
  },
): (() => Promise<void>) => {
  const now = deps.now ?? (() => new Date());
  const repoKey = engineRepoKey(deps.repoRoot);
  engine.setPromptPins(
    createPromptPins({
      vtcHome: deps.vtcHome,
      repoKey,
      compiled: (agent, host) => plugins.promptParts?.(agent, host)?.compiled,
    }),
  );
  // every mode of a role shares its prompt sections (reading 118)
  const lockedShaFor: LockedShaFor = (role, mode, host) =>
    plugins.promptParts?.(agentNameFor(role, mode), host)?.lockedSha256;
  // a run's events as Lookback reads them: without its replay trials, which measure a version and
  // are no trace of the run's work (no attribution, no scorecard dispatch; reading 176)
  const lookbackEvents = (state: RunState): readonly VtcEvent[] =>
    lookbackEventsOf(state, engine.replayTrialActions(state.id));
  const history = () => engine.states().flatMap(lookbackEvents);
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>): void => {
    chain = chain.then(job).catch((error: unknown) => {
      process.stderr.write(
        `vtc engine: lookback: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };
  const canaries = (run: string, role: string | undefined): Promise<void> =>
    evaluateCanaries({ vtcHome: deps.vtcHome, repoKey, events: history(), now: now() }).then(
      ({ events }) => {
        for (const draft of events) {
          // the canary that just got a dispatch, and every rollback
          if (draft.type === "lookback.canary_evaluated" && draft.data.role !== role) continue;
          engine.recordModuleEvent(run, draft);
        }
      },
    );
  // rule 8 (reading 176): the window of the run's Lead host, where the lookback role runs
  const weeklyRemaining = (state: RunState): number | null => lookbackWindow(engine, state).pct;
  // the AI tiebreak answers the engine recorded (readings 137, 175): only these ai_tiebreak rows
  // count, read from the engine-owned store under the VTC home (`LOOKBACK_HOME.tiebreaksFile`).
  // v1 produces none (reading 182), so the store stays empty and none counts (fail closed)
  const tiebreaks = (): Promise<ReadonlySet<string>> => readTiebreakKeys(deps.vtcHome, repoKey);
  const bundleSha = (): string =>
    graderBundleSha({ judgeModel: null, gatesConfigHash: engine.gatesConfigHash() });
  const budgetAvailable = (state: RunState): boolean =>
    state.runBudget === null || state.runBudget.spent_usd < state.runBudget.budget_usd;
  // AD-21 rules 4 and 8: the lookback role at RETRO, before the run finishes (reading 154); the
  // weekly window is the planned run's Lead host's (reading 176). Built per call, so each RETRO
  // sees the roles installed then (D-cd), as the run's end does
  const retro = (): LookbackRetro =>
    createLookbackRetro({
      projectRoot: deps.repoRoot,
      vtcHome: deps.vtcHome,
      history,
      lockedShaFor,
      compiled: (role, mode, host) =>
        plugins.promptParts?.(agentNameFor(role, mode), host)?.compiled,
      graderBundleSha: bundleSha,
      weeklyRemainingPct: weeklyRemaining,
      budgetAvailable,
      now,
      ...(newAgents === undefined ? {} : { roles: newAgents.roles() }),
    });
  // AD-21 rule 6 (reading 176): after the targets, RETRO replays every proposal not yet replayed
  const replays = createLookbackReplays({
    projectRoot: deps.repoRoot,
    vtcHome: deps.vtcHome,
    repoKey,
    history,
    lockedShaFor,
    compiled: (role, mode, host) => plugins.promptParts?.(agentNameFor(role, mode), host)?.compiled,
    tiebreaks,
    graderBundleSha: bundleSha,
    weeklyWindow: (state) => lookbackWindow(engine, state),
    budgetAvailable,
    gateRunner: engine.deps.gateRunner,
    now,
    graderOf: (replay) => replayGraderOf(engine, replay),
    // D-cq (reading 224): the user's replay pace, `~/.vtc/config.yaml` `lookback`
    lookback: liveLookbackConfig(deps.vtcHome, (message) => {
      process.stderr.write(`vtc engine: lookback: ${message}\n`);
    }),
  });
  // D-cn: the routing scorecard and proposals at RETRO, on the Lookback queue so RETRO never waits
  // on them; a step that fails is told on stderr and the run goes on
  const routingAtRetro = (run: string): void => {
    if (routing === undefined) return;
    enqueue(async () => {
      const cells = await routing.propose({
        projectRoot: deps.repoRoot,
        history: history(),
        graderBundleSha: bundleSha(),
        now: now(),
        lockedShaFor,
        vtcHome: deps.vtcHome,
      });
      const at = now().toISOString();
      if (cells.length > 0)
        routing.found(
          run,
          cells.map((cell) => routingConfigFact(run, cell, at)),
        );
    });
  };
  engine.setLookbackRetro({
    plan: async (state) => {
      const plan = await retro().plan({ ...state, events: [...lookbackEvents(state)] });
      routingAtRetro(state.id);
      return plan;
    },
    check: (target, root, state) => retro().check(target, root, state),
    ...replays,
  });
  const runEnd = async (run: string): Promise<void> => {
    const state = engine.states().find((s) => s.id === run);
    if (state === undefined) return;
    const result = await lookbackAtRunEnd({
      projectRoot: deps.repoRoot,
      events: lookbackEvents(state),
      history: history(),
      lockedShaFor,
      graderBundleSha: bundleSha(),
      weeklyRemainingPct: weeklyRemaining(state),
      budgetAvailable: budgetAvailable(state),
      now: now(),
      tiebreaks: await tiebreaks(),
      ...(newAgents === undefined ? {} : { roles: newAgents.roles() }),
    });
    if (newAgents !== undefined && result.newAgents.length > 0)
      newAgents.found(run, result.newAgents);
    if (drift !== undefined) {
      const facts = lookbackRunEndFacts(run, result, now().toISOString());
      if (facts.length > 0) drift.found(run, facts);
    }
  };
  const off = engine.onEvent((event) => {
    if (event.type === "run.finished") {
      enqueue(async () => {
        await runEnd(event.run);
        onScorecards?.(event.run);
      });
      return;
    }
    if (event.type !== "role.submitted") return;
    const action = (event.data as { action_id?: string }).action_id;
    const state = engine.states().find((s) => s.id === event.run);
    const underCanary = state?.events.some(
      (e) =>
        e.type === "role.dispatched" &&
        (e.data as { action_id?: string; canary_arm?: string }).action_id === action &&
        (e.data as { canary_arm?: string }).canary_arm !== undefined,
    );
    if (underCanary === true) enqueue(() => canaries(event.run, event.role));
  });
  return async () => {
    off();
    engine.setPromptPins(null);
    engine.setLookbackRetro(null);
    await chain;
  };
};

/**
 * The repo's `.env` values (AD-18 rule 1), re-read when the file changes: snapshot mode still
 * appends design-review pins to git-tracked `.vtc/design/reviews/`, redacted like the engine's.
 */
export const dotenvSecrets = (repoRoot: string): (() => readonly string[]) => {
  let cached: { stamp: number; values: readonly string[] } | null = null;
  return () => {
    const path = join(repoRoot, ".env");
    const stamp = ((): number => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return -1;
      }
    })();
    if (cached?.stamp !== stamp) {
      const values = ((): readonly string[] => {
        try {
          return stamp < 0 ? [] : dotenvValues(readFileSync(path, "utf8"));
        } catch {
          return [];
        }
      })();
      cached = { stamp, values };
    }
    return cached.values;
  };
};

/**
 * The upstream module's factory (AD-27 rule 8, AD-13 rule 13): the daemon is the only importer of
 * `../upstream/index.js`, and this annotation makes a drift from the bridge's structural types a
 * type error here.
 */
const upstreamModule: CreateUpstreamModule = createUpstream;

/** How often the daemon polls Level-3 merges still in their post-merge watch (AD-23 rule 4). */
export const POST_MERGE_POLL_MS = 15 * 60_000;

/** How often the daemon checks whether it is idle (AD-12 rule 4). */
export const IDLE_CHECK_MS = 60_000;

const socketPath = (vtcHome: string, repoRoot: string): string =>
  process.platform === "win32"
    ? engineWindowsPipe(repoRoot)
    : join(vtcHome, engineSocketFile(repoRoot));

/**
 * The prototype origin (AD-5 rule 9) listens from the start: the Designer writes
 * `.vtc/design/prototype/` mid-run, and the server answers 404 until it exists. The health
 * route names it (`prototype_url`) only once the prototype is there.
 */
const prototypeUrl = (repoRoot: string, server: PrototypeServer) => (): string | null =>
  existsSync(join(repoRoot, ENGINE_HTTP.prototype.root))
    ? `http://127.0.0.1:${String(server.port)}/`
    : null;

export const runDaemon: RunDaemon = async (deps: EngineDeps, options) => {
  const now = deps.now ?? (() => new Date());
  const ownSocket = socketPath(deps.vtcHome, deps.repoRoot);
  let stale: { readonly pid: number | null; readonly reason: StaleLockReason } | undefined;
  // AD-12 rule 1: a holder whose pid is dead, or whose socket no longer answers the hello (pid
  // reuse after a reboot or SIGKILL), is gone; its lock is taken over and recorded
  const lock = await takeEngineLock(deps.repoRoot, {
    now,
    socket: ownSocket,
    holderAnswers: (socket) => engineSocketAnswers(socket),
    onStaleLock: (pid, reason) => {
      stale = { pid, reason };
    },
  });
  const cleanups: (() => Promise<void> | void)[] = [
    () => {
      lock.release();
    },
  ];
  const cleanup = async (): Promise<void> => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch {
        // keep shutting down
      }
    }
  };
  try {
    const git = createGitOps({ repoRoot: deps.repoRoot });
    // The role contracts compiled from `roles/` (AD-14 rule 6), only from the asset bundle: a
    // missing, broken or incomplete set stops the start. So does a broken plugin manifest.
    const roles = createRoleRegistry(compiledRoleContracts(deps.assets));
    const plugins = pluginCatalogFrom(deps.assets);
    const engine = Engine.open({
      repoRoot: deps.repoRoot,
      vtcHome: deps.vtcHome,
      lock,
      gateRunner: deps.gateRunner,
      git,
      workspace: createWorkspace(deps.repoRoot),
      pullRequests: deps.pullRequests ?? createGhPullRequests(deps.repoRoot),
      ...(deps.remoteMerge === undefined ? {} : { remoteMerge: deps.remoteMerge }),
      adapters: deps.adapters,
      autoResume: deps.scheduler,
      roles,
      plugins,
      now,
      random: Math.random,
      remote: "origin",
      // §11, reading 152: the user's price table budget-checks hosts that report no cost
      ...(deps.prices === undefined ? {} : { prices: deps.prices }),
      // D-cg (reading 201): each Claude replay arm runs its own compiled plugin
      ...(deps.armPlugins === undefined ? {} : { armPlugins: deps.armPlugins }),
    });
    cleanups.push(wireResearch(engine, deps));
    // AD-27: the upstream module, built from EngineDeps.automation (rule 8: the daemon is its only
    // importer); wired before Lookback, whose scorecards feed it cost regressions, so it closes
    // after Lookback's last job
    const remoteUrl = await createWorkspace(deps.repoRoot)
      .remoteUrl("origin")
      .catch(() => null);
    // the evidence browser's frozen read routes of an automatic run (AD-27 rule 6): the engine's
    // read model with no prototype origin, whose Automation view reads the wiring's settings
    let automationSettings: () => AutomationSettings | null = () => null;
    const evidenceModel = createReadModel({
      repoRoot: deps.repoRoot,
      mode: "live",
      versions: deps.versions,
      prototypeUrl: () => null,
      runs: () => engine.states(),
      usage: () => engine.usage,
      git,
      automation: () => automationSettings(),
    });
    // D-bv (4): only on VTC's own repo are the dependencies the gates scan VTC's
    const projectRepo = githubRepoOf(remoteUrl);
    const vtcRepo = (): boolean => {
      const own = deps.automation?.upstream;
      if (own === undefined) return false;
      if (projectRepo !== null && projectRepo === own.repo) return true;
      const checkout = own.checkout;
      if (checkout === undefined) return false;
      try {
        return realpathSync(checkout) === realpathSync(deps.repoRoot);
      } catch {
        return false;
      }
    };
    const automation = wireAutomation(engine, deps, {
      githubRemote: isGitHubRemote(remoteUrl),
      vtcRepo,
      createUpstream: bridgeUpstream(upstreamModule, {
        guardDir: engine.guardDir,
        vtcVersion: deps.versions.engine,
        assets: deps.assets,
        remoteUrl,
        clientNames: () => {
          const client = engine.config().client;
          return client === undefined ? [] : [client];
        },
        knownValues: dotenvSecrets(deps.repoRoot),
        redactSelectors: () => engine.gatesConfig()?.visual?.redact_selectors,
        projectEvidence: () => engine.config().automation?.evidence,
        lookbackPr: (fact) =>
          readLookbackPrInput({
            projectRoot: deps.repoRoot,
            proposal: fact.proposal ?? "",
            replayPath: fact.replayPath ?? "",
            replaySha256: fact.replaySha256,
            readProposal: async (role) => (await readProposalFiles(deps.repoRoot, role))?.raw,
            candidateEditable: async (replay) => {
              const locked = plugins.promptParts?.(
                agentNameFor(replay.role, replay.mode),
                replay.host,
              )?.compiled?.locked;
              if (locked === undefined) return undefined;
              const stored = await loadPromptVersion(
                deps.vtcHome,
                { role: replay.role, mode: replay.mode, host: replay.host },
                replay.candidate,
                locked,
              );
              return stored?.editable;
            },
          }),
        evidenceSnapshot: (run) => evidenceSnapshot(evidenceModel, run),
        scorecards: (role, host) =>
          readScorecards(deps.repoRoot).filter(
            (c) => c.prompt.role === role && c.prompt.host === host,
          ),
        gitOps: (root) => createGitOps({ repoRoot: root }),
        remoteRefs: (root) => createRemoteRefs({ repoRoot: root }),
        plumbing: createGitPlumbing,
      }),
    });
    automationSettings = automation.settings;
    cleanups.push(() => automation.close());
    // D-cd: the roles this vtc carries, for Lookback's new-agent signals
    const installed: InstalledRole[] = compiledRoleContracts(deps.assets).map((c) => ({
      id: c.id,
      kind: c.kind,
      ...(c.discipline === undefined ? {} : { discipline: c.discipline }),
    }));
    cleanups.push(
      wireLookback(
        engine,
        deps,
        plugins,
        (run) => {
          automation.scorecardsWritten(run);
        },
        {
          roles: () => installed,
          found: (run, signals) => {
            automation.improvements(signals.map((s) => newAgentFact(run, s, now().toISOString())));
          },
        },
        // D-cn (reading 219): RETRO writes the routing scorecard and raises its config facts
        {
          propose: lookbackRoutingStep,
          found: (_run, facts) => {
            automation.improvements(facts);
          },
        },
        // D-cr (reading 226): a run's end raises its drift regressions as cost facts
        {
          found: (_run, facts) => {
            automation.improvements(facts);
          },
        },
      ),
    );
    // AD-25: shutting down kills the engine-launched runs and stops the Level-3 waits, so close
    // returns promptly and leaves no orphaned process
    cleanups.push(() => engine.shutdown());
    for (const notice of engine.notices) process.stderr.write(`vtc engine: ${notice}\n`);
    if (stale !== undefined) {
      const holder = stale.pid === null ? "an unknown process" : `pid ${String(stale.pid)}`;
      engine.recordIncident(
        "stale_lock",
        stale.reason === "silent"
          ? `took over the engine lock held by ${holder}: the pid is alive but its socket did not answer the hello (the pid was reused)`
          : `took over the engine lock left by ${holder}`,
      );
    }
    try {
      mkdirSync(dirname(join(deps.repoRoot, INDEX_PATH)), { recursive: true });
      const index = openEventIndex(
        deps.openStorage({ path: join(deps.repoRoot, INDEX_PATH) }),
        engine.states(),
      );
      const off = engine.onEvent((event) => {
        index.append(event);
      });
      cleanups.push(() => {
        off();
        index.close();
      });
    } catch {
      // the index is a cache (AD-2 rule 4): the engine works from the logs without it
    }
    for (const host of HOST_IDS) {
      const adapter = deps.adapters[host];
      if (adapter?.watchUsage === undefined) continue;
      cleanups.push(
        adapter.watchUsage((snapshot) => {
          engine.ingestUsage(snapshot);
        }),
      );
    }
    // D-bq (reading 171): who pays for each host's role runs, from its own sign-in check, so
    // `GET /api/usage` carries an API-key login before any role runs (every engine-launched start
    // checks again)
    for (const host of HOST_IDS) {
      const adapter = deps.adapters[host];
      if (adapter?.authStatus === undefined) continue;
      adapter.authStatus().then(
        (status) => {
          engine.recordBilling(host, status.billing ?? null);
        },
        () => undefined,
      );
    }
    const prototype = await createPrototypeServer(deps.repoRoot);
    cleanups.push(() => prototype.close());
    const http = await createHttpApi({
      readModel: createReadModel({
        repoRoot: deps.repoRoot,
        mode: "live",
        versions: deps.versions,
        prototypeUrl: prototypeUrl(deps.repoRoot, prototype),
        runs: () => engine.states(),
        usage: () => engine.usage,
        git,
        // §14, reading 153: the project's client scope (the config the engine runs with)
        clientSpend: () => readClientSpend(deps.vtcHome, engine.config().client),
        // D-ca: the Automation view's settings and notes (automationFor), and the actions taken
        // while no run was open, which no run's log holds yet
        automation: automation.settings,
        automationEvents: automation.pendingEvents,
      }),
      installToken: deps.installToken,
      sessions: createSessionStore(now),
      assets: deps.assets,
      repoRoot: deps.repoRoot,
      ingest: (body) => {
        engine.ingestUsage(usageFromStatuslineIngest(body, now().toISOString()));
      },
      subscribe: (listener) => liveEvents(engine, listener),
      secrets: () => engine.secrets(),
      now,
    });
    cleanups.push(() => http.close());
    let lastActive = now().getTime();
    const touch = (): void => {
      lastActive = now().getTime();
    };
    const socket = await serveEngineSocket({
      path: ownSocket,
      host: engine,
      versions: deps.versions,
      installToken: deps.installToken,
      onActivity: touch,
    });
    cleanups.push(() => socket.close());
    const discovery = {
      v: 1 as const,
      pid: process.pid,
      port: http.port,
      prototype_port: prototype.port,
      mcp_socket: socket.path,
      repo_root: deps.repoRoot,
      started_at: now().toISOString(),
      engine_version: deps.versions.engine,
      contracts_version: deps.versions.contracts,
    };
    writeEngineDiscovery(deps.vtcHome, discovery);
    cleanups.push(() => {
      removeEngineDiscovery(deps.vtcHome, deps.repoRoot, process.pid);
    });
    if (options.wake) await engine.wake();
    // Level 3's post-merge watch (AD-23 rule 4): at daemon start, then on a timer
    const watch = (): void => {
      void engine.watchMerged().catch(() => undefined);
    };
    watch();
    const watcher = setInterval(watch, POST_MERGE_POLL_MS);
    watcher.unref();
    cleanups.push(() => {
      clearInterval(watcher);
    });
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let closing: Promise<void> | null = null;
    // Idle exit (AD-12 rule 4): no background work or role run in flight, no bridge, no wake-up.
    const idle = setInterval(() => {
      const busy =
        engine.busy() || socket.connections().bridge > 0 || engine.autoResumeAt() !== null;
      if (busy) touch();
      else if (now().getTime() - lastActive >= ENGINE_INSTANCE.idleExitMs) void close();
    }, IDLE_CHECK_MS);
    idle.unref();
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        clearInterval(idle);
        await cleanup();
        resolveClosed();
      })());
    const running: RunningDaemon = {
      port: http.port,
      prototypePort: prototype.port,
      closed,
      close,
      discovery,
    };
    return running;
  } catch (error) {
    await cleanup();
    throw error;
  }
};

/** The committed `project.yaml`'s client, or none when it does not parse (the shared scope). */
const snapshotClient = (repoRoot: string): string | undefined => {
  try {
    return loadProjectConfig(repoRoot).client;
  } catch {
    return undefined;
  }
};

/** How long snapshot mode reuses a replay before re-reading the committed logs. */
const SNAPSHOT_TTL_MS = 2_000;

export const serveSnapshot: ServeSnapshot = async (deps) => {
  const now = deps.now ?? (() => new Date());
  let cached: { at: number; runs: ReturnType<typeof loadRuns> } | null = null;
  const runs = () => {
    const t = now().getTime();
    if (cached === null || t - cached.at > SNAPSHOT_TTL_MS) {
      cached = { at: t, runs: loadRuns(deps.repoRoot) };
    }
    return cached.runs.map((r) => r.state);
  };
  const sessions = createSessionStore(now);
  const prototype = await createPrototypeServer(deps.repoRoot);
  const git = existsSync(join(deps.repoRoot, ".git"))
    ? createGitOps({ repoRoot: deps.repoRoot })
    : null;
  const http = await createHttpApi({
    readModel: createReadModel({
      repoRoot: deps.repoRoot,
      mode: "snapshot",
      versions: deps.versions,
      prototypeUrl: prototypeUrl(deps.repoRoot, prototype),
      runs,
      usage: () => runs().at(-1)?.usage ?? new Map(),
      git,
      clientSpend: () => readClientSpend(deps.vtcHome, snapshotClient(deps.repoRoot)),
    }),
    installToken: deps.installToken,
    sessions,
    assets: deps.assets,
    repoRoot: deps.repoRoot,
    ingest: null,
    subscribe: null,
    secrets: dotenvSecrets(deps.repoRoot),
    now,
  });
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | null = null;
  const snapshot: RunningSnapshot = {
    port: http.port,
    prototypePort: prototype.port,
    closed,
    close: () =>
      (closing ??= (async () => {
        await http.close();
        await prototype.close();
        resolveClosed();
      })()),
    mintNonce: () => sessions.mintNonce(),
  };
  return snapshot;
};
