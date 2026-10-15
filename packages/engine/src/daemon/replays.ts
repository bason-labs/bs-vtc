/**
 * Lookback replays as the daemon wires them into RETRO (AD-21 rule 6; spine §5 reading 176): the
 * `replays`, `gradeTrial` and `finishReplay` parts of core's `LookbackRetro`, over the lookback
 * module (core never imports lookback, AD-13 rule 12).
 * - `replays`: every proposal recorded (`lookback.proposal_recorded`) and not yet replayed
 *   (`lookback.replay_finished`), in the history of every run; its candidate is the immutable
 *   version stored for it, its baseline the version it was proposed against; its tasks the held-out
 *   failures and successes of the baseline (`replayTasks`) whose recorded pack is still the
 *   engine's and whose starting commit is known; its full plan `planReplayTrials` (with an A/A arm
 *   when no noise floor is cached for the baseline). Which trials this RETRO launches is
 *   `planRetroReplays` (D-cg, reading 201): the trials the ledger (`readReplayLedger`) already
 *   graded are left out, a replay whose trial measured nothing `REPLAY_MAX_INFRA_ATTEMPTS` times is
 *   left out, and the weekly window of the run's Lead host, the budget and the per-RETRO cap
 *   (`lookbackPaceFor`, D-cq: 36 while more than half the window is left) bound the rest, each
 *   limit an `automation.skipped` the run logs. A proposal whose versions or tasks cannot be found
 *   is left out with its reason.
 * - `recordTrial`: each trial's grade (`recordReplayTrial`) or infrastructure attempt
 *   (`recordReplayInfra`) in the ledger under the VTC home, as core learns it, so a replay
 *   continues across RETROs.
 * - `replayWait`: the same window and budget checks, which core runs again before every trial.
 * - `gradeTrial`: the Gate Runner's verdict on the trial (`pass`, `fail`, or `infra_error`, which
 *   measures nothing).
 * - `gradeVerdict` (D-ch): a verdict role's trial (the Spec Verifier's) scored by the verdict
 *   grader against the recorded outcome of the dispatch it replays (`gradeVerdictReplay`); its
 *   held-out tasks are the dispatches with a recorded outcome (`replayTasks` with the `verdict`
 *   grader), keyed with the expected verdict.
 * - `finishReplay`: once the ledger holds every trial of the replay's plan, `assembleReplay` and
 *   `writeReplayResult` (the event carries the SHA-256 of the bytes written), and the measured A/A
 *   flip rate kept for the next replay; nothing while trials are still missing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCEPTANCE_TESTS,
  LOOKBACK_HOME,
  LOOKBACK_LIMITS,
  lookbackPaceFor,
  parsePersisted,
  PromptVersionFrontmatterSchema,
  TaskPackSchema,
  type GateRunner,
  type HostId,
  type ModelTier,
  type PromptVersionRef,
  type ReplayGrader,
  type TaskPack,
  type TierReason,
  type VtcEvent,
} from "@vtc/shared";
import {
  parseYaml,
  replayWaitSkipReason,
  taskPackJsonPath,
  type LookbackReplay,
  type LookbackReplayTrial,
  type LookbackRetro,
  type RunState,
  type TierRoute,
} from "../core/index.js";
import {
  assembleReplay,
  cachedAaFlipRate,
  expectedOfTaskKey,
  gradeVerdictReplay,
  loadPromptVersionSync,
  planReplayTrials,
  planRetroReplays,
  promptVersionRef,
  readAttributions,
  readReplayLedger,
  recordAaFlipRate,
  recordReplayInfra,
  recordReplayTrial,
  replayTaskKey,
  replayTasks,
  writeReplayResult,
  type LockedShaFor,
  type PendingReplay,
  type ReplayLedgerScope,
  type ReplayTask,
} from "../lookback/index.js";

export interface ReplayWiringDeps {
  readonly projectRoot: string;
  readonly vtcHome: string;
  /** The project's `engineRepoKey`. */
  readonly repoKey: string;
  /** Events of every run the engine holds. */
  readonly history: () => readonly VtcEvent[];
  readonly lockedShaFor: LockedShaFor;
  /** The compiled locked core and default editable section of a role's agent on a host. */
  readonly compiled: (
    role: string,
    mode: string | undefined,
    host: HostId,
  ) => { readonly locked: string; readonly editable: string } | undefined;
  /** The AI tiebreak keys the engine recorded (only those `ai_tiebreak` rows count). */
  readonly tiebreaks: () => Promise<ReadonlySet<string>>;
  readonly graderBundleSha: () => string;
  /** The run's Lead host and the percent of its weekly window left (`null` when unknown). */
  readonly weeklyWindow: (state: RunState) => {
    readonly host: HostId;
    readonly pct: number | null;
  };
  readonly budgetAvailable: (state: RunState) => boolean;
  readonly gateRunner: GateRunner;
  readonly now: () => Date;
  /** How a replay's trials were graded (`replayGraderFor`); absent: `gates`. */
  readonly graderOf?: (replay: LookbackReplay) => ReplayGrader | null;
}

