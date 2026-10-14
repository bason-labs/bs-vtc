/**
 * Lookback replays at RETRO (spec §13 step 3; AD-21 rule 6; spine §5 reading 176): once every
 * lookback target is settled, RETRO runs the trials of the replays the wired Lookback returns, one
 * at a time, each in a clean checkout at the recorded base with the arm's prompt first in the
 * recorded pack; each accepted trial is graded through the Gate Runner, a trial that ends without
 * a result did not pass, and the replay's result is written before the run finishes. Nothing a
 * trial does touches a task.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectivePromptSha,
  sha256Hex,
  TASK_PACK_HEURISTICS_SECTION,
  TaskPackSchema,
  type GateRunRequest,
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
} from "../../src/core/index.js";
import { refuseInSession } from "../../src/core/dispatch.js";
import { cleanupDirs, git } from "../helpers/repo.js";
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
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 40_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  role?: string;
  task?: string;
  prompt_sha?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

const LOCKED = "You are the Spec Verifier.";
const BASELINE = "Judge each criterion against the cited evidence.";
const CANDIDATE = "Cite the test output line, or say unknown.";

/** Every agent takes its editable section from the pack (reading 117). */
const switched: PluginCatalog = {
  ...createPluginCatalog({}),
  promptParts: () => ({
    lockedSha256: sha256Hex(LOCKED),
    editableInPack: true,
    compiled: { locked: LOCKED, editable: BASELINE },
  }),
};

const version = (editable: string): PromptVersionRef => ({
  role: "spec_verifier",
  host: "claude-code",
  locked_sha256: sha256Hex(LOCKED),
  editable_sha256: sha256Hex(editable),
  effective_sha256: effectivePromptSha(LOCKED, editable),
});

interface Delivered {
  /** The Spec Verifier's recorded pack. */
  readonly pack: TaskPack;
  /** The head it judged. */
  readonly base: string;
}

/**
 * One task delivered at Level 1 (the release starts RETRO): `seen` gets the Spec Verifier's pack
 * and the head it judged before RETRO plans its replays.
 */
const toRetro = async (
  h: Harness,
  seen: (d: Delivered) => void,
): Promise<Delivered & { readonly pending: SpawnAction[] }> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
  const verifier = only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");
  const pack = TaskPackSchema.parse(
    JSON.parse(readFileSync(join(h.repo, verifier.pack.replace(/\.md$/, ".json")), "utf8")),
  );
  const built = events(h).findLast((e) => e.type === "role.submitted" && e.role === "engineer");
  const delivered = { pack, base: String(built?.data.head) };
  seen(delivered);
  await verdictPass(h, verifier, "src/t-1/impl.ts");
  await h.engine.settle();
  const after = spawns(await passFinalReview(h));
  await h.engine.settle();
  return {
    ...delivered,
    pending: [...after, ...spawns((await h.engine.next({}, CLAUDE)).actions)],
  };
};

/** The trial handed out: among the spawns already returned, else on the Lead's next call. */
const nextTrial = async (h: Harness, carried: readonly SpawnAction[]): Promise<SpawnAction> =>
  carried.find((a) => a.role === "spec_verifier") ??
  only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");

