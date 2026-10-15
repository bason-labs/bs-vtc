/**
 * Lookback replays at RETRO (spec §13 step 3; AD-21 rule 6; spine §5 readings 176, 178, 201, 202
 * and 205): once every lookback target is settled, RETRO runs the trials of the replays the wired
 * Lookback returns, one at a time, each an engine-launched headless run (D-cg: never a Lead's
 * subagent, and with no `headless_allowed`) in a clean checkout at the recorded base with the arm's
 * prompt; on Claude Code each arm runs its own compiled plugin (`--plugin-dir`), whose load the run
 * must prove. Each accepted trial is graded through the Gate Runner (or, for a verdict role, by the
 * verdict grader) with its head readable in the user's repo, a trial that ends without a result did
 * not pass, and the replay's result is written before the run finishes. A trial whose arm cannot
 * run as planned is not run; the weekly window, the budget and the per-RETRO trial cap stop trials
 * with `automation.skipped`; a replay that has to stop waits for the next RETRO without pausing the
 * delivered run. Nothing a trial does touches a task.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectivePromptSha,
  LOOKBACK_LIMITS,
  sha256Hex,
  TASK_PACK_HEURISTICS_SECTION,
  TaskPackSchema,
  type ArmPluginCompiler,
  type ArmPluginRequest,
  type GateRunRequest,
  type GitChangedFile,
  type HostOutcome,
  type PromptVersionRef,
  type RoleResult,
  type RoleResultInput,
  type SpawnRoleRequest,
  type TaskPack,
} from "@vtc/shared";
import {
  createPluginCatalog,
  replayWaitSkipReason,
  type EventDraft,
  type LookbackReplay,
  type LookbackReplayTrial,
  type LookbackRetro,
  type PluginCatalog,
  type ReplayTrialOutcome,
  type RunHandle,
  type RunState,
} from "../../src/core/index.js";
import { refuseInSession, type StepSpec } from "../../src/core/dispatch.js";
import { createGitOps } from "../../src/git/index.js";
import { createLookbackReplays, type ReplayWiringDeps } from "../../src/daemon/replays.js";
import { cleanupDirs, git, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  passFinalReview,
  SPEC_ONE,
  spawns,
  throughPlan,
  verdictPass,
  worktreeOf,
  type Harness,
  type HarnessOptions,
  type HeadlessScript,
  type SpawnAction,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 40_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  role?: string;
  task?: string;
  feature?: string;
  prompt_sha?: string;
  model?: string;
  data: Record<string, unknown>;
}
const eventsOf = (repo: string, run: string): Line[] =>
  readFileSync(join(repo, `.vtc/runs/${run}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const events = (h: Harness): Line[] => eventsOf(h.repo, h.engine.status({}).run.id);

const LOCKED = "You are the Engineer.";
const BASELINE = "Make the smallest change that meets the contract.";
const CANDIDATE = "Write the failing test first, then the smallest change.";
const ROLE = "engineer";
/** The file a trial writes when it does the work. */
const IMPL = "src/t-1/impl.ts";
/** A file a trial leaves ignored in its tree (an installed stub): never in the graded checkout. */
const LEFTOVER = "node_modules/stub/index.js";

/** Every agent takes its editable section from the pack (reading 117). */
const switched: PluginCatalog = {
  ...createPluginCatalog({}),
  promptParts: () => ({
    lockedSha256: sha256Hex(LOCKED),
    editableInPack: true,
    compiled: { locked: LOCKED, editable: BASELINE },
  }),
};

/** As shipped: the agent carries its own editable section (not `editable_in_pack`). */
const own: PluginCatalog = {
  ...switched,
  promptParts: () => ({
    lockedSha256: sha256Hex(LOCKED),
    editableInPack: false,
    compiled: { locked: LOCKED, editable: BASELINE },
  }),
};

const version = (editable: string, role = ROLE): PromptVersionRef => ({
  role,
  host: "claude-code",
  locked_sha256: sha256Hex(LOCKED),
  editable_sha256: sha256Hex(editable),
  effective_sha256: effectivePromptSha(LOCKED, editable),
});

/** A fake `compileArm` (roles-compiler's, D-cg): a plugin copy whose agent carries the arm. */
const armCompiler = (
  compiled: ArmPluginRequest[],
  sha: (request: ArmPluginRequest) => string = (r) => effectivePromptSha(LOCKED, r.editable),
): ArmPluginCompiler => ({
  compileArm: (request) => {
    compiled.push(request);
    writeFileSync(join(request.outDir, "plugin.json"), `${JSON.stringify({ name: "vtc" })}\n`);
    return Promise.resolve({
      dir: request.outDir,
      version: "arm-000000000000",
      promptSha256: sha(request),
    });
  },
});

interface Delivered {
  /** The replayed role's recorded pack. */
  readonly pack: TaskPack;
  /** The commit its dispatch started from. */
  readonly base: string;
}

const packOf = (h: Harness, action: SpawnAction): TaskPack =>
  TaskPackSchema.parse(
    JSON.parse(readFileSync(join(h.repo, action.pack.replace(/\.md$/, ".json")), "utf8")),
  );

