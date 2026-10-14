/**
 * Lookback replays at RETRO (spec §13 step 3; AD-21 rule 6; spine §5 reading 176): once every
 * lookback target is settled, RETRO runs the trials of the replays the wired Lookback returns, one
 * at a time, each in a clean checkout at the recorded base with the arm's prompt first in the
 * recorded pack; each accepted trial is graded through the Gate Runner with its head readable in
 * the user's repo, a trial that ends without a result did not pass, and the replay's result is
 * written before the run finishes. A trial whose arm cannot run as planned is not run; a verdict
 * role is not replayed; the weekly window and budget are checked before every trial, and a replay
 * that has to stop waits for the next RETRO without pausing the delivered run. Nothing a trial
 * does touches a task.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectivePromptSha,
  sha256Hex,
  TASK_PACK_HEURISTICS_SECTION,
  TaskPackSchema,
  type GateRunRequest,
  type GitChangedFile,
  type PromptVersionRef,
  type TaskPack,
} from "@vtc/shared";
import {
  createPluginCatalog,
  type EventDraft,
  type LookbackReplay,
  type LookbackRetro,
  type PluginCatalog,
  type ReplayTrialOutcome,
  type RunHandle,
  type RunState,
} from "../../src/core/index.js";
import { refuseInSession, type StepSpec } from "../../src/core/dispatch.js";
import { launchHeadless } from "../../src/core/headless.js";
import type { Kernel } from "../../src/core/kernel.js";
import { createGitOps } from "../../src/git/index.js";
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
  submitResult,
  throughPlan,
  verdictPass,
  workdir,
  worktreeOf,
  type Harness,
  type HarnessOptions,
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
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

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

const version = (editable: string, role = ROLE): PromptVersionRef => ({
  role,
  host: "claude-code",
  locked_sha256: sha256Hex(LOCKED),
  editable_sha256: sha256Hex(editable),
  effective_sha256: effectivePromptSha(LOCKED, editable),
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

/**
 * One task delivered at Level 1 (the release starts RETRO): `seen` gets the recorded dispatch of
 * `role` (the Engineer's pack and the commit it started from, or the Spec Verifier's and the head
 * it judged) before RETRO plans its replays.
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
  const after = spawns(await passFinalReview(h));
  await h.engine.settle();
  return {
    ...delivered,
    pending: [...after, ...spawns((await h.engine.next({}, CLAUDE)).actions)],
  };
};

/** The trial handed out: among the spawns already returned, else on the Lead's next call. */
const nextTrial = async (
  h: Harness,
  carried: readonly SpawnAction[],
): Promise<SpawnAction | undefined> =>
  carried.find((a) => a.role === ROLE) ??
  spawns((await h.engine.next({}, CLAUDE)).actions).find((a) => a.role === ROLE);

