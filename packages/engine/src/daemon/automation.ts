/**
 * Automatic issues and PRs as the daemon wires them (AD-27 rules 7 and 8; D-bu, D-bv, D-bz, D-ca;
 * spine §5 readings 189–195). The daemon is the only place the upstream module meets the engine:
 * - it resolves the project's settings (`automationFor`: the project's `upstream` / `automation`,
 *   the user's from `EngineDeps.automation`, a GitHub push remote, the cli's `gh` wiring, and
 *   `vtc pause`: the repo-level kill switch every `pause` sets, run or no run, until the human's
 *   `vtc resume` (`automationPausedByHuman`), and any open run that is paused);
 * - it reads the engine facts that trigger automation from every event (`automationFacts`: VTC
 *   defects, replay verdict `improve`, parked tasks, red post-merge CI, reverts and escaped defects,
 *   out-of-scope findings, Final Review leftovers) and hands each to the upstream module, or
 *   records `automation.skipped` with the reason the settings give;
 * - it gives the module its only event sink (`upstream.*` and `automation.skipped`, nothing else),
 *   into the run's log, or the next run's when none is open (kept in the engine's private area);
 * - it relays the daily summary to the Lead once per UTC day (`NextResult.notices`);
 * - after Lookback rewrites the scorecards at a run's end, it hands over each role's cost
 *   regression against its previous prompt version (`costRegressionFacts`), once per pair of
 *   versions and metric that the module took (one skipped while paused or off is evaluated again
 *   at the next rewrite, reading 212(8));
 * - an automatic run's release (`automaticReleaseOf`: its work pushed to its `vtc/auto` branch
 *   after Final Review) goes to the module, which opens the run's draft PR with evidence;
 * - the automatic runs the module asks for (a fixable issue, D-bv, D-cd) wait in the engine's
 *   private area until no run of the repo is open and automation is not paused, and each issue
 *   starts one run at most (`Engine.startAutomatic`).
 * - it asks `AutomationDeps.ghLogin` whether gh is logged in (at start, at each run's start and on
 *   its timer): logged out, automation is off with the D-bz note and facts skip as
 *   `gh_unavailable`.
 * Without `EngineDeps.automation` nothing is evaluated (the Automation view says why). Every job
 * runs on one queue whose failures become engine notices, so one failed step never stops the
 * jobs after it (nor rejects `idle` / `close`).
 */
import { join } from "node:path";
import {
  AutomationRunRefSchema,
  automationFor,
  isCoreEventType,
  LOOKBACK_REPO,
  ScorecardIndexSchema,
  ScorecardSchema,
  StartInputSchema,
  validateEventData,
  type AutomationRunRef,
  type AutomationContext,
  type AutomationSettings,
  type AutomationSkipReason,
  type EngineDeps,
  type Scorecard,
  type StartInput,
  type VtcEvent,
} from "@vtc/shared";
import {
  appendPrivateFile,
  automaticReleaseOf,
  automationPausedByHuman,
  automationDailySummary,
  automationFacts,
  costRegressionFacts,
  ensurePrivateDir,
  isAutomationEvent,
  readPrivateFile,
  writePrivateFile,
  type AutomaticRelease,
  type AutomationFact,
  type CreateUpstream,
  type Engine,
  type EventDraft,
  type UpstreamWiring,
} from "../core/index.js";
import { readRepoFileCapped } from "../git/index.js";

export interface AutomationWiringOptions {
  /** The upstream module's factory (`upstream.createUpstream`); absent: facts are only gated. */
  readonly createUpstream?: CreateUpstream;
  /** Whether the project's push remote is on GitHub (the daemon reads `origin`). */
  readonly githubRemote: boolean;
  /** How often the module's sweep runs (auto-close, the write queue). Default one hour. */
  readonly sweepEveryMs?: number;
  /**
   * Whether the project is VTC's own repo (its remote is `upstream.repo`, or it is the
   * `upstream.checkout`): only there are the dependencies the gates scan VTC's own, so only there
   * does an advisory become a VTC-repo security fact (D-bv (4)). Absent: never.
   */
  readonly vtcRepo?: () => boolean;
}