/** One headless trial as the fake host saw it at its start. */
interface TrialRun {
  readonly request: SpawnRoleRequest;
  /** The trial's working directory (its clean checkout). */
  readonly cwd: string;
  /** The task pack's Markdown. */
  readonly pack: string;
  /** The arm it runs, from the pack's opening `Role heuristics` section. */
  readonly text: string;
  readonly head: string;
  readonly refs: string;
  readonly implAtStart: boolean;
  readonly gitFile: string;
  /** The trial's `role.dispatched`, logged before the launch. */
  readonly dispatched: Line | undefined;
  /** Whether its arm plugin directory exists while the run works. */
  readonly pluginDirPresent: boolean;
}

/** What a trial does: writes the implementation, more, and answers this outcome. */
interface Behaviour {
  readonly work?: boolean;
  readonly also?: (cwd: string) => void;
  readonly result?: Partial<RoleResultInput>;
}

/**
 * The fake host's headless runs (D-cg: every trial is one): it records what a trial saw when it
 * started, runs the test's behaviour for it (default: the candidate does the work), and answers.
 */
const trialHost = (repo: () => string, run: () => string) => {
  const runs: TrialRun[] = [];
  let behave: (trial: TrialRun, n: number) => Behaviour = (t) => ({ work: t.text === CANDIDATE });
  const script: HeadlessScript = (request): HostOutcome => {
    const packPath = /^Read your task pack: (.*)$/m.exec(request.prompt)?.[1] ?? "";
    const pack = readFileSync(packPath, "utf8");
    const heading = `## ${TASK_PACK_HEURISTICS_SECTION}\n\n`;
    const text = pack.startsWith(heading)
      ? (pack.slice(heading.length).split("\n\n## ")[0] ?? "").trim()
      : "";
    const trial: TrialRun = {
      request,
      cwd: request.cwd,
      pack,
      text,
      head: git(request.cwd, "rev-parse", "HEAD"),
      refs: git(request.cwd, "for-each-ref"),
      implAtStart: existsSync(join(request.cwd, IMPL)),
      gitFile: readFileSync(join(request.cwd, ".git"), "utf8"),
      dispatched: eventsOf(repo(), run()).findLast((e) => e.type === "role.dispatched"),
      pluginDirPresent: request.pluginDir !== undefined && existsSync(request.pluginDir),
    };
    runs.push(trial);
    const b = behave(trial, runs.length - 1);
    if (b.work === true) writeFile(request.cwd, IMPL, "export const x = 2;\n");
    b.also?.(request.cwd);
    return {
      kind: "done",
      session_ref: null,
      output: { role: request.role, summary: "done", exit: "built", ...b.result },
      model: "sonnet",
      tokens: { in: 100, out: 50, cache_r: 0, cache_w: 0 },
      cost_usd: 0.1,
    };
  };
  return {
    runs,
    script,
    set: (fn: (trial: TrialRun, n: number) => Behaviour) => {
      behave = fn;
    },
  };
};

/**
 * One task delivered at Level 1 (the release starts RETRO): `seen` gets the recorded dispatch of
 * `role` (the Engineer's pack and the commit it started from, or the Spec Verifier's and the head
 * it judged) before RETRO plans its replays. Returns once RETRO ran what it could, with the Lead
 * calling `next` as it does.
 */
const toRetro = async (
  h: Harness,
  seen: (d: Delivered) => void,
  role: "engineer" | "spec_verifier" = ROLE,
): Promise<Delivered & { readonly pending: SpawnAction[] }> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  const engineer = only((await h.engine.next({}, CLAUDE)).actions, "engineer");
  const started = git(worktreeOf(h, "T-1"), "rev-parse", "HEAD");
  const engineerPack = packOf(h, engineer);
  await build(h, engineer);
  const verifier = only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");
  const built = events(h).findLast((e) => e.type === "role.submitted" && e.role === "engineer");
  const delivered =
    role === "engineer"
      ? { pack: engineerPack, base: started }
      : { pack: packOf(h, verifier), base: String(built?.data.head) };
  seen(delivered);
  await verdictPass(h, verifier, IMPL);
  await h.engine.settle();
  const pending = spawns(await passFinalReview(h));
  await h.engine.settle();
  for (let i = 0; i < 4 && h.engine.status({}).run.finished_at === undefined; i += 1) {
    pending.push(...spawns((await h.engine.next({}, CLAUDE)).actions));
    await h.engine.settle();
  }
  return { ...delivered, pending };
};

interface FakeOptions {
  readonly role?: string;
  /** A trial's prompt version, by arm (default: the arm's own). */
  readonly versionOf?: (arm: "a" | "b") => PromptVersionRef;
  readonly replayWait?: (state: RunState) => string | null;
  /** The recorded task's QA-owned tests, as the daemon reads them from the history. */
  readonly protectedPaths?: readonly string[];
  /** A replay `p-0` first, whose one trial's base is no commit of the repo. */
  readonly brokenFirst?: boolean;
  /** The grades (0-based, in order) the Gate Runner answers `infra_error`. */
  readonly infraGrades?: readonly number[];
  /** `finishReplay` throws. */
  readonly finishFails?: boolean;
  /** Trials per arm (default 1). */
  readonly perArm?: number;
  /** The verdict grader (D-ch); absent: none is wired. */
  readonly gradeVerdict?: LookbackRetro["gradeVerdict"];
  /** The tier the recorded dispatch ran on (D-cm); absent: a log from before 5.4.0. */
  readonly tier?: LookbackReplayTrial["tier"];
}

/**
 * A Lookback fake with no lookback target and one replay of `arms`. Its grader reads the trial's
 * `base..head` with the real `GitOps` over the user's repo, as the Gate Runner does: a trial
 * passes when it changed the implementation.
 */