/** Runs a trial: with `work`, it writes the implementation in its checkout first. */
const runTrial = async (h: Harness, trial: SpawnAction, work: boolean): Promise<SpawnAction[]> => {
  if (work) writeFile(workdir(trial), IMPL, "export const x = 2;\n");
  const out = await submitResult(h, trial, { exit: "built" });
  await h.engine.settle();
  return "actions" in out ? spawns(out.actions) : [];
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
      const trialOf = (arm: "a" | "b", i: number, at: string) => ({
        arm,
        trial: i + 1,
        task: "r-old:T-1",
        regressionSet: false,
        role,
        host: "claude-code" as const,
        prompt: {
          version: options.versionOf?.(arm) ?? version(arm === "b" ? CANDIDATE : BASELINE, role),
          text: arm === "b" ? CANDIDATE : BASELINE,
        },
        pack,
        base: at,
        ...(options.protectedPaths === undefined ? {} : { protectedPaths: options.protectedPaths }),
      });
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
            host: "claude-code",
            trials: arms.map((arm, i) => trialOf(arm, i, base)),
          },
        ],
      });
    },
    ...(options.replayWait === undefined ? {} : { replayWait: options.replayWait }),
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
  options: FakeOptions & { readonly harness?: HarnessOptions } = {},
) => {
  const h = createHarness({
    project: { merge_level: 1 },
    plugins: switched,
    ...options.harness,
  });
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
    reach: (role?: "engineer" | "spec_verifier") =>
      toRetro(
        h,
        (d) => {
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

describe("RETRO runs Lookback replays (AD-21 rule 6, reading 176)", () => {
  it("runs each trial in a clean checkout outside the user's repo with its arm's prompt, grades its head in a clean verification checkout, writes the result, then finishes", async () => {
    const { h, fake, reach } = atRetro(["a", "b"]);
    const delivered = await reach();
    const taskBefore = h.engine.status({}).tasks_by_status;
    const run = h.engine.status({}).run;
    expect(run).toMatchObject({ phase: "retro" });
    expect(run.finished_at).toBeUndefined();
    const refs = git(h.repo, "for-each-ref", "--format=%(refname)");

    let carried: SpawnAction[] = delivered.pending;
    for (const [i, text] of [BASELINE, CANDIDATE].entries()) {
      const trial = await nextTrial(h, carried);
      if (trial === undefined) throw new Error(`trial ${String(i)} was not handed out`);
      expect(trial.task).toBeUndefined();
      const cwd = workdir(trial);
      // a fresh private directory under the OS temp directory: no relative path reaches the repo
      expect(relative(realpathSync(tmpdir()), cwd).startsWith("..")).toBe(false);
      expect(relative(realpathSync(h.repo), cwd).startsWith("..")).toBe(true);
      expect(readFileSync(join(cwd, ".git"), "utf8")).not.toContain(h.repo);
      // the clean checkout is at the recorded base, with no refs of the user's repo
      expect(git(cwd, "rev-parse", "HEAD")).toBe(delivered.base);
      expect(git(cwd, "for-each-ref")).toBe("");
      expect(existsSync(join(cwd, IMPL))).toBe(false);
      const pack = readFileSync(join(h.repo, trial.pack), "utf8");
      expect(pack.startsWith(`## ${TASK_PACK_HEURISTICS_SECTION}\n\n${text}\n`)).toBe(true);
      const dispatched = events(h).findLast((e) => e.type === "role.dispatched");
      expect(dispatched?.prompt_sha).toBe(effectivePromptSha(LOCKED, text));
      expect(dispatched?.task).toBeUndefined();
      // the baseline's trial does nothing; the candidate's writes the implementation, and
      // leaves an ignored stub behind that a gate run in its tree would pick up
      if (text === CANDIDATE) {
        writeFile(cwd, ".gitignore", ".vtc/state/\nnode_modules/\n");
        writeFile(cwd, LEFTOVER, "module.exports = () => 0;\n");
      }
      carried = await runTrial(h, trial, text === CANDIDATE);
      expect(fake.graded).toHaveLength(i + 1);
      const request = fake.graded[i];
      // graded in a clean verification checkout of the head, never in the trial's tree
      expect(request?.base).toBe(delivered.base);
      expect(request?.checkout).toMatch(/^\.vtc\/state\/checkouts\//);
      expect(existsSync(join(h.repo, request?.checkout ?? "missing"))).toBe(false);
      expect(fake.held[i]).toEqual({ impl: text === CANDIDATE, leftover: false });
      if (text === CANDIDATE) {
        // the head committed in the trial's private git directory, readable in the user's repo
        expect(request?.head).not.toBe(delivered.base);
        expect(fake.changes).toEqual([
          [
            { path: ".gitignore", status: "modified" },
            { path: IMPL, status: "added" },
          ],
        ]);
      } else expect(request?.head).toBe(delivered.base);
      expect(existsSync(cwd)).toBe(false);
    }
    await h.engine.settle();
    expect(fake.finished).toHaveLength(1);
    expect(fake.finished[0]?.outcomes).toEqual([
      { n: 0, passed: false, tokens: 150 },
      { n: 1, passed: true, tokens: 150 },
    ]);
    const log = events(h);
    expect(log.filter((e) => e.type === "lookback.replay_finished")).toHaveLength(1);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    // no task changed, and the user's repo got no ref
    expect(h.engine.status({}).tasks_by_status).toEqual(taskBefore);
    expect(git(h.repo, "for-each-ref", "--format=%(refname)")).toBe(refs);
    await h.release();
  });

  it("a trial that ends without a result did not pass, and the next one runs", async () => {
    const { h, fake, reach } = atRetro(["a", "b"]);
    const { pending } = await reach();
    // the first trial reports another role's result: rejected, so it did not pass
    const first = await nextTrial(h, pending);
    if (first === undefined) throw new Error("no trial");
    const out = await submitResult(h, first, { role: "qa", exit: "done" });
    await h.engine.settle();
    const second = await nextTrial(h, "actions" in out ? spawns(out.actions) : []);
    if (second === undefined) throw new Error("no second trial");
    await runTrial(h, second, true);
    expect(fake.graded).toHaveLength(1);
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false, true]);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a trial that changes its checkout's git directory did not pass: no engine git ran there, and it is an incident", async () => {
    const { h, fake, reach } = atRetro(["a"]);
    const { pending } = await reach();
    const trial = await nextTrial(h, pending);
    if (trial === undefined) throw new Error("no trial");
    // the role plants a clean filter that the engine's own `git add` would run
    const planted = join(h.home, "PWNED");
    git(workdir(trial), "config", "filter.x.clean", `touch ${planted}; cat`);
    writeFile(workdir(trial), ".gitattributes", "src/** filter=x\n");
    await runTrial(h, trial, true);
    await h.engine.next({}, CLAUDE);
    await h.engine.settle();
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

  it("replays only a target that can take a pin: the others wait, and the run finishes (AD-21 rule 6)", async () => {
    const own: PluginCatalog = {
      ...switched,
      promptParts: () => ({
        lockedSha256: sha256Hex(LOCKED),
        editableInPack: false,
        compiled: { locked: LOCKED, editable: BASELINE },
      }),
    };
    const { h, fake, reach } = atRetro(["a", "b"], { harness: { plugins: own } });
    await reach();
    await h.engine.settle();
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    expect(fake.graded).toEqual([]);
    expect(fake.finished).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /proposal p-1 waits for the next RETRO: vtc-engineer cannot run a candidate: it carries its own editable section/,
    );
    await h.release();
  });

  it("does not replay a verdict role: the gates would grade the same base for both arms", async () => {
    const { h, fake, reach } = atRetro(["a", "b"], { role: "spec_verifier" });
    await reach("spec_verifier");
    await h.engine.settle();
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    expect(fake.graded).toEqual([]);
    expect(fake.finished).toEqual([]);
    // no trial was dispatched: nothing ran at RETRO
    const log = events(h);
    const retro = log.findIndex((e) => e.type === "run.phase_changed" && e.data.to === "retro");
    expect(retro).toBeGreaterThan(0);
    expect(log.slice(retro).filter((e) => e.type === "role.dispatched")).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /proposal p-1 waits for the next RETRO: vtc-spec-verifier changes no file, so the gates would grade the same base for both arms/,
    );
    await h.release();
  });

  it("a trial whose arm cannot run as planned is not run, never with the compiled default in its place: it measured nothing, and its replay waits for the next RETRO", async () => {
    // the candidate was stored against another locked core than the agent compiled now
    const stale = { ...version(CANDIDATE), locked_sha256: "f".repeat(64) };
    const { h, fake, reach } = atRetro(["a", "b"], {
      versionOf: (arm) => (arm === "b" ? stale : version(BASELINE)),
    });
    const { pending } = await reach();
    const first = await nextTrial(h, pending);
    if (first === undefined) throw new Error("no trial");
    const carried = await runTrial(h, first, true);
    expect(await nextTrial(h, carried)).toBeUndefined();
    await h.engine.settle();
    await h.engine.next({}, CLAUDE);
    await h.engine.settle();
    const trials = events(h).filter(
      (e) => e.type === "role.dispatched" && e.role === ROLE && e.task === undefined,
    );
    expect(trials.map((e) => e.prompt_sha)).toEqual([effectivePromptSha(LOCKED, BASELINE)]);
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
    const { h, fake, reach, context } = atRetro(["a", "b"]);
    const { pending } = await reach();
    const first = await nextTrial(h, pending);
    const delivered = context();
    if (first === undefined || delivered === undefined) throw new Error("no run at RETRO");
    // the second trial cannot run in the Lead's session (D-an): it did not pass, no escalation
    refuseInSession(
      h.engine,
      runHandle(h),
      candidateStep(delivered),
      "the Lead session's sandbox is off",
    );
    await runTrial(h, first, true);
    await h.engine.next({}, CLAUDE);
    await h.engine.settle();
    expect(fake.graded).toHaveLength(1);
    expect(fake.finished).toEqual([]);
    expect(h.engine.escalations({}).escalations).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /replay trial 0-1 of run .* measured nothing \(it was not run: the Lead session's sandbox is off\)/,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("checks the weekly window and budget before every trial: once they run out the replay waits for the next RETRO, and the run finishes", async () => {
    let window = "";
    const { h, fake, reach } = atRetro(["a", "b"], {
      replayWait: () => (window === "" ? null : window),
    });
    const { pending } = await reach();
    const first = await nextTrial(h, pending);
    if (first === undefined) throw new Error("no trial");
    // the window runs out while the first trial runs
    window = "20% of the weekly window of claude-code (the run's Lead host) is left";
    const carried = await runTrial(h, first, true);
    expect(await nextTrial(h, carried)).toBeUndefined();
    await h.engine.settle();
    expect(fake.graded).toHaveLength(1);
    // not written: the proposal stays pending for the next RETRO
    expect(fake.finished).toEqual([]);
    expect(events(h).filter((e) => e.type === "lookback.replay_finished")).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /the lookback replays of run .* stop and wait for the next RETRO: 20% of the weekly window of claude-code/,
    );
    expect(events(h).some((e) => e.type === "run.paused")).toBe(false);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a headless trial whose preflight fails pauses nothing: the replay waits for the next RETRO, and the run finishes", async () => {
    const { h, fake, reach, context } = atRetro(["a", "b"], {
      harness: {
        authStatus: () =>
          Promise.resolve({
            host: "claude-code",
            logged_in: false,
            method: null,
            checked_at: "2026-10-13T09:00:00.000Z",
          }),
      },
    });
    const { pending } = await reach();
    const first = await nextTrial(h, pending);
    const delivered = context();
    if (first === undefined || delivered === undefined) throw new Error("no run at RETRO");
    await runTrial(h, first, true);
    // the next trial goes headless (as on a Codex Lead), and the host is not signed in
    const handle = runHandle(h);
    const kernel = h.engine as unknown as Kernel;
    expect(
      await kernel.serial(handle, () =>
        launchHeadless(kernel, handle, candidateStep(delivered), "claude-code", "lookback_replay"),
      ),
    ).toBe(false);
    await h.engine.next({}, CLAUDE);
    await h.engine.settle();
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
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a trial whose checkout cannot be made measured nothing; the next trial, which gets its action id, is graded as itself", async () => {
    const { h, fake, reach } = atRetro(["a", "b"], { brokenFirst: true });
    const { pending } = await reach();
    const retroAt = events(h).findIndex(
      (e) => e.type === "run.phase_changed" && e.data.to === "retro",
    );
    // p-0's trial has no base to check out: it never got its role run
    let carried: SpawnAction[] = pending;
    for (const work of [false, true]) {
      const trial = await nextTrial(h, carried);
      if (trial === undefined) throw new Error("no trial");
      carried = await runTrial(h, trial, work);
    }
    await h.engine.next({}, CLAUDE);
    await h.engine.settle();
    const dispatched = events(h)
      .slice(retroAt)
      .filter((e) => e.type === "role.dispatched");
    expect(dispatched).toHaveLength(2);
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

  it("grades a trial as its recorded round was: QA's tests protected at the base, the task's hidden tests copied in, so a candidate that edits a protected test fails", async () => {
    const tests = "tests/acceptance/t-1.test.ts";
    const { h, fake, reach } = atRetro(["a", "b"], { protectedPaths: [tests] });
    const delivered = await reach();
    const baseline = await nextTrial(h, delivered.pending);
    if (baseline === undefined) throw new Error("no trial");
    const carried = await runTrial(h, baseline, true);
    const candidate = await nextTrial(h, carried);
    if (candidate === undefined) throw new Error("no second trial");
    // the candidate does the work and weakens QA's test
    writeFile(workdir(candidate), tests, "test.skip('gone', () => {});\n");
    await runTrial(h, candidate, true);
    await h.engine.next({}, CLAUDE);
    await h.engine.settle();
    const atBase = readFileSync(join(worktreeOf(h, "T-1"), tests), "utf8");
    for (const request of fake.graded) {
      expect(request.protected).toContainEqual({ path: tests, sha256: sha256Hex(atBase) });
      expect(request.include_hidden).toBe(true);
      expect(request.hidden_tasks).toEqual(["T-1"]);
    }
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([true, false]);
    await h.release();
  });

  it("a gate run that reports infra_error measured nothing: the replay waits for the next RETRO instead of counting a failure", async () => {
    const { h, fake, reach } = atRetro(["a", "b"], { infraGrades: [0] });
    const { pending } = await reach();
    const first = await nextTrial(h, pending);
    if (first === undefined) throw new Error("no trial");
    const carried = await runTrial(h, first, true);
    // the replay is set aside: its second trial is not run
    expect(await nextTrial(h, carried)).toBeUndefined();
    await h.engine.settle();
    expect(fake.graded).toHaveLength(1);
    expect(fake.finished).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /replay trial 0-0 of run .* measured nothing \(its gate run reported infra_error\)/,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a restart while a trial runs picks the replay up where it stopped", async () => {
    const { h, fake, reach } = atRetro(["a", "b"]);
    const { pending } = await reach();
    const first = await nextTrial(h, pending);
    if (first === undefined) throw new Error("no trial");
    // the engine restarts while the first trial works in its checkout
    const engine = h.reopen();
    engine.setLookbackRetro(fake.retro);
    const again: Harness = { ...h, engine };
    expect(existsSync(workdir(first))).toBe(true);
    const carried = await runTrial(again, first, false);
    const second = await nextTrial(again, carried);
    if (second === undefined) throw new Error("no second trial after the restart");
    expect(second.action_id).not.toBe(first.action_id);
    await runTrial(again, second, true);
    await engine.next({}, CLAUDE);
    await engine.settle();
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false, true]);
    expect(engine.status({}).run.finished_at).toBeDefined();
    await engine.shutdown();
    await h.release();
  });

  it("a replay whose result cannot be written is told, and the run still finishes (the proposal stays pending)", async () => {
    const { h, fake, reach } = atRetro(["a"], { finishFails: true });
    const { pending } = await reach();
    const trial = await nextTrial(h, pending);
    if (trial === undefined) throw new Error("no trial");
    await runTrial(h, trial, true);
    await h.engine.next({}, CLAUDE);
    await h.engine.settle();
    expect(fake.graded).toHaveLength(1);
    expect(events(h).filter((e) => e.type === "lookback.replay_finished")).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /the replay of proposal p-1 could not be written: the disk is full/,
    );
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    await h.release();
  });

  it("a replay that cannot start waits: the run finishes and nothing is graded", async () => {
    const h = createHarness({ project: { merge_level: 1 }, plugins: switched });
    const retro: LookbackRetro = {
      plan: () => Promise.resolve({ targets: [] }),
      check: () => Promise.resolve({ ok: true, events: [] }),
      replays: () =>
        Promise.resolve({
          replays: [],
          wait: "10% of the weekly window of the run's Lead host is left",
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
    await h.release();
  });
});