/** A version with the editable section it carries (trimmed). */
interface Arm {
  readonly version: PromptVersionRef;
  readonly text: string;
}

/** The proposals recorded in the history and not yet replayed, oldest first, with their role. */
export const pendingProposals = (
  history: readonly VtcEvent[],
): { readonly proposal: string; readonly role: string; readonly at: string }[] => {
  const pending = new Map<string, { role: string; at: string }>();
  for (const e of history) {
    if (e.type === "lookback.proposal_recorded") {
      const data = e.data as { proposal: string; path: string };
      // `.vtc/lookback/proposals/<role>/proposal.json`
      const role = data.path.split("/").at(-2);
      if (role !== undefined && !pending.has(data.proposal))
        pending.set(data.proposal, { role, at: e.ts });
    } else if (e.type === "lookback.replay_finished") {
      pending.delete((e.data as { proposal: string }).proposal);
    }
  }
  return [...pending].map(([proposal, { role, at }]) => ({ proposal, role, at }));
};

const FENCE = "---";

/** The frontmatter of a stored version file, or `undefined` when it does not parse. */
const frontmatterOf = (text: string) => {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FENCE}\n`)) return undefined;
  const end = normalized.indexOf(`\n${FENCE}\n`, FENCE.length);
  if (end === -1) return undefined;
  try {
    const parsed = parsePersisted(
      PromptVersionFrontmatterSchema,
      parseYaml(normalized.slice(FENCE.length + 1, end + 1)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const dirsOf = (path: string): string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
};

/**
 * The candidate version stored for a proposal (`candidateFrontmatter`: its `proposal`), checked
 * against the compiled locked core it runs with, and the version it was proposed against.
 */
const armsOf = (
  deps: ReplayWiringDeps,
  proposal: string,
  role: string,
): { readonly baseline: Arm; readonly candidate: Arm } | string => {
  const prompts = join(deps.vtcHome, LOOKBACK_HOME.promptsDir);
  for (const dir of dirsOf(prompts)) {
    if (dir !== role && !dir.startsWith(`${role}-`)) continue;
    for (const host of dirsOf(join(prompts, dir))) {
      let files: string[];
      try {
        files = readdirSync(join(prompts, dir, host)).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const file of files) {
        let text: string;
        try {
          text = readFileSync(join(prompts, dir, host, file), "utf8");
        } catch {
          continue;
        }
        const front = frontmatterOf(text);
        if (front?.proposal !== proposal || front.version.role !== role) continue;
        const target = front.version;
        const compiled = deps.compiled(target.role, target.mode, target.host);
        if (compiled === undefined)
          return `the compiled prompt of ${role} on ${target.host} is not in this vtc's plugin`;
        const candidate = loadPromptVersionSync(
          deps.vtcHome,
          target,
          target.effective_sha256,
          compiled.locked,
        );
        if (candidate === undefined)
          return `its candidate version ${target.effective_sha256.slice(0, 8)} does not verify against the compiled locked core`;
        const defaultRef = promptVersionRef({
          role: target.role,
          mode: target.mode,
          host: target.host,
          locked: compiled.locked,
          editable: compiled.editable,
        });
        let baseline: Arm;
        if (front.parent === null) return "its candidate names no version it was proposed against";
        if (front.parent === defaultRef.effective_sha256) {
          baseline = { version: defaultRef, text: compiled.editable.trim() };
        } else {
          const stored = loadPromptVersionSync(deps.vtcHome, target, front.parent, compiled.locked);
          if (stored === undefined)
            return `its baseline version ${front.parent.slice(0, 8)} is neither the compiled default nor a stored version`;
          baseline = { version: stored.frontmatter.version, text: stored.editable.trim() };
        }
        return {
          baseline,
          candidate: { version: candidate.frontmatter.version, text: candidate.editable.trim() },
        };
      }
    }
  }
  return "no candidate version is stored for it";
};