export interface AutomationWiring {
  /** The settings now (`GET /api/automation`); `null` without `EngineDeps.automation`. */
  readonly settings: () => AutomationSettings | null;
  /** Resolves once every fact handed over so far has been handled. */
  readonly idle: () => Promise<void>;
  /**
   * Asks `AutomationDeps.ghLogin` again (D-bz) and resolves once the answer is in. The wiring asks
   * when it starts, when a run starts and on its timer; facts wait for the first answer.
   */
  readonly refreshLogin: () => Promise<void>;
  /**
   * Lookback rewrote the scorecards at `run`'s end: each new cost regression (a role's newest
   * prompt version against the one before it) becomes a fact of that run.
   */
  readonly scorecardsWritten: (run: string) => void;
  /**
   * D-cd improvements found outside a run's events (Lookback's new-agent signals at a run's end):
   * each is handed over like an event's fact.
   */
  readonly improvements: (facts: readonly AutomationFact[]) => void;
  /**
   * The automation events recorded while no run was open, which no run's log holds yet (D-ca):
   * the Automation view and the daily summary read them with the runs' events, so an action VTC
   * took between runs (the daily sweep, a PR whose capture outlasted its run) shows at once.
   */
  readonly pendingEvents: () => VtcEvent[];
  readonly close: () => Promise<void>;
}

/** A remote URL on GitHub (`https://github.com/…`, `git@github.com:…`, `ssh://git@github.com/…`). */
export const isGitHubRemote = (url: string | null): boolean =>
  url !== null && /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]/.test(url);

const SUMMARY_FILE = "automation-summary.json";
const PENDING_FILE = "automation-pending.jsonl";
const COST_SEEN_FILE = "automation-cost-seen.json";
/** Automatic runs the module asked for that wait for the repo's open run to finish. */
const RUNS_FILE = "automation-runs.json";
/** How many queued automatic runs the guard dir keeps. */
const RUNS_MAX = 20;
/** How many reported cost regressions the guard dir remembers. */
const COST_SEEN_MAX = 500;
/** The largest scorecard or scorecard index file read. */
const SCORECARD_MAX_BYTES = 256 * 1024;

/**
 * A repo file the engine wrote, as JSON, or `undefined` (missing, a link at any component, too
 * large, not JSON), read from one no-follow descriptor (`readRepoFileCapped`).
 */
const readRepoJson = (root: string, path: string): unknown => {
  try {
    const read = readRepoFileCapped(root, path, SCORECARD_MAX_BYTES);
    return read.ok ? (JSON.parse(read.text) as unknown) : undefined;
  } catch {
    return undefined;
  }
};

/** The project's scorecards, from Lookback's index (`.vtc/lookback/scorecards/index.json`). */
export const readScorecards = (projectRoot: string): Scorecard[] => {
  const index = ScorecardIndexSchema.safeParse(
    readRepoJson(projectRoot, LOOKBACK_REPO.scorecardIndex),
  );
  if (!index.success) return [];
  return index.data.scorecards.flatMap((entry) => {
    if (
      !entry.path.startsWith(`${LOOKBACK_REPO.scorecardsDir}/`) ||
      entry.path.split("/").includes("..")
    )
      return [];
    const card = ScorecardSchema.safeParse(readRepoJson(projectRoot, entry.path));
    return card.success ? [card.data] : [];
  });
};

/** Why a fact is not acted on under `context` (D-bz, D-by), or `null` when it may be. */
export const automationSkipReason = (
  fact: Pick<AutomationFact, "target">,
  settings: AutomationSettings,
  context: AutomationContext,
): AutomationSkipReason | null => {
  if (context.paused) return "paused";
  if (fact.target === "upstream") {
    if (settings.upstream) return null;
    return context.ghLoggedIn ? "share_off" : "gh_unavailable";
  }
  if (settings.issues) return null;
  if (!context.ghLoggedIn) return "gh_unavailable";
  return context.githubRemote ? "disabled" : "no_github_remote";
};

