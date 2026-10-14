/**
 * Lookback replays as the daemon wires them into RETRO (AD-21 rule 6; spine §5 reading 176): the
 * `replays`, `gradeTrial` and `finishReplay` parts of core's `LookbackRetro`, over the lookback
 * module (core never imports lookback, AD-13 rule 12).
 * - `replays`: every proposal recorded (`lookback.proposal_recorded`) and not yet replayed
 *   (`lookback.replay_finished`), in the history of every run, under the lookback role's own checks
 *   (the weekly window of the run's Lead host and the budget); its candidate is the immutable
 *   version stored for it, its baseline the version it was proposed against; its tasks the held-out
 *   failures and successes of the baseline (`replayTasks`) whose recorded pack is still the
 *   engine's and whose starting commit is known; its trials `planReplayTrials` (with an A/A arm when
 *   no noise floor is cached for the baseline). A proposal whose versions or tasks cannot be found
 *   is left out with its reason.
 * - `replayWait`: the same window and budget checks, which core runs again before every trial.
 * - `gradeTrial`: the Gate Runner's verdict on the trial (`pass`, `fail`, or `infra_error`, which
 *   measures nothing).
 * - `finishReplay`: `finishReplay` over the graded trials, `writeReplayResult` (the event carries
 *   the SHA-256 of the bytes written), and the measured A/A flip rate kept for the next replay.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCEPTANCE_TESTS,
  LOOKBACK_HOME,
  LOOKBACK_LIMITS,
  parsePersisted,
  PromptVersionFrontmatterSchema,
  TaskPackSchema,
  type GateRunner,
  type HostId,
  type PromptVersionRef,
  type ReplayGrader,
  type ReplayIsolation,
  type TaskPack,
  type VtcEvent,
} from "@vtc/shared";
import {
  parseYaml,
  replayWaitSkipReason,
  taskPackJsonPath,
  type LookbackReplay,
  type LookbackReplayTrial,
  type LookbackRetro,
  type ReplayTrialOutcome,
  type RunState,
} from "../core/index.js";
import {
  aaFlipRate,
  cachedAaFlipRate,
  finishReplay,
  loadPromptVersionSync,
  planReplayTrials,
  promptVersionRef,
  readAttributions,
  recordAaFlipRate,
  replayTasks,
  tokensDeltaPct,
  writeReplayResult,
  type LockedShaFor,
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
): { readonly proposal: string; readonly role: string }[] => {
  const pending = new Map<string, string>();
  for (const e of history) {
    if (e.type === "lookback.proposal_recorded") {
      const data = e.data as { proposal: string; path: string };
      // `.vtc/lookback/proposals/<role>/proposal.json`
      const role = data.path.split("/").at(-2);
      if (role !== undefined && !pending.has(data.proposal)) pending.set(data.proposal, role);
    } else if (e.type === "lookback.replay_finished") {
      pending.delete((e.data as { proposal: string }).proposal);
    }
  }
  return [...pending].map(([proposal, role]) => ({ proposal, role }));
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
  | { readonly pack: TaskPack; readonly base: string; readonly protectedPaths: string[] }
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
  return base === undefined ? undefined : { pack, base, protectedPaths };
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

/** The `replays`, `replayWait`, `gradeTrial` and `finishReplay` parts of core's `LookbackRetro`. */
export const createLookbackReplays = (
  deps: ReplayWiringDeps,
): Required<Pick<LookbackRetro, "replays" | "replayWait" | "gradeTrial" | "finishReplay">> => ({
  replays: async (state) => {
    const history = deps.history();
    const pending = pendingProposals(history);
    if (pending.length === 0) return { replays: [] };
    // AD-21 rule 8: the same checks as the lookback role (reading 176)
    const wait = replayWaitReason(deps, state);
    if (wait !== null) return { replays: [], wait, waitKind: replayWaitSkipReason(wait) };
    const tiebreaks = await deps.tiebreaks();
    const attributions = await readAttributions(deps.projectRoot, {
      history,
      lockedShaFor: deps.lockedShaFor,
      tiebreaks,
    });
    const replays: LookbackReplay[] = [];
    const left: string[] = [];
    for (const { proposal, role } of pending) {
      const arms = armsOf(deps, proposal, role);
      if (typeof arms === "string") {
        left.push(`${proposal}: ${arms}`);
        continue;
      }
      const { baseline, candidate } = arms;
      const resolved = replayTasks({
        history,
        lockedShaFor: deps.lockedShaFor,
        tiebreaks,
        baseline: baseline.version,
        attributions,
      }).flatMap((task) => {
        const recorded = recordedDispatch(history, deps.projectRoot, task, role);
        return recorded === undefined ? [] : [{ task, ...recorded }];
      });
      if (resolved.length === 0) {
        left.push(`${proposal}: no held-out task of its baseline can be run again`);
        continue;
      }
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
            task: `${t.task.run}:${t.task.task}`,
            regressionSet: t.task.regressionSet,
            role,
            ...(baseline.version.mode === undefined ? {} : { mode: baseline.version.mode }),
            host: baseline.version.host,
            prompt: {
              version: t.prompt,
              text: t.arm === "b" ? candidate.text : baseline.text,
            },
            pack: r.pack,
            base: r.base,
            ...(r.protectedPaths.length === 0 ? {} : { protectedPaths: r.protectedPaths }),
          },
        ];
      });
      replays.push({
        proposal,
        role,
        ...(baseline.version.mode === undefined ? {} : { mode: baseline.version.mode }),
        host: baseline.version.host,
        trials,
      });
    }
    return left.length === 0
      ? { replays }
      : { replays, wait: `left out: ${left.join("; ")}`.slice(0, 2000) };
  },
  replayWait: (state) => replayWaitReason(deps, state),
  // the verdict itself: `infra_error` measures nothing (core sets the replay aside)
  gradeTrial: async (request) => (await deps.gateRunner.run(request)).verdict,
  finishReplay: async (replay, outcomes) => {
    const outcome = new Map<number, ReplayTrialOutcome>(outcomes.map((o) => [o.n, o]));
    const tasks = new Map<
      string,
      { a: boolean[]; b: boolean[]; aa: boolean[]; regressionSet: boolean }
    >();
    const tokens: { a: number[]; b: number[] } = { a: [], b: [] };
    let k = 1;
    for (const [n, trial] of replay.trials.entries()) {
      const o = outcome.get(n);
      if (o === undefined)
        throw new Error(`trial ${String(n)} of ${replay.proposal} is not graded`);
      const row = tasks.get(trial.task) ?? {
        a: [],
        b: [],
        aa: [],
        regressionSet: trial.regressionSet,
      };
      row[trial.arm].push(o.passed);
      tasks.set(trial.task, row);
      if (trial.arm !== "aa") tokens[trial.arm].push(o.tokens);
      k = Math.max(k, trial.trial);
    }
    const baseline = replay.trials.find((t) => t.arm === "a")?.prompt.version;
    const candidate = replay.trials.find((t) => t.arm === "b")?.prompt.version;
    if (baseline === undefined || candidate === undefined)
      throw new Error(`${replay.proposal} has no trial of each arm`);
    const rows = [...tasks.values()];
    const measured = rows.some((r) => r.aa.length > 0);
    const graderBundleSha = deps.graderBundleSha();
    const aa = measured
      ? aaFlipRate(rows.filter((r) => r.aa.length > 0).map((r) => ({ a: r.a, aa: r.aa })))
      : ((await cachedAaFlipRate({
          vtcHome: deps.vtcHome,
          repoKey: deps.repoKey,
          baseline,
          graderBundleSha,
        })) ?? 0);
    if (measured)
      await recordAaFlipRate({
        vtcHome: deps.vtcHome,
        repoKey: deps.repoKey,
        baseline,
        graderBundleSha,
        aaFlipRate: aa,
        now: deps.now(),
      });
    const result = finishReplay({
      proposal: replay.proposal,
      baseline,
      candidate,
      graderBundleSha,
      k,
      perTask: [...tasks].map(([task, r]) => ({
        task,
        a: r.a,
        b: r.b,
        regressionSet: r.regressionSet,
      })),
      aaFlipRate: aa,
      tokensDeltaPct: tokensDeltaPct(tokens.a, tokens.b),
      now: deps.now(),
    });
    // reading 178: read_denied only when the host enforced every trial's read deny; the grader
    // that scored the trials (D-ch; replayGraderFor)
    const isolation: ReplayIsolation = outcomes.every((o) => o.readDenied === true)
      ? "read_denied"
      : "paths_only";
    const grader: ReplayGrader = deps.graderOf?.(replay) ?? "gates";
    return [await writeReplayResult(deps.projectRoot, { ...result, isolation, grader })];
  },
});