/**
 * The recorded dispatch a replay task re-runs: its pack, still the engine's (the pack file of an
 * action id is rewritten by a later run's dispatch of the same id), the commit it started from
 * (the task's last submitted head before it, else the task's workspace base), and the QA-owned
 * acceptance tests its round protected (the last QA submission before it with any, §7.3).
 */
const recordedDispatch = (
  history: readonly VtcEvent[],
  projectRoot: string,
  task: ReplayTask,
  role: string,
):
  | {
      readonly pack: TaskPack;
      readonly base: string;
      readonly protectedPaths: string[];
      readonly tier?: TierRoute;
    }
  | undefined => {
  const ofRun = history.filter((e) => e.run === task.run);
  const dispatched = ofRun.find(
    (e) =>
      e.type === "role.dispatched" && (e.data as { action_id?: string }).action_id === task.trace,
  );
  if (dispatched === undefined) return undefined;
  let pack: TaskPack;
  try {
    const parsed = TaskPackSchema.safeParse(
      JSON.parse(readFileSync(join(projectRoot, taskPackJsonPath(task.trace)), "utf8")),
    );
    if (!parsed.success) return undefined;
    pack = parsed.data;
  } catch {
    return undefined;
  }
  if (pack.run !== task.run || pack.action_id !== task.trace || pack.role !== role)
    return undefined;
  const before = ofRun.filter((e) => e.task === task.task && e.seq < dispatched.seq);
  const submitted = before.filter((e) => e.type === "role.submitted");
  const head = submitted
    .map((e) => (e.data as { head?: string }).head)
    .filter((h): h is string => h !== undefined)
    .at(-1);
  const workspace = before
    .filter((e) => e.type === "task.workspace_assigned")
    .map((e) => (e.data as { baseline_revision?: string }).baseline_revision)
    .filter((h): h is string => h !== undefined)
    .at(-1);
  const base = head ?? workspace;
  const protectedPaths =
    submitted
      .filter((e) => e.role === "qa")
      .map((e) =>
        ((e.data as { artifacts?: { type: string; path: string }[] }).artifacts ?? [])
          .filter((a) => a.type === ACCEPTANCE_TESTS.artifactType)
          .map((a) => a.path),
      )
      .filter((paths) => paths.length > 0)
      .at(-1) ?? [];
  // D-cm (reading 218 (7)): the trial runs on the tier the recorded dispatch ran on
  const recorded = dispatched.data as {
    tier?: ModelTier;
    tier_reason?: TierReason;
    tier_clamped?: boolean;
  };
  const tier: TierRoute | undefined =
    recorded.tier === undefined || recorded.tier_reason === undefined
      ? undefined
      : {
          tier: recorded.tier,
          reason: recorded.tier_reason,
          clamped: recorded.tier_clamped ?? false,
        };
  return base === undefined
    ? undefined
    : { pack, base, protectedPaths, ...(tier === undefined ? {} : { tier }) };
};