const fakeReplays = (
  repo: string,
  arms: readonly ("a" | "b")[],
  context: () => Delivered,
  options: FakeOptions = {},
) => {
  const role = options.role ?? ROLE;
  const graded: GateRunRequest[] = [];
  /** What the graded checkout held: the trial's work, and what it left ignored. */
  const held: { impl: boolean; leftover: boolean }[] = [];
  const changes: (readonly GitChangedFile[])[] = [];
  const finished: { replay: LookbackReplay; outcomes: readonly ReplayTrialOutcome[] }[] = [];
  const retro: LookbackRetro = {
    plan: () => Promise.resolve({ targets: [] }),
    check: () => Promise.resolve({ ok: true, events: [] }),
    replays: () => {
      const { pack, base } = context();
      const trialOf = (arm: "a" | "b", i: number, at: string): LookbackReplayTrial => ({
        arm,
        trial: i + 1,
        task: "r-old:T-1",
        regressionSet: false,
        role,
        host: "claude-code",
        prompt: {
          version: options.versionOf?.(arm) ?? version(arm === "b" ? CANDIDATE : BASELINE, role),
          text: arm === "b" ? CANDIDATE : BASELINE,
        },
        pack,
        base: at,
        ...(options.protectedPaths === undefined ? {} : { protectedPaths: options.protectedPaths }),
        ...(options.tier === undefined ? {} : { tier: options.tier }),
      });
      const per = options.perArm ?? 1;
      return Promise.resolve({
        replays: [
          ...(options.brokenFirst === true
            ? [
                {
                  proposal: "p-0",
                  role,
                  host: "claude-code" as const,
                  trials: [trialOf("b", 0, "f".repeat(40))],
                },
              ]
            : []),
          {
            proposal: "p-1",
            role,
            host: "claude-code" as const,
            trials: Array.from({ length: per }, (_x, k) =>
              arms.map((arm, i) => trialOf(arm, k * arms.length + i, base)),
            ).flat(),
          },
        ],
      });
    },
    ...(options.replayWait === undefined ? {} : { replayWait: options.replayWait }),
    ...(options.gradeVerdict === undefined ? {} : { gradeVerdict: options.gradeVerdict }),
    gradeTrial: async (request) => {
      const index = graded.length;
      graded.push(request);
      held.push({
        impl: existsSync(join(repo, request.checkout, IMPL)),
        leftover: existsSync(join(repo, request.checkout, LEFTOVER)),
      });
      if (options.infraGrades?.includes(index) === true) return "infra_error";
      if (request.base === request.head) return "fail";
      const ops = createGitOps({ repoRoot: repo });
      const changed = await ops.changedFiles(request.base, request.head);
      changes.push(changed);
      // L5: a protected file whose checksum changed fails the run, as the Gate Runner's does
      for (const p of request.protected) {
        const bytes = await ops.readFileAtCommit(request.head, p.path);
        if (bytes === undefined || sha256Hex(new TextDecoder().decode(bytes)) !== p.sha256)
          return "fail";
      }
      return changed.some((f) => f.path === IMPL) ? "pass" : "fail";
    },
    finishReplay: (replay, outcomes) => {
      if (options.finishFails === true) return Promise.reject(new Error("the disk is full"));
      finished.push({ replay, outcomes });
      const draft: EventDraft = {
        type: "lookback.replay_finished",
        actor: "engine",
        data: {
          proposal: replay.proposal,
          verdict: "inconclusive",
          path: ".vtc/lookback/replays/p-1.json",
          sha256: "e".repeat(64),
        },
      };
      return Promise.resolve([draft]);
    },
  };
  return { retro, graded, held, changes, finished };
};

/** A harness whose RETRO replays one proposal with the fake (`reach` drives it there). */
const atRetro = (
  arms: readonly ("a" | "b")[],
  options: FakeOptions & { readonly harness?: HarnessOptions; readonly noArms?: boolean } = {},
) => {
  let runId = "";
  let repo = "";
  const trials = trialHost(
    () => repo,
    () => runId,
  );
  const compiled: ArmPluginRequest[] = [];
  const h = createHarness({
    project: { merge_level: 1 },
    plugins: switched,
    headless: trials.script,
    ...(options.noArms === true ? {} : { armPlugins: armCompiler(compiled) }),
    ...options.harness,
  });
  repo = h.repo;
  let context: Delivered | undefined;
  const fake = fakeReplays(
    h.repo,
    arms,
    () => {
      if (context === undefined) throw new Error("not at RETRO yet");
      return context;
    },
    options,
  );
  h.engine.setLookbackRetro(fake.retro);
  return {
    h,
    fake,
    trials,
    compiled,
    reach: (role?: "engineer" | "spec_verifier") =>
      toRetro(
        h,
        (d) => {
          runId = h.engine.status({}).run.id;
          context = d;
        },
        role,
      ),
    context: () => context,
  };
};

const runHandle = (h: Harness): RunHandle => {
  const handle = (h.engine as unknown as { handles: Map<string, RunHandle> }).handles.get(
    h.engine.status({}).run.id,
  );
  if (handle === undefined) throw new Error("no open run");
  return handle;
};

const candidateStep = (delivered: Delivered): StepSpec => ({
  key: "retro:replay:0-1",
  role: ROLE,
  purpose: "lookback_replay",
  replay: {
    replay: 0,
    n: 1,
    prompt: { version: version(CANDIDATE), text: CANDIDATE },
    pack: delivered.pack,
    base: delivered.base,
  },
});

