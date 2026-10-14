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
 *   versions and metric;
 * - an automatic run's release (`automaticReleaseOf`: its work pushed to its `vtc/auto` branch
 *   after Final Review) goes to the module, which opens the run's draft PR with evidence.
 * Without `EngineDeps.automation` nothing is evaluated (the Automation view says why). Every job
 * runs on one queue whose failures become engine notices, so one failed step never stops the
 * jobs after it (nor rejects `idle` / `close`).
 */
import { join } from "node:path";
import {
  automationFor,
  isCoreEventType,
  LOOKBACK_REPO,
  ScorecardIndexSchema,
  ScorecardSchema,
  validateEventData,
  type AutomationContext,
  type AutomationSettings,
  type AutomationSkipReason,
  type EngineDeps,
  type Scorecard,
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
}

export interface AutomationWiring {
  /** The settings now (`GET /api/automation`); `null` without `EngineDeps.automation`. */
  readonly settings: () => AutomationSettings | null;
  /** Resolves once every fact handed over so far has been handled. */
  readonly idle: () => Promise<void>;
  /**
   * Lookback rewrote the scorecards at `run`'s end: each new cost regression (a role's newest
   * prompt version against the one before it) becomes a fact of that run.
   */
  readonly scorecardsWritten: (run: string) => void;
  readonly close: () => Promise<void>;
}

/** A remote URL on GitHub (`https://github.com/…`, `git@github.com:…`, `ssh://git@github.com/…`). */
export const isGitHubRemote = (url: string | null): boolean =>
  url !== null && /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]/.test(url);

const SUMMARY_FILE = "automation-summary.json";
const PENDING_FILE = "automation-pending.jsonl";
const COST_SEEN_FILE = "automation-cost-seen.json";
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
  // Precondition (the cli's): `EngineDeps.automation` is injected only after `gh auth status`
  // passed, so its presence stands for the gh login here. `AutomationDeps` carries no login of
  // its own (a contract proposal adds one); until then `gh_unavailable` cannot show while
  // automation is wired.
  const context = (): AutomationContext => ({
    githubRemote: options.githubRemote,
    ghLoggedIn: automation !== undefined,
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
    // action is an event, D-ca)
    ensurePrivateDir(guard);
    appendPrivateFile(pendingFile, `${JSON.stringify(event)}\n`);
  };
  const flushPending = (run: string): void => {
    const text = readPrivateFile(pendingFile);
    if (text === null || text.trim() === "") return;
    // only what was recorded leaves the file (a run that finished meanwhile records nothing)
    const kept: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        if (!engine.recordModuleEvent(run, JSON.parse(line) as EventDraft)) kept.push(line);
      } catch {
        // a line the engine did not write is dropped
      }
    }
    writePrivateFile(pendingFile, kept.map((line) => `${line}\n`).join(""));
  };

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
    const window = engine
      .states()
      .flatMap((s) => s.events)
      .filter((e) => isAutomationEvent(e.type) && e.ts > last.at && e.ts <= at);
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
          startRun: async (input, issue) => {
            await engine.startAutomatic(input, issue);
          },
          now,
        });
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
  const handle = async (fact: AutomationFact): Promise<void> => {
    const settings = settingsNow();
    if (settings === null) return;
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
      return;
    }
    if (upstream === null) return;
    try {
      await upstream.onFact(fact);
    } catch (error) {
      engine.notice(
        `automation could not handle a ${fact.kind} fact of run ${fact.run}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  const listener = (event: VtcEvent): void => {
    if (automation === undefined) return;
    if (event.type === "run.started") {
      const run = event.run;
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
  };
  const unsubscribe = engine.onEvent(listener);
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
      ensurePrivateDir(guard);
      writePrivateFile(
        costSeenFile,
        `${JSON.stringify([...seen, ...fresh.map(key)].slice(-COST_SEEN_MAX))}\n`,
      );
      for (const fact of fresh) await handle(fact);
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
  const timer =
    sweep === undefined ? null : setInterval(runSweep, options.sweepEveryMs ?? 60 * 60_000);
  timer?.unref();
  return {
    settings: settingsNow,
    scorecardsWritten,
    idle: () => queue,
    close: async () => {
      unsubscribe();
      if (timer !== null) clearInterval(timer);
      await queue;
      await upstream?.close?.();
    },
  };
};