/**
 * Why no replay trial may run now (AD-21 rule 8, reading 176: the lookback role's own checks), or
 * `null`: the weekly window of the run's Lead host, then the budget.
 */
export const replayWaitReason = (deps: ReplayWiringDeps, state: RunState): string | null => {
  const { host, pct } = deps.weeklyWindow(state);
  const lead = `${host} (the run's Lead host)`;
  if (pct === null || pct < LOOKBACK_LIMITS.minWeeklyRemainingPct)
    return `${pct === null ? `the weekly window of ${lead} is unknown` : `${String(Math.round(pct))}% of the weekly window of ${lead} is left`}; a replay needs ${String(LOOKBACK_LIMITS.minWeeklyRemainingPct)}%`;
  if (!deps.budgetAvailable(state)) return "the run has no budget left for replay trials";
  return null;
};

/** A proposal's replay as planned in full: its arms, grader and every trial of its plan. */
interface FullPlan {
  readonly baseline: Arm;
  readonly candidate: Arm;
  /** `null`: nothing can grade the role (`planRetroReplays` leaves it out with the reason). */
  readonly grader: ReplayGrader | null;
  readonly mode?: string;
  readonly host: HostId;
  readonly trials: readonly LookbackReplayTrial[];
}

/** The ledger scope of a replay (its project, proposal, arms and grader bundle). */
const scopeOf = (
  deps: ReplayWiringDeps,
  proposal: string,
  arms: Pick<FullPlan, "baseline" | "candidate">,
): ReplayLedgerScope => ({
  repoKey: deps.repoKey,
  proposal,
  baseline: arms.baseline.version.effective_sha256,
  candidate: arms.candidate.version.effective_sha256,
  graderBundleSha: deps.graderBundleSha(),
});

/**
 * The `replays`, `replayWait`, `recordTrial`, `gradeTrial`, `gradeVerdict` and `finishReplay`
 * parts of core's `LookbackRetro`.
 */
export const createLookbackReplays = (
  deps: ReplayWiringDeps,
): Required<
  Pick<
    LookbackRetro,
    "replays" | "replayWait" | "recordTrial" | "gradeTrial" | "gradeVerdict" | "finishReplay"
  >