/**
 * Wires automation into a running engine (callers: `runDaemon`). Returns the settings reader for
 * the read model and the cleanup.
 */
export const wireAutomation = (
  engine: Engine,
  deps: Pick<EngineDeps, "repoRoot" | "vtcHome" | "automation" | "now">,
  options: AutomationWiringOptions,
): AutomationWiring => {
  const now = deps.now ?? (() => new Date());
  const automation = deps.automation;
  // the human's kill switch holds while the daemon is idle too (no open run, AD-27 rule 7)
  const paused = (): boolean =>
    automationPausedByHuman(engine.guardDir) ||
    engine.states().some((s) => s.run.finished_at === undefined && s.run.paused);
  // D-bz: automation is on only while gh is logged in. `AutomationDeps.ghLogin` (5.2.0) answers
  // with `gh auth status`'s exit code; until its first answer the login counts as absent (facts
  // wait for that answer in the job queue, so none is skipped for it). Without the probe, the
  // caller checked the login before it injected automation.
  let ghLoggedIn: boolean | null = automation?.ghLogin === undefined ? true : null;
  const context = (): AutomationContext => ({
    githubRemote: options.githubRemote,
    ghLoggedIn: automation !== undefined && ghLoggedIn === true,
    paused: paused(),
  });
  const settingsNow = (): AutomationSettings | null => {
    if (automation === undefined) return null;
    const project = engine.config();
    return automationFor(
      { upstream: project.upstream, automation: project.automation },
      {
        upstream: { repo: automation.upstream.repo, share: automation.upstream.share },
        automation: { evidence_hosting: automation.hosting },
      },
      context(),
    );
  };
  const guard = engine.guardDir;
  const pendingFile = join(guard, PENDING_FILE);

  // ---- the event sink: upstream.* and automation.skipped only, into a run's log
  /** `run` while it is open (never another run's log), or the open run when `run` is absent. */
  const openRun = (run: string | undefined): string | undefined => {
    const states = engine.states().filter((s) => s.run.finished_at === undefined);
    if (run !== undefined) return states.some((s) => s.id === run) ? run : undefined;
    return states.at(-1)?.id;
  };
  const emit = (draft: EventDraft, run?: string): void => {
    if (!isAutomationEvent(draft.type) || !isCoreEventType(draft.type))
      throw new Error(
        `the upstream module may record only upstream.* and automation.skipped events, not ${draft.type}`,
      );
    const checked = validateEventData(draft.type, draft.data ?? {});
    if (!checked.ok)
      throw new Error(`invalid ${draft.type}: ${JSON.stringify(checked.issues).slice(0, 300)}`);
    const event: EventDraft = { ...draft, actor: "engine", data: checked.data };
    const target = openRun(run);
    if (target !== undefined && engine.recordModuleEvent(target, event)) return;
    // its run is finished, or none is open: the next run's log records it (every automatic
    // action is an event, D-ca); until then the Automation view and the daily summary read it
    // here ({@link pendingEvents}), at the time it happened
    ensurePrivateDir(guard);
    appendPrivateFile(pendingFile, `${JSON.stringify({ ...event, ts: now().toISOString() })}\n`);
  };
  /** The pending lines as written: the event draft and the time it happened. */
  const pendingLines = (): { line: string; draft: EventDraft; ts: string | undefined }[] => {
    const text = readPrivateFile(pendingFile);
    if (text === null || text.trim() === "") return [];
    return text.split("\n").flatMap((line) => {
      if (line.trim() === "") return [];
      try {
        const { ts, ...draft } = JSON.parse(line) as EventDraft & { ts?: unknown };
        return [{ line, draft, ts: typeof ts === "string" ? ts : undefined }];
      } catch {
        // a line the engine did not write is dropped
        return [];
      }
    });
  };
  const flushPending = (run: string): void => {
    const lines = pendingLines();
    if (lines.length === 0) return;
    // only what was recorded leaves the file (a run that finished meanwhile records nothing)
    const kept: string[] = [];
    for (const { line, draft } of lines) {
      try {
        if (!engine.recordModuleEvent(run, draft)) kept.push(line);
      } catch {
        // a line the engine did not write is dropped
      }
    }
    writePrivateFile(pendingFile, kept.map((line) => `${line}\n`).join(""));
  };
  const pendingEvents = (): VtcEvent[] =>
    pendingLines()
      .filter(({ draft }) => isAutomationEvent(draft.type))
      .map(
        ({ draft, ts }, i) =>
          ({
            v: 1,
            run: "",
            seq: i + 1,
            ts: ts ?? "",
            type: draft.type,
            actor: "engine",
            data: draft.data ?? {},
          }) as unknown as VtcEvent,
      );

  // ---- the daily summary, once per UTC day (D-ca)
  const summaryFile = join(guard, SUMMARY_FILE);
  const lastSummary = (): { day: string; at: string } | null => {
    try {
      const value = JSON.parse(readPrivateFile(summaryFile) ?? "null") as unknown;
      if (value !== null && typeof value === "object" && "day" in value && "at" in value)
        return value as { day: string; at: string };
    } catch {
      // read as none
    }
    return null;
  };
  const maybeSummarise = (): void => {
    if (automation === undefined) return;
    const at = now().toISOString();
    const day = at.slice(0, 10);
    const last = lastSummary();
    if (last?.day === day) return;
    ensurePrivateDir(guard);
    writePrivateFile(summaryFile, `${JSON.stringify({ day, at })}\n`);
    // the first day only sets the clock; afterwards, what happened since the last summary
    if (last === null) return;
    // the runs' logs, and what no run's log holds yet (recorded while none was open)
    const window = [...engine.states().flatMap((s) => s.events), ...pendingEvents()].filter(
      (e) => isAutomationEvent(e.type) && e.ts > last.at && e.ts <= at,
    );
    const text = automationDailySummary(window, last.day);
    if (text !== null) engine.relay(undefined, text);
  };

  // ---- the upstream module and the facts it gets
  const upstream: UpstreamWiring | null =
    automation === undefined || options.createUpstream === undefined
      ? null
      : options.createUpstream({
          projectRoot: deps.repoRoot,
          vtcHome: deps.vtcHome,
          automation,
          settings: () => {
            const settings = settingsNow();
            if (settings === null) throw new Error("automation is not wired");
            return settings;
          },
          context,
          emit,
          // queued: a run of the repo is usually open when an issue opens (D-bv)
          startRun: (input, issue) => {
            queueRun(input, issue);
            return Promise.resolve();
          },
          now,
        });
  // ---- automatic runs (D-bv "a fixable one becomes a normal VTC run", D-cd; AD-27 rule 2): the
  // module asks right after it opened the issue, usually while the run whose fact raised it is
  // still open, and a repo runs one run at a time; so each waits here (kept across restarts) and
  // starts when no run is open, not paused, once per issue
  const runsFile = join(guard, RUNS_FILE);
  interface QueuedRun {
    readonly input: StartInput;
    readonly issue: AutomationRunRef;
  }
  const queuedRuns = (): QueuedRun[] => {
    try {
      const value = JSON.parse(readPrivateFile(runsFile) ?? "[]") as unknown;
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry: { input?: unknown; issue?: unknown }) => {
        const input = StartInputSchema.safeParse(entry.input);
        const issue = AutomationRunRefSchema.safeParse(entry.issue);
        return input.success && issue.success ? [{ input: input.data, issue: issue.data }] : [];
      });
    } catch {
      return [];
    }
  };
  const writeQueued = (runs: readonly QueuedRun[]): void => {
    ensurePrivateDir(guard);
    writePrivateFile(runsFile, `${JSON.stringify(runs.slice(-RUNS_MAX))}\n`);
  };
  const sameIssue = (a: AutomationRunRef, b: AutomationRunRef): boolean =>
    a.issue === b.issue && a.target.repo === b.target.repo && a.target.kind === b.target.kind;
  /** Whether a run of this repo already worked on the issue (never a second run for it). */
  const ranFor = (issue: AutomationRunRef): boolean =>
    engine.states().some((s) => s.automation !== null && sameIssue(s.automation, issue));
  const startQueued = async (): Promise<void> => {
    let queued = queuedRuns();
    if (queued.length === 0 || paused() || settingsNow()?.prs !== true) return;
    if (engine.states().some((s) => s.run.finished_at === undefined)) return;
    const next = queued.find((q) => !ranFor(q.issue));
    queued = queued.filter((q) => q !== next && !ranFor(q.issue));
    if (next === undefined) {
      writeQueued(queued);
      return;
    }
    try {
      await engine.startAutomatic(next.input, next.issue);
      writeQueued(queued);
    } catch (error) {
      if ((error as { code?: unknown }).code === "run_active") return;
      // a run that cannot start here (the committed config, a held run) is told and dropped:
      // its issue stays open for the human
      writeQueued(queued);
      engine.notice(
        `automation could not start the automatic run for issue ${next.issue.target.repo}#${String(next.issue.issue)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const queueRun = (input: StartInput, issue: AutomationRunRef): void => {
    const queued = queuedRuns();
    if (!ranFor(issue) && !queued.some((q) => sameIssue(q.issue, issue)))
      writeQueued([...queued, { input, issue }]);
    enqueue("the automatic runs", startQueued);
  };

  // One job at a time, in order. A job that throws (a guard-dir write, an event the log refused)
  // is an engine notice and the next job still runs: the chain never holds a rejection.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (what: string, job: () => void | Promise<void>): void => {
    queue = queue.then(job).catch((error: unknown) => {
      engine.notice(
        `automation (${what}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  /**
   * Hands `fact` to the module, or records why not. Returns whether the module took it (a skip
   * for the settings, `vtc pause` included, or a module that failed, did not: reading 212(8)).
   */
  const handle = async (fact: AutomationFact): Promise<boolean> => {
    const settings = settingsNow();
    if (settings === null) return false;
    // D-bv (4): another project's dependency advisories are not VTC's (no issue, no skip)
    if (fact.kind === "security" && fact.target === "upstream" && options.vtcRepo?.() !== true)
      return false;
    const skip = automationSkipReason(fact, settings, context());
    if (skip !== null) {
      emit(
        {
          type: "automation.skipped",
          actor: "engine",
          data: {
            reason: skip,
            kind: fact.kind,
            detail:
              `${fact.kind} (${fact.source}) was not raised: ${settings.notes[0] ?? skip}`.slice(
                0,
                500,
              ),
          },
        },
        fact.run,
      );
      return false;
    }
    if (upstream === null) return false;
    try {
      await upstream.onFact(fact);
      return true;
    } catch (error) {
      engine.notice(
        `automation could not handle a ${fact.kind} fact of run ${fact.run}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };
  /**
   * An automatic run's release (AD-27 rules 2 and 6): the module opens its draft PR from the
   * pushed head, with evidence, or marks the one it opened ready. The module checks the settings
   * (`automation.prs`, `vtc pause`, the upstream opt-outs) and records a skip itself.
   */
  const released = async (release: AutomaticRelease): Promise<void> => {
    if (upstream?.onAutomaticRelease === undefined) return;
    try {
      await upstream.onAutomaticRelease(release);
    } catch (error) {
      engine.notice(
        `automation could not open the PR of run ${release.run} (issue #${String(release.automation.issue)}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  /** One login probe; a probe that fails or throws reads as logged out (fail closed). */
  const probeLogin = async (): Promise<void> => {
    const ask = automation?.ghLogin;
    if (ask === undefined) return;
    try {
      ghLoggedIn = await ask();
    } catch {
      ghLoggedIn = false;
    }
  };
  const refreshLogin = (): Promise<void> => {
    enqueue("the gh login", probeLogin);
    return queue;
  };
  const listener = (event: VtcEvent): void => {
    if (automation === undefined) return;
    if (event.type === "run.started") {
      const run = event.run;
      enqueue("the gh login", probeLogin);
      enqueue("the pending events", () => {
        flushPending(run);
      });
    }
    const state = engine.states().find((s) => s.id === event.run);
    const facts = state === undefined ? [] : automationFacts(state, event);
    const release = state === undefined ? null : automaticReleaseOf(state, event);
    // handled after the emit that raised them, one at a time
    enqueue("the daily summary", maybeSummarise);
    enqueue(`the facts of ${event.type}`, async () => {
      for (const fact of facts) {
        try {
          await handle(fact);
        } catch (error) {
          // one fact that could not be handled never drops the ones after it
          engine.notice(
            `automation could not handle a ${fact.kind} fact of run ${fact.run}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (release !== null) await released(release);
    });
    // the repo's run finished: an automatic run that waited for it may start
    if (event.type === "run.finished") enqueue("the automatic runs", startQueued);
  };
  const unsubscribe = engine.onEvent(listener);
  // the first login answer comes before any fact is evaluated (the queue is serial)
  if (automation !== undefined) enqueue("the gh login", probeLogin);
  if (automation !== undefined) enqueue("the daily summary", maybeSummarise);

  // ---- cost regressions, after Lookback rewrote the scorecards (D-bv)
  const costSeenFile = join(guard, COST_SEEN_FILE);
  const costSeen = (): string[] => {
    try {
      const value = JSON.parse(readPrivateFile(costSeenFile) ?? "[]") as unknown;
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  };
  const scorecardsWritten = (run: string): void => {
    if (automation === undefined) return;
    enqueue("the cost regressions", async () => {
      const facts = costRegressionFacts(readScorecards(deps.repoRoot), {
        run,
        at: now().toISOString(),
      });
      if (facts.length === 0) return;
      const seen = costSeen();
      const key = (f: AutomationFact): string =>
        [f.role, f.mode ?? "", f.host, f.baselinePromptSha, f.promptSha, f.metric].join(" ");
      const fresh = facts.filter((f) => !seen.includes(key(f)));
      if (fresh.length === 0) return;
      // Reading 212(8): a regression counts as seen only once the module took it. One skipped
      // while automation was paused or off (or that the module failed on) is evaluated again at
      // the next scorecard rewrite, and raised then if it still holds.
      const taken: string[] = [];
      for (const fact of fresh) if (await handle(fact)) taken.push(key(fact));
      if (taken.length === 0) return;
      ensurePrivateDir(guard);
      writePrivateFile(
        costSeenFile,
        `${JSON.stringify([...costSeen(), ...taken].slice(-COST_SEEN_MAX))}\n`,
      );
    });
  };

  // ---- D-cd improvements from Lookback (new-agent signals at a run's end)
  const improvements = (facts: readonly AutomationFact[]): void => {
    if (automation === undefined || facts.length === 0) return;
    enqueue("the improvements", async () => {
      for (const fact of facts) await handle(fact);
    });
  };

  // ---- the module's sweep: tried at start and then on a timer (the module paces it)
  const sweep = upstream?.sweep?.bind(upstream);
  const runSweep = (): void => {
    if (sweep === undefined || paused()) return;
    enqueue("the sweep", async () => {
      // paused while it waited in the queue: not now
      if (paused()) return;
      await sweep();
    });
  };
  if (automation !== undefined) runSweep();
  const tick = (): void => {
    // the login can change while the daemon runs (gh auth login / logout)
    if (automation?.ghLogin !== undefined) enqueue("the gh login", probeLogin);
    runSweep();
    // a queued automatic run whose wait ended without a run.finished (a resume after a pause)
    enqueue("the automatic runs", startQueued);
  };
  if (automation !== undefined) enqueue("the automatic runs", startQueued);
  const timer =
    automation === undefined ? null : setInterval(tick, options.sweepEveryMs ?? 60 * 60_000);
  timer?.unref();
  return {
    settings: settingsNow,
    scorecardsWritten,
    improvements,
    refreshLogin,
    pendingEvents,
    idle: () => queue,
    close: async () => {
      unsubscribe();
      if (timer !== null) clearInterval(timer);
      await queue;
      await upstream?.close?.();
    },
  };
};