const retroEvents = (h: Harness): Line[] => {
  const log = events(h);
  const at = log.findIndex((e) => e.type === "run.phase_changed" && e.data.to === "retro");
  return log.slice(at);
};

describe("RETRO runs Lookback replays as headless runs (AD-21 rule 6, readings 176 and 201)", () => {
  it("runs each trial headless in a clean checkout outside the user's repo with its arm's own plugin, grades its head in a clean verification checkout, writes the result, then finishes", async () => {
    const { h, fake, trials, compiled, reach } = atRetro(["a", "b"]);
    trials.set((t) => ({
      work: t.text === CANDIDATE,
      // the candidate also leaves an ignored stub behind that a gate run in its tree would pick up
      also: (cwd) => {
        if (t.text !== CANDIDATE) return;
        writeFile(cwd, ".gitignore", ".vtc/state/\nnode_modules/\n");
        writeFile(cwd, LEFTOVER, "module.exports = () => 0;\n");
      },
    }));
    const delivered = await reach();
    // D-cg: no trial is ever a Lead's subagent
    expect(delivered.pending.filter((a) => a.role === ROLE)).toEqual([]);
    expect(trials.runs).toHaveLength(2);
    const run = h.engine.status({}).run.id;
    for (const [i, text] of [BASELINE, CANDIDATE].entries()) {
      const trial = trials.runs[i];
      if (trial === undefined) throw new Error(`trial ${String(i)} did not run`);
      expect(trial.text).toBe(text);
      expect(trial.request.dispatch).toBe("headless");
      // a fresh private directory under the OS temp directory: no relative path reaches the repo
      expect(relative(realpathSync(tmpdir()), trial.cwd).startsWith("..")).toBe(false);
      expect(relative(realpathSync(h.repo), trial.cwd).startsWith("..")).toBe(true);
      expect(trial.gitFile).not.toContain(h.repo);
      // the clean checkout is at the recorded base, with no refs of the user's repo
      expect(trial.head).toBe(delivered.base);
      expect(trial.refs).toBe("");
      expect(trial.implAtStart).toBe(false);
      expect(trial.pack.startsWith(`## ${TASK_PACK_HEURISTICS_SECTION}\n\n${text}\n`)).toBe(true);
      expect(trial.dispatched?.prompt_sha).toBe(effectivePromptSha(LOCKED, text));
      expect(trial.dispatched?.task).toBeUndefined();
      // reading 177: the trial is marked in the log, so a clone tells it from the run's work
      expect(trial.dispatched?.data).toMatchObject({
        dispatch: "headless",
        purpose: "lookback_replay",
        replay: { arm: i === 0 ? "a" : "b", trial: i + 1, task: "r-old:T-1" },
      });
      // D-cg: the arm's own compiled plugin, under the engine's private area, loaded in place
      expect(trial.request.pluginDir).toBe(
        join(h.engine.guardDir, "lookback", "arms", `${run}--0-${String(i)}`, i === 0 ? "a" : "b"),
      );
      expect(trial.pluginDirPresent).toBe(true);
      expect(existsSync(trial.request.pluginDir ?? "")).toBe(false);
      expect(existsSync(trial.cwd)).toBe(false);
      // reading 178: the trial may read neither the user's repo nor its git directory
      expect(h.sandboxRequests.find((r) => r.cwd === trial.cwd)?.readDeny).toEqual([
        h.repo,
        join(h.repo, ".git"),
      ]);
    }
    expect(compiled.map((c) => [c.agent, c.editable])).toEqual([
      ["vtc-engineer", BASELINE],
      ["vtc-engineer", CANDIDATE],
    ]);
    expect(fake.graded).toHaveLength(2);
    for (const [i, request] of fake.graded.entries()) {
      // graded in a clean verification checkout of the head, never in the trial's tree
      expect(request.base).toBe(delivered.base);
      expect(request.checkout).toMatch(/^\.vtc\/state\/checkouts\//);
      expect(existsSync(join(h.repo, request.checkout))).toBe(false);
      expect(fake.held[i]).toEqual({ impl: i === 1, leftover: false });
    }
    expect(fake.graded[0]?.head).toBe(delivered.base);
    expect(fake.graded[1]?.head).not.toBe(delivered.base);
    expect(fake.changes).toEqual([
      [
        { path: ".gitignore", status: "modified" },
        { path: IMPL, status: "added" },
      ],
    ]);
    // the fake sandbox enforces no read deny: no outcome claims it (`paths_only`)
    expect(fake.finished[0]?.outcomes).toEqual([
      { n: 0, passed: false, tokens: 150 },
      { n: 1, passed: true, tokens: 150 },
    ]);
    const log = events(h);
    expect(log.filter((e) => e.type === "lookback.replay_finished")).toHaveLength(1);
    // the delivered run's own dispatches carry no purpose: they are the run's work
    const marked = log.filter(
      (e) => e.type === "role.dispatched" && (e.data as { purpose?: string }).purpose !== undefined,
    );
    expect(marked).toHaveLength(2);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    // the user's repo got no ref of a trial: its heads are only objects there
    expect(git(h.repo, "for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual([
      "refs/heads/main",
      "refs/heads/vtc/F-1",
      "refs/heads/vtc/T-1",
      "refs/remotes/origin/main",
    ]);
    await h.release();
  });

  it("replays the shipped Engineer, which carries its own editable section, through its arms' plugins (D-cg)", async () => {
    const { h, fake, trials, reach } = atRetro(["a", "b"], { harness: { plugins: own } });
    await reach();
    expect(trials.runs.map((t) => t.request.pluginDir !== undefined)).toEqual([true, true]);
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false, true]);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("runs every trial on the tier its recorded dispatch ran on, never re-routed (D-cm, reading 218 (7))", async () => {
    const recorded = atRetro(["a", "b"], {
      tier: { tier: "low", reason: "rule", clamped: false },
    });
    await recorded.reach();
    expect(
      recorded.trials.runs.map((t) => ({
        model: t.dispatched?.model,
        tier: t.dispatched?.data.tier,
        reason: t.dispatched?.data.tier_reason,
      })),
    ).toEqual([
      { model: "haiku", tier: "low", reason: "rule" },
      { model: "haiku", tier: "low", reason: "rule" },
    ]);
    await recorded.h.release();
    // a dispatch logged before 5.4.0 recorded no tier: the role's own
    const older = atRetro(["a"]);
    await older.reach();
    expect(older.trials.runs[0]?.dispatched?.data).toMatchObject({
      tier: "mid",
      tier_reason: "role",
      tier_clamped: false,
    });
    await older.h.release();
  });

  it("hands Lookback the trials' enforced read deny: read_denied only when the host enforced it (reading 178)", async () => {
    const { h, fake, reach } = atRetro(["a", "b"], { harness: { readDeny: true } });
    await reach();
    expect(fake.finished[0]?.outcomes).toEqual([
      { n: 0, passed: false, tokens: 150, readDenied: true },
      { n: 1, passed: true, tokens: 150, readDenied: true },
    ]);
    await h.release();
  });

  it("a trial whose run cannot prove its arm plugin loaded is gate_infra, never a verdict: plugin_locked, and its replay waits", async () => {
    const { h, fake, trials, reach } = atRetro(["a", "b"], {
      harness: {
        pluginLoad: () => ({
          loaded: false,
          reason: "a managed-settings lock kept the installed plugin",
        }),
      },
    });
    await reach();
    expect(trials.runs).toHaveLength(1);
    expect(fake.graded).toEqual([]);
    expect(fake.finished).toEqual([]);
    const log = retroEvents(h);
    expect(
      String(
        log.find((e) => e.type === "incident.recorded" && e.data.kind === "gate_infra")?.data
          .detail,
      ),
    ).toMatch(/did not run its arm's own plugin \(the arm plugin did not load: a managed-settings/);
    expect(log.find((e) => e.type === "automation.skipped")?.data).toMatchObject({
      reason: "plugin_locked",
      kind: "lookback",
    });
    expect(h.engine.notices.join("\n")).toMatch(
      /replay trial 0-0 of run .* measured nothing \(gate_infra: the arm plugin did not load/,
    );
    expect(existsSync(trials.runs[0]?.request.pluginDir ?? "")).toBe(false);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a run with no load proof at all measured nothing too", async () => {
    const { h, fake, reach } = atRetro(["a"], { harness: { pluginLoad: null } });
    await reach();
    expect(fake.graded).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /measured nothing \(gate_infra: the host adapter cannot prove which plugin copy the run loaded\)/,
    );
    await h.release();
  });

  it("without an arm plugin compiler a Claude trial cannot run its arm: the replay waits for the next RETRO", async () => {
    const { h, fake, trials, reach } = atRetro(["a", "b"], { noArms: true });
    await reach();
    expect(trials.runs).toEqual([]);
    expect(fake.finished).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /proposal p-1 waits for the next RETRO: a claude-code trial runs its arm's own compiled plugin, and no arm plugin compiler is wired/,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("an arm plugin whose prompt is not the arm's version is refused: the trial is not run", async () => {
    const compiled: ArmPluginRequest[] = [];
    const { h, fake, trials, reach } = atRetro(["a"], {
      harness: { armPlugins: armCompiler(compiled, () => "0".repeat(64)) },
    });
    await reach();
    expect(compiled).toHaveLength(1);
    expect(existsSync(compiled[0]?.outDir ?? "")).toBe(false);
    expect(trials.runs).toEqual([]);
    expect(fake.graded).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /measured nothing \(it was not run: .*an arm plugin whose agent prompt is not the version's/,
    );
    await h.release();
  });

  it("a trial that ends without a result did not pass, and the next one runs", async () => {
    const { h, fake, trials, reach } = atRetro(["a", "b"]);
    // the first trial reports another role's result: rejected, so it did not pass
    trials.set((t, n) =>
      n === 0 ? { result: { role: "qa", exit: "done" } } : { work: t.text === CANDIDATE },
    );
    await reach();
    expect(fake.graded).toHaveLength(1);
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false, true]);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a trial that changes its checkout's git directory did not pass: no engine git ran there, and it is an incident", async () => {
    const { h, fake, trials, reach } = atRetro(["a"]);
    const planted = join(h.home, "PWNED");
    trials.set(() => ({
      work: true,
      // the role plants a clean filter that the engine's own `git add` would run
      also: (cwd) => {
        git(cwd, "config", "filter.x.clean", `touch ${planted}; cat`);
        writeFile(cwd, ".gitattributes", "src/** filter=x\n");
      },
    }));
    await reach();
    expect(existsSync(planted)).toBe(false);
    expect(fake.graded).toEqual([]);
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false]);
    const incident = events(h).find(
      (e) => e.type === "incident.recorded" && e.data.kind === "checkout_write",
    );
    expect(String(incident?.data.detail)).toMatch(
      /replay trial .* changed the git directory of its checkout \(config\)/,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  // D-ch (reading 202): the verdict grader scores a verdict role's trial against the recorded
  // outcome; without one wired, a verdict role is not replayed.
  it("does not replay a verdict role while no verdict grader is wired", async () => {
    const { h, fake, trials, reach } = atRetro(["a", "b"], { role: "spec_verifier" });
    await reach("spec_verifier");
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    expect(trials.runs).toEqual([]);
    expect(fake.finished).toEqual([]);
    expect(retroEvents(h).filter((e) => e.type === "role.dispatched")).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /proposal p-1 waits for the next RETRO: vtc-spec-verifier is graded by its verdict, and no verdict grader is wired \(spine §5 reading 202\)/,
    );
    await h.release();
  });

  it("replays a verdict role through the verdict grader: its verdict, not a gate run, is scored", async () => {
    const scored: { arm: string; task: string; verdicts: RoleResult["verdicts"] }[] = [];
    const { h, fake, trials, reach } = atRetro(["a", "b"], {
      role: "spec_verifier",
      gradeVerdict: (trial, result) => {
        scored.push({ arm: trial.arm, task: trial.task, verdicts: result.verdicts });
        return Promise.resolve(trial.arm === "b" ? "pass" : "fail");
      },
    });
    trials.set((t) => ({
      result: {
        exit: "done",
        verdicts: [
          {
            subject: String(t.dispatched?.data.subject),
            verdict: "pass",
            evidence: [{ type: "file_line", ref: `${IMPL}:1` }],
          },
        ],
      },
    }));
    await reach("spec_verifier");
    expect(trials.runs).toHaveLength(2);
    expect(fake.graded).toEqual([]);
    expect(scored.map((s) => [s.arm, s.task, s.verdicts[0]?.verdict])).toEqual([
      ["a", "r-old:T-1", "pass"],
      ["b", "r-old:T-1", "pass"],
    ]);
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false, true]);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("the daemon's verdict grader (D-ch) scores a Spec Verifier trial against the recorded outcome of the dispatch it replays, and the replay finishes", async () => {
    const held: { h?: Harness } = {};
    const real = createLookbackReplays({
      history: () => held.h?.engine.states().flatMap((s) => s.events) ?? [],
    } as unknown as ReplayWiringDeps).gradeVerdict;
    const {
      h: harness,
      fake,
      trials,
      reach,
    } = atRetro(["a", "b"], {
      role: "spec_verifier",
      gradeVerdict: real,
    });
    held.h = harness;
    // arm a judges the criterion failed, arm b passed: the recorded outcome (the gates passed
    // on the head the replayed dispatch judged) says pass
    trials.set((t) => ({
      result: {
        exit: "done",
        verdicts: [
          {
            subject: String(t.dispatched?.data.subject),
            verdict: t.text === CANDIDATE ? "pass" : "fail",
            evidence: [{ type: "file_line", ref: `${IMPL}:1` }],
          },
        ],
      },
    }));
    await reach("spec_verifier");
    expect(trials.runs).toHaveLength(2);
    expect(fake.graded).toEqual([]);
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false, true]);
    expect(events(harness).filter((e) => e.type === "lookback.replay_finished")).toHaveLength(1);
    expect(harness.engine.notices.join("\n")).not.toMatch(/no verdict grader is wired/);
    await harness.release();
  });

  it("a host_web role's trial gets its host's web search only where that is safe (D-cf): on a host like Codex, whose web search is not confirmed safe, it runs without", async () => {
    const hostWebOfTrials = async (safeHostWeb: boolean): Promise<(boolean | undefined)[]> => {
      const { h, trials, reach } = atRetro(["a", "b"], {
        role: "research_analyst",
        harness: { capabilities: { safeHostWeb } },
      });
      trials.set(() => ({ work: true }));
      await reach();
      const ran = trials.runs.filter((t) => t.request.role === "research_analyst");
      expect(ran.length).toBeGreaterThan(0);
      // each trial's sandbox profile was asked for with the tools it runs with
      const cwds = new Set(ran.map((t) => t.cwd));
      const asked = h.sandboxRequests.filter((r) => cwds.has(r.cwd)).map((r) => r.tools.host_web);
      expect(asked).toHaveLength(ran.length);
      await h.release();
      return asked;
    };
    expect(new Set(await hostWebOfTrials(false))).toEqual(new Set([false]));
    expect(new Set(await hostWebOfTrials(true))).toEqual(new Set([true]));
  });

  it("a trial whose arm cannot run as planned is not run, never with the compiled default in its place: it measured nothing, and its replay waits for the next RETRO", async () => {
    // the candidate was stored against another locked core than the agent compiled now
    const stale = { ...version(CANDIDATE), locked_sha256: "f".repeat(64) };
    const { h, fake, trials, reach } = atRetro(["a", "b"], {
      versionOf: (arm) => (arm === "b" ? stale : version(BASELINE)),
    });
    trials.set(() => ({ work: true }));
    await reach();
    const ran = events(h).filter(
      (e) => e.type === "role.dispatched" && e.role === ROLE && e.task === undefined,
    );
    expect(ran.map((e) => e.prompt_sha)).toEqual([effectivePromptSha(LOCKED, BASELINE)]);
    expect(fake.graded).toHaveLength(1);
    // not counted as the candidate's failure: no result, the proposal stays pending
    expect(fake.finished).toEqual([]);
    expect(events(h).filter((e) => e.type === "lookback.replay_finished")).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /replay trial 0-1 of run .* measured nothing \(it was not run: its arm's prompt version .* cannot run as planned \(the selected prompt version was not used \(a version of another locked core.*the replay of proposal p-1 waits for the next RETRO/,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a trial the dispatcher refuses measured nothing: its replay waits for the next RETRO, and nothing is asked of the human", async () => {
    const { h, fake, trials, reach, context } = atRetro(["a", "b"]);
    trials.set((t, n) => {
      const delivered = context();
      // while the first trial runs, the second is refused (as a dispatcher refusal would)
      if (n === 0 && delivered !== undefined)
        refuseInSession(h.engine, runHandle(h), candidateStep(delivered), "the host refused it");
      return { work: t.text === CANDIDATE };
    });
    await reach();
    expect(fake.graded).toHaveLength(1);
    expect(fake.finished).toEqual([]);
    expect(h.engine.escalations({}).escalations).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /replay trial 0-1 of run .* measured nothing \(it was not run: the host refused it\)/,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("checks the weekly window and budget before every trial: once they run out the replay waits for the next RETRO with automation.skipped, and the run finishes", async () => {
    let window = "";
    const { h, fake, trials, reach } = atRetro(["a", "b"], {
      replayWait: () => (window === "" ? null : window),
    });
    trials.set((t) => {
      // the window runs out while the first trial runs
      window = "20% of the weekly window of claude-code (the run's Lead host) is left";
      return { work: t.text === CANDIDATE };
    });
    await reach();
    expect(fake.graded).toHaveLength(1);
    // not written: the proposal stays pending for the next RETRO
    expect(fake.finished).toEqual([]);
    expect(events(h).filter((e) => e.type === "lookback.replay_finished")).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /the lookback replays of run .* stop and wait for the next RETRO: 20% of the weekly window of claude-code/,
    );
    expect(retroEvents(h).find((e) => e.type === "automation.skipped")?.data).toMatchObject({
      reason: "weekly_window",
      kind: "lookback",
    });
    expect(events(h).some((e) => e.type === "run.paused")).toBe(false);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("tells a weekly-window wait from a budget wait for automation.skipped", () => {
    expect(replayWaitSkipReason("20% of the weekly window of codex is left")).toBe("weekly_window");
    expect(replayWaitSkipReason("the run spent $5.00 of its $5.00 budget")).toBe("budget");
    expect(replayWaitSkipReason("the run has no budget left for replay trials")).toBe("budget");
  });

  it("caps the trials one RETRO runs (LOOKBACK_LIMITS.maxTrialsPerRetro): a replay past the cap waits with automation.skipped trial_cap", async () => {
    const per = Math.floor(LOOKBACK_LIMITS.maxTrialsPerRetro / 2) + 1;
    const { h, fake, trials, reach } = atRetro(["a", "b"], { perArm: per });
    await reach();
    expect(trials.runs).toEqual([]);
    expect(fake.finished).toEqual([]);
    expect(retroEvents(h).find((e) => e.type === "automation.skipped")?.data).toMatchObject({
      reason: "trial_cap",
      kind: "lookback",
    });
    expect(h.engine.notices.join("\n")).toMatch(
      new RegExp(
        `the per-RETRO cap of ${String(LOOKBACK_LIMITS.maxTrialsPerRetro)} trials is reached`,
      ),
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a headless trial whose preflight fails pauses nothing: the replay waits for the next RETRO, and the run finishes", async () => {
    let checks = 0;
    const { h, fake, reach } = atRetro(["a", "b"], {
      harness: {
        // signed in for the first trial, then not
        authStatus: () => {
          checks += 1;
          return Promise.resolve({
            host: "claude-code",
            logged_in: checks === 1,
            method: checks === 1 ? "claude.ai" : null,
            checked_at: "2026-10-13T09:00:00.000Z",
          });
        },
      },
    });
    await reach();
    const log = events(h);
    expect(log.filter((e) => e.type === "headless.preflight").at(-1)?.data).toMatchObject({
      ok: false,
      failed: "auth",
    });
    expect(log.find((e) => e.type === "incident.recorded" && e.data.kind === "auth")).toBeDefined();
    expect(log.some((e) => e.type === "run.paused")).toBe(false);
    expect(fake.graded).toHaveLength(1);
    expect(fake.finished).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /stop and wait for the next RETRO: a headless trial of engineer could not start \(auth\)/,
    );
    // a failed sign-in is no limit: no automation.skipped
    expect(retroEvents(h).filter((e) => e.type === "automation.skipped")).toEqual([]);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a trial whose checkout cannot be made measured nothing; the next trial, which gets its action id, is graded as itself", async () => {
    const { h, fake, trials, reach } = atRetro(["a", "b"], { brokenFirst: true });
    await reach();
    expect(trials.runs).toHaveLength(2);
    expect(retroEvents(h).filter((e) => e.type === "role.dispatched")).toHaveLength(2);
    // each grade is its own trial's: the baseline changed nothing, the candidate wrote the work
    expect(fake.graded.map((r) => r.base === r.head)).toEqual([true, false]);
    expect(fake.finished.map((f) => f.replay.proposal)).toEqual(["p-1"]);
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false, true]);
    expect(events(h).filter((e) => e.type === "incident.recorded")).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /replay trial 0-0 of run .* measured nothing \(no checkout at ffffffffffff: .*the replay of proposal p-0 waits for the next RETRO/s,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("grades a trial as its recorded round was: QA's tests protected at the base, the recorded run's hidden tests copied in, so a candidate that edits a protected test fails", async () => {
    const tests = "tests/acceptance/t-1.test.ts";
    const { h, fake, trials, reach } = atRetro(["a", "b"], { protectedPaths: [tests] });
    trials.set((t) => ({
      work: true,
      // the candidate does the work and weakens QA's test
      also: (cwd) => {
        if (t.text === CANDIDATE) writeFile(cwd, tests, "test.skip('gone', () => {});\n");
      },
    }));
    await reach();
    const atBase = readFileSync(join(worktreeOf(h, "T-1"), tests), "utf8");
    expect(fake.graded).toHaveLength(2);
    for (const request of fake.graded) {
      expect(request.protected).toContainEqual({ path: tests, sha256: sha256Hex(atBase) });
      expect(request.include_hidden).toBe(true);
      // the recorded dispatch's run, not the RETRO run's task (D-ck, reading 205)
      expect(request.hidden_tasks).toEqual(["r-old:T-1"]);
    }
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([true, false]);
    await h.release();
  });

  it("a gate run that reports infra_error measured nothing: the replay waits for the next RETRO instead of counting a failure", async () => {
    const { h, fake, trials, reach } = atRetro(["a", "b"], { infraGrades: [0] });
    trials.set(() => ({ work: true }));
    await reach();
    // the replay is set aside: its second trial is not run
    expect(trials.runs).toHaveLength(1);
    expect(fake.graded).toHaveLength(1);
    expect(fake.finished).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /replay trial 0-0 of run .* measured nothing \(its gate run reported infra_error\)/,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a restart while a trial runs: vtc resume supersedes the trial, which measured nothing, and the replay waits for the next RETRO", async () => {
    const { h, fake, trials, reach } = atRetro(["a", "b"]);
    const adapter = h.deps.adapters["claude-code"];
    if (adapter === undefined) throw new Error("no adapter");
    const spawnRole = adapter.spawnRole.bind(adapter);
    // the first trial does not end before the engine stops
    let release: (outcome: HostOutcome) => void = () => undefined;
    const stuck = new Promise<HostOutcome>((resolve) => {
      release = resolve;
    });
    Object.assign(adapter, {
      spawnRole: async (request: SpawnRoleRequest) => {
        const spawned = await spawnRole(request);
        if (spawned.dispatch !== "headless") return spawned;
        return {
          ...spawned,
          run: {
            ...spawned.run,
            wait: () => stuck,
            kill: () => {
              release({
                kind: "error",
                message: "killed",
                retryable: true,
                cause: "killed",
                tokens: null,
                cost_usd: null,
              });
              return Promise.resolve();
            },
          },
        };
      },
    });
    const reached = reach().catch(() => undefined);
    await vi.waitFor(
      () => {
        expect(trials.runs).toHaveLength(1);
      },
      { timeout: 30_000, interval: 20 },
    );
    await h.engine.shutdown();
    await reached;
    Object.assign(adapter, { spawnRole });
    const engine = h.reopen();
    engine.setLookbackRetro(fake.retro);
    await engine.resume({});
    await engine.settle();
    await engine.next({}, CLAUDE);
    await engine.settle();
    expect(fake.finished).toEqual([]);
    expect(engine.notices.join("\n")).toMatch(
      /replay trial 0-0 of run .* measured nothing \(its role run was stopped\)/,
    );
    expect(engine.status({}).run.finished_at).toBeDefined();
    await engine.shutdown();
    await h.release();
  });

  it("a replay whose result cannot be written is told, and the run still finishes (the proposal stays pending)", async () => {
    const { h, fake, trials, reach } = atRetro(["a"], { finishFails: true });
    trials.set(() => ({ work: true }));
    await reach();
    expect(fake.graded).toHaveLength(1);
    expect(events(h).filter((e) => e.type === "lookback.replay_finished")).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /the replay of proposal p-1 could not be written: the disk is full/,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a replay that cannot start waits: the run finishes, nothing is graded, and the limit is an automation.skipped", async () => {
    const h = createHarness({ project: { merge_level: 1 }, plugins: switched });
    const retro: LookbackRetro = {
      plan: () => Promise.resolve({ targets: [] }),
      check: () => Promise.resolve({ ok: true, events: [] }),
      replays: () =>
        Promise.resolve({
          replays: [],
          wait: "10% of the weekly window of the run's Lead host is left",
          waitKind: "weekly_window",
        }),
      gradeTrial: () => Promise.reject(new Error("never")),
      finishReplay: () => Promise.reject(new Error("never")),
    };
    h.engine.setLookbackRetro(retro);
    await toRetro(h, () => undefined);
    await h.engine.settle();
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    expect(h.engine.notices.join("\n")).toMatch(
      /wait for the next RETRO: 10% of the weekly window/,
    );
    expect(retroEvents(h).find((e) => e.type === "automation.skipped")?.data).toMatchObject({
      reason: "weekly_window",
    });
    await h.release();
  });
});