> => {
  /** A proposal's full plan from the history now, or why it has none. */
  const fullPlan = async (
    history: readonly VtcEvent[],
    proposal: string,
    role: string,
    context: {
      readonly tiebreaks: ReadonlySet<string>;
      readonly attributions: Awaited<ReturnType<typeof readAttributions>>;
    },
  ): Promise<FullPlan | string> => {
    const arms = armsOf(deps, proposal, role);
    if (typeof arms === "string") return arms;
    const { baseline, candidate } = arms;
    const mode = baseline.version.mode;
    const host = baseline.version.host;
    // D-ch: a verdict role's held-out tasks are the dispatches with a recorded outcome, each
    // keyed with the verdict a trial must give (`replayTaskKey`)
    const grader =
      deps.graderOf === undefined
        ? "gates"
        : deps.graderOf({
            proposal,
            role,
            ...(mode === undefined ? {} : { mode }),
            host,
            trials: [],
          });
    const resolved = replayTasks({
      history,
      lockedShaFor: deps.lockedShaFor,
      tiebreaks: context.tiebreaks,
      baseline: baseline.version,
      attributions: context.attributions,
      ...(grader === "verdict" ? { grader } : {}),
    }).flatMap((task) => {
      const recorded = recordedDispatch(history, deps.projectRoot, task, role);
      return recorded === undefined ? [] : [{ task, ...recorded }];
    });
    if (resolved.length === 0) return "no held-out task of its baseline can be run again";
    const recorded = new Map(resolved.map((r) => [`${r.task.run}:${r.task.trace}`, r]));
    const withAa =
      (await cachedAaFlipRate({
        vtcHome: deps.vtcHome,
        repoKey: deps.repoKey,
        baseline: baseline.version,
        graderBundleSha: deps.graderBundleSha(),
      })) === undefined;
    const trials = planReplayTrials({
      tasks: resolved.map((r) => r.task),
      baseline: baseline.version,
      candidate: candidate.version,
      withAa,
    }).flatMap((t): LookbackReplayTrial[] => {
      const r = recorded.get(`${t.task.run}:${t.task.trace}`);
      if (r === undefined) return [];
      return [
        {
          arm: t.arm,
          trial: t.trial,
          // a verdict task's key carries its expected verdict (two criteria of one task are
          // two entries, reading 211)
          task: replayTaskKey(t.task),
          regressionSet: t.task.regressionSet,
          role,
          ...(mode === undefined ? {} : { mode }),
          host,
          prompt: {
            version: t.prompt,
            text: t.arm === "b" ? candidate.text : baseline.text,
          },
          pack: r.pack,
          base: r.base,
          ...(r.protectedPaths.length === 0 ? {} : { protectedPaths: r.protectedPaths }),
          ...(r.tier === undefined ? {} : { tier: r.tier }),
        },
      ];
    });
    return {
      baseline,
      candidate,
      grader,
      ...(mode === undefined ? {} : { mode }),
      host,
      trials,
    };
  };
  const context = async (history: readonly VtcEvent[]) => {
    const tiebreaks = await deps.tiebreaks();
    const attributions = await readAttributions(deps.projectRoot, {
      history,
      lockedShaFor: deps.lockedShaFor,
      tiebreaks,
    });
    return { tiebreaks, attributions };
  };
  return {
    replays: async (state) => {
      const history = deps.history();
      const pending = pendingProposals(history);
      if (pending.length === 0) return { replays: [] };
      const known = await context(history);
      const ledger = await readReplayLedger(deps.vtcHome);
      const left: string[] = [];
      const plans = new Map<string, FullPlan>();
      const full: PendingReplay<LookbackReplayTrial>[] = [];
      for (const { proposal, role, at } of pending) {
        const planned = await fullPlan(history, proposal, role, known);
        if (typeof planned === "string") {
          left.push(`${proposal}: ${planned}`);
          continue;
        }
        plans.set(proposal, planned);
        full.push({
          proposal,
          role,
          ...(planned.mode === undefined ? {} : { mode: planned.mode }),
          host: planned.host,
          recordedAt: at,
          // `planRetroReplays` asks `replayGraderFor` again: a gates-graded role changes files
          changesFiles: planned.grader === "gates",
          trials: planned.trials,
        });
      }
      // D-cg (reading 201): the trials this RETRO launches, under the lookback role's own checks
      // (the weekly window of the run's Lead host, the budget, AD-21 rule 8) and D-cq's cap
      const { pct } = deps.weeklyWindow(state);
      const scope = (proposal: string): ReplayLedgerScope | undefined => {
        const plan = plans.get(proposal);
        return plan === undefined ? undefined : scopeOf(deps, proposal, plan);
      };
      const launch = planRetroReplays({
        pending: full,
        graded: (proposal) => {
          const of = scope(proposal);
          return new Set(of === undefined ? [] : ledger.trials(of).keys());
        },
        infra: (proposal) => {
          const of = scope(proposal);
          return of === undefined ? new Map() : ledger.infra(of);
        },
        weeklyRemainingPct: pct,
        budgetAvailable: deps.budgetAvailable(state),
        cap: lookbackPaceFor(undefined, pct).maxTrialsPerRetro,
      });
      for (const u of launch.unreplayable) left.push(`${u.proposal}: ${u.reason}`);
      // the lookback role's own checks first (reading 176): a limit says why nothing runs now,
      // logged once (Lookback's own skip when it had a replay to hold back, else core's)
      const limit = replayWaitReason(deps, state);
      const wait = [limit, left.length === 0 ? null : `left out: ${left.join("; ")}`]
        .filter((w): w is string => w !== null)
        .join("; ");
      const replays: LookbackReplay[] = launch.launch.map((l) => ({
        proposal: l.proposal,
        role: l.role,
        ...(l.mode === undefined ? {} : { mode: l.mode }),
        host: l.host,
        trials: l.trials,
      }));
      const limited = launch.skipped.some((e) => e.data.reason !== "plugin_locked");
      return {
        replays,
        ...(wait === "" ? {} : { wait: wait.slice(0, 2000) }),
        ...(limit === null || limited ? {} : { waitKind: replayWaitSkipReason(limit) }),
        ...(launch.skipped.length === 0 ? {} : { events: launch.skipped }),
      };
    },
    replayWait: (state) => replayWaitReason(deps, state),
    // D-cg (reading 201): every grade and every infrastructure attempt, as core learns it
    recordTrial: async (replay, trial, record) => {
      const arms = armsOf(deps, replay.proposal, replay.role);
      if (typeof arms === "string") throw new Error(arms);
      const identity = {
        repo_key: deps.repoKey,
        proposal: replay.proposal,
        baseline: arms.baseline.version.effective_sha256,
        candidate: arms.candidate.version.effective_sha256,
        task: trial.task,
        arm: trial.arm,
        trial: trial.trial,
        grader_bundle_sha: deps.graderBundleSha(),
      };
      const at = deps.now().toISOString();
      if (record.kind === "graded")
        await recordReplayTrial(deps.vtcHome, {
          ...identity,
          passed: record.passed,
          tokens: Math.max(0, Math.round(record.tokens)),
          read_denied: record.readDenied,
          graded_at: at,
        });
      else await recordReplayInfra(deps.vtcHome, { ...identity, outcome: record.outcome, at });
    },
    // the verdict itself: `infra_error` measures nothing (core sets the replay aside)
    gradeTrial: async (request) => (await deps.gateRunner.run(request)).verdict,
    // D-ch (reading 212(4)): a verdict role's trial scored against the recorded outcome of the
    // dispatch it replays (its recorded pack's run and action id), the expectation its task key
    // carries; `infra_error` when that dispatch has no recorded outcome any more
    gradeVerdict: (trial, result) =>
      Promise.resolve(
        gradeVerdictReplay(
          deps.history(),
          { run: trial.pack.run, trace: trial.pack.action_id },
          result.verdicts,
          expectedOfTaskKey(trial.task),
        ),
      ),
    // the result once the ledger holds every trial of the plan; nothing while some are missing
    finishReplay: async (replay) => {
      const history = deps.history();
      const planned = await fullPlan(history, replay.proposal, replay.role, await context(history));
      if (typeof planned === "string")
        throw new Error(`${replay.proposal} has no plan any more: ${planned}`);
      const scope = scopeOf(deps, replay.proposal, planned);
      const rows = (await readReplayLedger(deps.vtcHome)).trials(scope);
      const graderBundleSha = scope.graderBundleSha;
      const cached = await cachedAaFlipRate({
        vtcHome: deps.vtcHome,
        repoKey: deps.repoKey,
        baseline: planned.baseline.version,
        graderBundleSha,
      });
      const assembled = assembleReplay({
        proposal: replay.proposal,
        baseline: planned.baseline.version,
        candidate: planned.candidate.version,
        grader: planned.grader ?? "gates",
        planned: planned.trials,
        rows,
        ...(cached === undefined ? {} : { cachedAaFlipRate: cached }),
        graderBundleSha,
        now: deps.now(),
      });
      if (!assembled.complete) return [];
      if (assembled.measuredAaFlipRate !== undefined)
        await recordAaFlipRate({
          vtcHome: deps.vtcHome,
          repoKey: deps.repoKey,
          baseline: planned.baseline.version,
          graderBundleSha,
          aaFlipRate: assembled.measuredAaFlipRate,
          now: deps.now(),
        });
      return [await writeReplayResult(deps.projectRoot, assembled.result)];
    },
  };
};