/** A Lookback fake with no lookback target and one replay of `trials` arms. */
const fakeReplays = (
  arms: readonly ("a" | "b")[],
  context: () => Delivered,
  role = "spec_verifier",
) => {
  const graded: GateRunRequest[] = [];
  const finished: { replay: LookbackReplay; outcomes: readonly ReplayTrialOutcome[] }[] = [];
  const retro: LookbackRetro = {
    plan: () => Promise.resolve({ targets: [] }),
    check: () => Promise.resolve({ ok: true, events: [] }),
    replays: () => {
      const { pack, base } = context();
      return Promise.resolve({
        replays: [
          {
            proposal: "p-1",
            role,
            host: "claude-code",
            trials: arms.map((arm, i) => ({
              arm,
              trial: i + 1,
              task: "r-old:T-1",
              regressionSet: false,
              role,
              host: "claude-code" as const,
              prompt: {
                version: { ...version(arm === "b" ? CANDIDATE : BASELINE), role },
                text: arm === "b" ? CANDIDATE : BASELINE,
              },
              pack,
              base,
            })),
          },
        ],
      });
    },
    // the candidate's trials pass, the baseline's fail
    gradeTrial: (request) => {
      graded.push(request);
      return Promise.resolve(graded.length % 2 === 0);
    },
    finishReplay: (replay, outcomes) => {
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
  return { retro, graded, finished };
};

describe("RETRO runs Lookback replays (AD-21 rule 6, reading 176)", () => {
  it("runs each trial in a clean checkout with its arm's prompt, grades it, writes the result, then finishes", async () => {
    const h = createHarness({ project: { merge_level: 1 }, plugins: switched });
    let context: Delivered | undefined;
    const fake = fakeReplays(["a", "b"], () => {
      if (context === undefined) throw new Error("not at RETRO yet");
      return context;
    });
    h.engine.setLookbackRetro(fake.retro);
    const delivered = await toRetro(h, (d) => {
      context = d;
    });
    const taskBefore = h.engine.status({}).tasks_by_status;
    const run = h.engine.status({}).run;
    expect(run).toMatchObject({ phase: "retro" });
    expect(run.finished_at).toBeUndefined();

    let carried: SpawnAction[] = delivered.pending;
    for (const [i, text] of [BASELINE, CANDIDATE].entries()) {
      const trial = await nextTrial(h, carried);
      expect(trial.task).toBeUndefined();
      expect(trial.subject).toBe(delivered.pack.subject);
      const cwd = workdir(trial);
      expect(cwd).toBe(join(h.repo, ".vtc/state/worktrees", `R-${run.id}-${trial.action_id}`));
      // the clean checkout is at the recorded base, with no refs of the user's repo
      expect(git(cwd, "rev-parse", "HEAD")).toBe(delivered.base);
      expect(git(cwd, "for-each-ref")).toBe("");
      const pack = readFileSync(join(h.repo, trial.pack), "utf8");
      expect(pack.startsWith(`## ${TASK_PACK_HEURISTICS_SECTION}\n\n${text}\n`)).toBe(true);
      const dispatched = events(h).findLast((e) => e.type === "role.dispatched");
      expect(dispatched?.prompt_sha).toBe(effectivePromptSha(LOCKED, text));
      expect(dispatched?.task).toBeUndefined();
      const out = await submitResult(h, trial, {
        exit: "done",
        verdicts: [
          {
            subject: trial.subject ?? "",
            verdict: "pass",
            evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
          },
        ],
      });
      carried = "actions" in out ? spawns(out.actions) : [];
      await h.engine.settle();
      expect(fake.graded).toHaveLength(i + 1);
      // graded in the trial's checkout, against the recorded base, then removed
      expect(fake.graded[i]).toMatchObject({
        base: delivered.base,
        head: delivered.base,
        checkout: `.vtc/state/worktrees/R-${run.id}-${trial.action_id}`,
      });
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
    // no task changed
    expect(h.engine.status({}).tasks_by_status).toEqual(taskBefore);
    await h.release();
  });

  it("a trial that ends without a result did not pass, and the next one runs", async () => {
    const h = createHarness({ project: { merge_level: 1 }, plugins: switched });
    let context: Delivered | undefined;
    const fake = fakeReplays(["a", "b"], () => {
      if (context === undefined) throw new Error("not at RETRO yet");
      return context;
    });
    h.engine.setLookbackRetro(fake.retro);
    const { pending } = await toRetro(h, (d) => {
      context = d;
    });
    // the first trial returns no verdict: rejected, so it did not pass
    const first = await nextTrial(h, pending);
    const out = await submitResult(h, first, { exit: "done", verdicts: [] });
    await h.engine.settle();
    const second = await nextTrial(h, "actions" in out ? spawns(out.actions) : []);
    await submitResult(h, second, {
      exit: "done",
      verdicts: [
        {
          subject: second.subject ?? "",
          verdict: "pass",
          evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
        },
      ],
    });
    await h.engine.settle();
    expect(fake.graded).toHaveLength(1);
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false, false]);
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
    const h = createHarness({ project: { merge_level: 1 }, plugins: own });
    let context: Delivered | undefined;
    const fake = fakeReplays(["a", "b"], () => {
      if (context === undefined) throw new Error("not at RETRO yet");
      return context;
    });
    h.engine.setLookbackRetro(fake.retro);
    await toRetro(h, (d) => {
      context = d;
    });
    await h.engine.settle();
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    expect(fake.graded).toEqual([]);
    expect(fake.finished).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /proposal p-1 waits for the next RETRO: vtc-spec-verifier cannot run a candidate: it carries its own editable section/,
    );
    await h.release();
  });

  it("a trial the dispatcher refuses did not pass; nothing is asked of the human", async () => {
    const h = createHarness({ project: { merge_level: 1 }, plugins: switched });
    let context: Delivered | undefined;
    const fake = fakeReplays(["a", "b"], () => {
      if (context === undefined) throw new Error("not at RETRO yet");
      return context;
    });
    h.engine.setLookbackRetro(fake.retro);
    const { pending } = await toRetro(h, (d) => {
      context = d;
    });
    const first = await nextTrial(h, pending);
    const state = h.engine.states().find((s) => s.run.finished_at === undefined);
    if (state === undefined || context === undefined) throw new Error("no run at RETRO");
    // the second trial cannot run in the Lead's session (D-an): it did not pass, no escalation
    refuseInSession(
      h.engine,
      { state } as unknown as RunHandle,
      {
        key: "retro:replay:0-1",
        role: "spec_verifier",
        replay: {
          replay: 0,
          n: 1,
          prompt: { version: version(CANDIDATE), text: CANDIDATE },
          pack: context.pack,
          base: context.base,
        },
      },
      "the Lead session's sandbox is off",
    );
    await submitResult(h, first, {
      exit: "done",
      verdicts: [
        {
          subject: first.subject ?? "",
          verdict: "pass",
          evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
        },
      ],
    });
    await h.engine.settle();
    await h.engine.next({}, CLAUDE);
    await h.engine.settle();
    expect(fake.graded).toHaveLength(1);
    expect(fake.finished[0]?.outcomes.map((o) => o.passed)).toEqual([false, false]);
    expect(h.engine.escalations({}).escalations).toEqual([]);
    expect(h.engine.notices.join("\n")).toMatch(
      /replay trial 0-1 of run .* was not run: the Lead session's sandbox is off/,
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
