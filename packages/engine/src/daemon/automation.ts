/**
 * Automatic issues and PRs as the daemon wires them (AD-27 rules 7 and 8; D-bu, D-bv, D-bz, D-ca;
 * spine §5 readings 189–195). The daemon is the only place the upstream module meets the engine:
 * - it resolves the project's settings (`automationFor`: the project's `upstream` / `automation`,
 *   the user's from `EngineDeps.automation`, a GitHub push remote, the cli's `gh` wiring, and
 *   `vtc pause`, which stops automation for as long as a run is paused);
 * - it reads the engine facts that trigger automation from every event (`automationFacts`: VTC
 *   defects, replay verdict `improve`, parked tasks, red post-merge CI, reverts and escaped defects,
 *   out-of-scope findings, Final Review leftovers) and hands each to the upstream module, or
 *   records `automation.skipped` with the reason the settings give;
 * - it gives the module its only event sink (`upstream.*` and `automation.skipped`, nothing else),
 *   into the run's log, or the next run's when none is open (kept in the engine's private area);
 * - it relays the daily summary to the Lead once per UTC day (`NextResult.notices`).
 * Without `EngineDeps.automation` nothing is evaluated (the Automation view says why).
 */
import { join } from "node:path";
import {
  automationFor,
  isCoreEventType,
  validateEventData,
  type AutomationContext,
  type AutomationSettings,
  type AutomationSkipReason,
  type EngineDeps,
  type VtcEvent,
} from "@vtc/shared";
import {
  appendPrivateFile,
  automationDailySummary,
  automationFacts,
  ensurePrivateDir,
  isAutomationEvent,
  readPrivateFile,
  writePrivateFile,
  type AutomationFact,
  type CreateUpstream,
  type Engine,
  type EventDraft,
  type UpstreamWiring,
} from "../core/index.js";

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
  readonly close: () => Promise<void>;
}

/** A remote URL on GitHub (`https://github.com/…`, `git@github.com:…`, `ssh://git@github.com/…`). */
export const isGitHubRemote = (url: string | null): boolean =>
  url !== null && /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]/.test(url);

const SUMMARY_FILE = "automation-summary.json";
const PENDING_FILE = "automation-pending.jsonl";

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
  const paused = (): boolean =>
    engine.states().some((s) => s.run.finished_at === undefined && s.run.paused);
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
  const openRun = (run: string | undefined): string | undefined => {
    const states = engine.states().filter((s) => s.run.finished_at === undefined);
    return (
      (run !== undefined && states.some((s) => s.id === run) ? run : undefined) ?? states.at(-1)?.id
    );
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
    if (target !== undefined) {
      engine.recordModuleEvent(target, event);
      return;
    }
    // no open run: the next run's log records it (every automatic action is an event, D-ca)
    ensurePrivateDir(guard);
    appendPrivateFile(pendingFile, `${JSON.stringify(event)}\n`);
  };
  const flushPending = (run: string): void => {
    const text = readPrivateFile(pendingFile);
    if (text === null || text.trim() === "") return;
    writePrivateFile(pendingFile, "");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        engine.recordModuleEvent(run, JSON.parse(line) as EventDraft);
      } catch {
        // a line the engine did not write is dropped
      }
    }
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
          emit,
          startRun: async (input, issue) => {
            await engine.startAutomatic(input, issue);
          },
          now,
        });
  let queue: Promise<void> = Promise.resolve();
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
  const listener = (event: VtcEvent): void => {
    if (automation === undefined) return;
    if (event.type === "run.started") {
      const run = event.run;
      queue = queue.then(() => {
        flushPending(run);
      });
    }
    const state = engine.states().find((s) => s.id === event.run);
    const facts = state === undefined ? [] : automationFacts(state, event);
    // handled after the emit that raised them, one at a time
    queue = queue.then(async () => {
      maybeSummarise();
      for (const fact of facts) await handle(fact);
    });
  };
  const unsubscribe = engine.onEvent(listener);
  maybeSummarise();
  const sweep = upstream?.sweep?.bind(upstream);
  const timer =
    sweep === undefined
      ? null
      : setInterval(
          () => {
            if (paused()) return;
            queue = queue.then(() =>
              sweep().catch((error: unknown) => {
                engine.notice(
                  `the automation sweep failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }),
            );
          },
          options.sweepEveryMs ?? 60 * 60_000,
        );
  timer?.unref();
  return {
    settings: settingsNow,
    idle: () => queue,
    close: async () => {
      unsubscribe();
      if (timer !== null) clearInterval(timer);
      await queue;
      await upstream?.close?.();
    },
  };
};
