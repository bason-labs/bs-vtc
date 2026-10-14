/**
 * Engine-launched headless runs (spec §6.9, §12; spine AD-17 rules 2 and 5, AD-25; D-ba, H-1):
 * a Codex Lead's role steps run as headless Codex runs without the opt-in; a Claude Code Lead's
 * never do in plugin-only mode; the preflight runs in order before every unattended start or
 * resume; auto-resume with no live Lead needs `headless_allowed`; runs are supervised with the
 * project's policy and show in `status`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_IN_SESSION_REFUSED_REASON,
  HEADLESS_DEFAULTS,
  SubmitInputSchema,
  type HostOutcome,
  type LeadAction,
  type RoleResultInput,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { headlessPreflight } from "../../src/core/headless.js";
import { consecutiveFailures } from "../../src/core/queries.js";
import { MAX_STEP_FAILURES } from "../../src/core/submit.js";
import type { CallContext } from "../../src/core/index.js";
import type { Kernel, RunHandle } from "../../src/core/kernel.js";
import { writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  only,
  spawns,
  type Harness,
  type HeadlessScript,
} from "../helpers/engine-harness.js";

const CODEX: CallContext = { host: "codex" };

interface Line {
  type: string;
  task?: string;
  role?: string;
  host?: string;
  data: Record<string, unknown>;
}

const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const ofType = (h: Harness, type: string): Line[] => events(h).filter((e) => e.type === type);

const start = (h: Harness, call: CallContext) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    call,
  );
const next = async (h: Harness, call: CallContext): Promise<LeadAction[]> =>
  (await h.engine.next({}, call)).actions;

const done = (output: Partial<RoleResultInput>): HostOutcome => ({
  kind: "done",
  session_ref: null,
  output: { summary: "done", ...output },
  model: "gpt-6.1-sol",
  tokens: { in: 100, out: 50, cache_r: 0, cache_w: 0 },
  cost_usd: 0.1,
});

/** The DISCOVER and SPECIFY roles, done well: they write their artifact where they work. */
const frontHalf: HeadlessScript = (request) => {
  if (request.role === "repo_cartographer") {
    writeFile(request.cwd, ".vtc/research/repo-map/map.md", "# map\n");
    return done({
      role: "repo_cartographer",
      exit: "done",
      artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
    });
  }
  writeFile(request.cwd, ".vtc/spec/spec.md", "# Spec\n\n## REQ-1 Reset\n\n- REQ-1.AC-1: x\n");
  return done({
    role: "ba",
    exit: "done",
    artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
  });
};

const signedIn =
  (host: "claude-code" | "codex", logged_in: boolean | null, method: string | null = null) =>
  () =>
    Promise.resolve({ host, logged_in, method, checked_at: "2026-10-13T09:00:00.000Z" });

describe(
  "H-1: a Codex Lead's role steps run as engine-launched headless Codex runs",
  { timeout: 30_000 },
  () => {
    it("launches the step through HostAdapter.spawnRole without headless_allowed, and submits its outcome", async () => {
      const h = createHarness({
        project: { hosts: { headless: { wall_timeout_min: 30, idle_timeout_min: 5 } } },
        codex: { headless: frontHalf, authStatus: signedIn("codex", true) },
      });
      await start(h, CODEX);
      const actions = await next(h, CODEX);
      // no Lead action: the engine runs the step itself
      expect(spawns(actions)).toEqual([]);
      expect(actions).toEqual([expect.objectContaining({ type: "wait" })]);
      expect(h.launched).toHaveLength(1);
      const { request, host, session } = h.launched[0]!;
      expect(host).toBe("codex");
      expect(session).toBeUndefined();
      expect(request).toMatchObject({
        role: "repo_cartographer",
        dispatch: "headless",
        timeoutMs: 30 * 60_000,
        idleTimeoutMs: 5 * 60_000,
      } satisfies Partial<SpawnRoleRequest>);
      expect(request.outputSchema).toMatchObject({ title: "RoleResult" });
      expect(request.outputSchema).not.toHaveProperty("$schema");
      expect(request.sandbox.host).toBe("codex");
      expect(request.prompt).toContain("The engine records it");
      const dispatched = ofType(h, "role.dispatched");
      expect(dispatched).toEqual([
        expect.objectContaining({ role: "repo_cartographer", host: "codex" }),
      ]);
      expect(dispatched[0]?.data.dispatch).toBe("headless");
      expect(ofType(h, "headless.preflight").map((e) => e.data)).toEqual([
        { host: "codex", purpose: "role", ok: true },
      ]);
      expect(ofType(h, "headless.started")[0]).toMatchObject({
        role: "repo_cartographer",
        host: "codex",
        data: { pid: 4242, resume: null, wall_timeout_ms: 1_800_000, idle_timeout_ms: 300_000 },
      });
      await h.engine.settle();
      expect(ofType(h, "headless.ended")[0]).toMatchObject({
        data: { outcome: "done", exit_code: null },
      });
      expect(ofType(h, "role.submitted")).toEqual([
        expect.objectContaining({ role: "repo_cartographer" }),
      ]);
      expect(h.engine.status({}).run.phase).toBe("specify");
      // the Lead's next call launches the BA the same way
      expect(spawns(await next(h, CODEX))).toEqual([]);
      await h.engine.settle();
      expect(h.launched.map((l) => l.request.role)).toEqual(["repo_cartographer", "ba"]);
      await h.release();
    });

    it("uses HEADLESS_DEFAULTS without hosts.headless", async () => {
      const h = createHarness({ codex: { headless: frontHalf } });
      await start(h, CODEX);
      await next(h, CODEX);
      expect(h.launched[0]?.request).toMatchObject({
        timeoutMs: HEADLESS_DEFAULTS.wallTimeoutMin * 60_000,
        idleTimeoutMs: HEADLESS_DEFAULTS.idleTimeoutMin * 60_000,
      });
      await h.release();
    });

    it("a Codex role never runs headless off the platforms whose sandbox blocks the socket", async () => {
      const h = createHarness({ platform: "linux", codex: { headless: frontHalf } });
      await start(h, CODEX);
      expect(await next(h, CODEX)).toEqual([{ type: "ask_human", escalations: ["E-1"] }]);
      expect(h.launched).toEqual([]);
      expect(ofType(h, "escalation.opened")[0]?.data).toMatchObject({
        escalation: { reason: "blocked", detail: CODEX_IN_SESSION_REFUSED_REASON },
      });
      await h.release();
    });

    it("a Codex host that cannot run headless parks the step with the remedy", async () => {
      const h = createHarness({ codex: { capabilities: { headless: false } } });
      await start(h, CODEX);
      expect(await next(h, CODEX)).toEqual([{ type: "ask_human", escalations: ["E-1"] }]);
      expect(ofType(h, "escalation.opened")[0]?.data).toMatchObject({
        escalation: { detail: CODEX_IN_SESSION_REFUSED_REASON },
      });
      expect(h.launched).toEqual([]);
      await h.release();
    });

    it("a final output that is not a RoleResult fails the step instead of being accepted", async () => {
      const h = createHarness({ codex: { headless: () => done({ exit: "nonsense" as never }) } });
      await start(h, CODEX);
      await next(h, CODEX);
      await h.engine.settle();
      const failed = ofType(h, "role.failed");
      expect(failed).toHaveLength(1);
      expect(String(failed[0]?.data.message)).toContain("not a RoleResult");
      expect(ofType(h, "role.submitted")).toEqual([]);
      await h.release();
    });

    it("a run that could not start is a failed step, never a hang", async () => {
      const h = createHarness({
        codex: {
          headless: () => {
            throw new Error("codex: command not found");
          },
        },
      });
      await start(h, CODEX);
      await next(h, CODEX);
      await h.engine.settle();
      expect(ofType(h, "headless.ended").at(-1)?.data).toMatchObject({ outcome: "error" });
      expect(ofType(h, "role.failed")).toHaveLength(1);
      await h.release();
    });
  },
);

describe(
  "AD-17: a Claude Code Lead starts no headless run in plugin-only mode",
  { timeout: 30_000 },
  () => {
    it("hands the step to the Lead as a subagent even though the host could run it headless", async () => {
      const h = createHarness({ headless: frontHalf });
      await start(h, CLAUDE);
      expect(only(await next(h, CLAUDE), "repo_cartographer").type).toBe("spawn_role");
      expect(h.launched).toEqual([]);
      expect(ofType(h, "headless.preflight")).toEqual([]);
      await h.release();
    });

    it("with headless_allowed, a host without subagents runs the steps headless", async () => {
      const h = createHarness({
        project: { hosts: { dispatch: "headless_allowed" } },
        capabilities: { subagents: false, backgroundSubagents: false },
        headless: frontHalf,
      });
      await start(h, CLAUDE);
      expect(spawns(await next(h, CLAUDE))).toEqual([]);
      expect(h.launched.map((l) => [l.host, l.request.role])).toEqual([
        ["claude-code", "repo_cartographer"],
      ]);
      expect(h.launched[0]?.request.sandbox.enforced.secretsUnreadable).toBe(true);
      await h.engine.settle();
      expect(h.engine.status({}).run.phase).toBe("specify");
      await h.release();
    });
  },
);

describe(
  "AD-25 rule 3: the preflight before every unattended start, in order",
  { timeout: 30_000 },
  () => {
    it("a failed sign-in check pauses the run with an incident and never retries in a loop", async () => {
      const h = createHarness({
        codex: { headless: frontHalf, authStatus: signedIn("codex", false) },
      });
      await start(h, CODEX);
      await next(h, CODEX);
      expect(h.launched).toEqual([]);
      expect(ofType(h, "headless.preflight").map((e) => e.data)).toEqual([
        expect.objectContaining({ host: "codex", purpose: "role", ok: false, failed: "auth" }),
      ]);
      expect(ofType(h, "incident.recorded").at(-1)?.data.detail).toContain("not signed in");
      expect(ofType(h, "incident.recorded").at(-1)?.data.kind).toBe("auth");
      expect(h.engine.status({}).run.paused).toBe(true);
      // the run waits for the human: more next calls check nothing and launch nothing
      await next(h, CODEX);
      await next(h, CODEX);
      expect(ofType(h, "headless.preflight")).toHaveLength(1);
      expect(h.launched).toEqual([]);
      await h.release();
    });

    it("a sign-in check that cannot run counts as not signed in", async () => {
      const h = createHarness({
        codex: { headless: frontHalf, authStatus: signedIn("codex", null) },
      });
      await start(h, CODEX);
      await next(h, CODEX);
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({ failed: "auth" });
      expect(h.launched).toEqual([]);
      await h.release();
    });

    it("checks the config before usage and the sign-in", async () => {
      let asked = 0;
      const h = createHarness({
        codex: {
          headless: frontHalf,
          authStatus: () => {
            asked += 1;
            return signedIn("codex", false)();
          },
        },
      });
      await start(h, CODEX);
      writeFile(h.repo, ".vtc/project.yaml", JSON.stringify({ version: 1, concurrency: 1 }));
      await next(h, CODEX);
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({
        ok: false,
        failed: "config",
      });
      expect(asked).toBe(0);
      expect(h.launched).toEqual([]);
      expect(ofType(h, "escalation.opened")[0]?.data).toMatchObject({
        escalation: { reason: "blocked" },
      });
      await h.release();
    });

    it("checks usage before the sign-in: a used-up window waits for the reset", async () => {
      let asked = 0;
      const h = createHarness({
        codex: {
          headless: frontHalf,
          authStatus: () => {
            asked += 1;
            return signedIn("codex", true)();
          },
        },
      });
      await start(h, CODEX);
      const reset = "2026-10-13T11:00:00.000Z";
      h.engine.ingestUsage({
        host: "codex",
        source: "app_server",
        windows: [
          { kind: "five_hour", label: "5h", used_pct: 100, resets_at: reset, window_minutes: 300 },
        ],
        model_limits: [],
        updated_at: "2026-10-13T09:00:00.000Z",
      });
      await next(h, CODEX);
      expect(ofType(h, "headless.preflight").at(-1)?.data).toMatchObject({ failed: "usage" });
      expect(asked).toBe(0);
      expect(h.launched).toEqual([]);
      expect(ofType(h, "limit.hit").at(-1)?.data).toMatchObject({
        host: "codex",
        resets_at: reset,
      });
      expect(h.scheduled.at?.getTime()).toBeGreaterThan(Date.parse(reset));
      // waiting: no further preflight before the reset
      await next(h, CODEX);
      expect(ofType(h, "headless.preflight")).toHaveLength(1);
      await h.release();
    });
  },
);

describe("AD-25 rule 3: the budget check comes last", () => {
  /** The preflight's inputs only: a run whose config matches, a task, the host's sign-in. */
  const preflightOf = (options: {
    readonly loggedIn: boolean;
    readonly spent: number;
    readonly runSpent?: number;
    readonly method?: string;
  }) => {
    const k = {
      diskConfigHash: () => "a".repeat(64),
      usage: new Map(),
      now: () => new Date("2026-10-13T09:00:00.000Z"),
      deps: {
        adapters: {
          codex: { authStatus: signedIn("codex", options.loggedIn, options.method ?? null) },
        },
      },
    } as unknown as Kernel;
    const h = {
      state: {
        run: { paused: false, pipeline_config_hash: "a".repeat(64) },
        tasks: new Map([["T-1", { id: "T-1", spent_usd: options.spent, budget_usd: 5 }]]),
        runBudget:
          options.runSpent === undefined ? null : { budget_usd: 10, spent_usd: options.runSpent },
      },
    } as unknown as RunHandle;
    return headlessPreflight(k, h, { task: "T-1" }, "codex", "auto_resume");
  };

  it("a task that used up its budget fails on budget, after a passing sign-in check", async () => {
    expect(await preflightOf({ loggedIn: true, spent: 5 })).toMatchObject({
      ok: false,
      failed: "budget",
    });
    expect((await preflightOf({ loggedIn: true, spent: 5 })).detail).toContain(
      "$5.00 of its $5.00",
    );
  });

  it("a run that used up its budget fails on budget too", async () => {
    expect(await preflightOf({ loggedIn: true, spent: 1, runSpent: 10 })).toMatchObject({
      failed: "budget",
    });
  });

  it("the sign-in check comes before the budget", async () => {
    expect(await preflightOf({ loggedIn: false, spent: 5 })).toMatchObject({ failed: "auth" });
    expect(await preflightOf({ loggedIn: true, spent: 1 })).toMatchObject({ ok: true });
  });

  it("a login with an API key fails on auth: roles run on the subscription only (reading 141)", async () => {
    const refused = await preflightOf({ loggedIn: true, spent: 1, method: "API key" });
    expect(refused).toMatchObject({ ok: false, failed: "auth" });
    expect(refused.detail).toContain("API key");
    expect(await preflightOf({ loggedIn: true, spent: 1, method: "ChatGPT" })).toMatchObject({
      ok: true,
    });
  });
});

describe("§6.9 auto-resume with no live Lead (AD-17 rule 2)", { timeout: 30_000 }, () => {
  const limitOutcome = (h: Harness, action: string) =>
    h.engine.submit(
      SubmitInputSchema.parse({
        kind: "failure",
        action_id: action,
        outcome: {
          kind: "limit",
          session_ref: { host: "claude-code", id: "sess-1" },
          resets_at: "2026-10-13T10:00:00.000Z",
          window: "five_hour",
          model: null,
          message: "limit",
          tokens: null,
          cost_usd: null,
        },
      }),
      CLAUDE,
    );

  it("with headless_allowed the timer resumes the interrupted step itself, then keeps driving", async () => {
    const h = createHarness({
      project: { hosts: { dispatch: "headless_allowed" } },
      headless: frontHalf,
      authStatus: signedIn("claude-code", true),
    });
    await start(h, CLAUDE);
    const carto = only(await next(h, CLAUDE), "repo_cartographer");
    await limitOutcome(h, carto.action_id);
    h.advance(2 * 3_600_000);
    await h.engine.wake();
    await h.engine.settle();
    expect(ofType(h, "run.resumed").at(-1)?.data).toEqual({ auto: true });
    // a phase step works in a fresh worktree per dispatch, so it starts over (no session resume)
    expect(h.launched[0]).toMatchObject({
      host: "claude-code",
      request: { role: "repo_cartographer" },
    });
    expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({
      purpose: "auto_resume",
      ok: true,
    });
    // the run goes on unattended: the BA ran headless too, without any Lead call
    expect(h.launched.map((l) => l.request.role)).toEqual(["repo_cartographer", "ba"]);
    expect(h.engine.status({}).run.phase).toBe("g1");
    await h.release();
  });

  it("in plugin-only mode the timer launches nothing: the Lead's next call re-dispatches the step", async () => {
    const h = createHarness({ headless: frontHalf });
    await start(h, CLAUDE);
    const carto = only(await next(h, CLAUDE), "repo_cartographer");
    await limitOutcome(h, carto.action_id);
    h.advance(2 * 3_600_000);
    await h.engine.wake();
    await h.engine.settle();
    expect(h.launched).toEqual([]);
    expect(ofType(h, "run.resumed").at(-1)?.data).toEqual({ auto: true });
    const again = only(await next(h, CLAUDE), "repo_cartographer");
    expect(again.action_id).not.toBe(carto.action_id);
    expect(h.launched).toEqual([]);
    await h.release();
  });
});

describe("AD-25 rule 4: supervision, status and the kill switch", { timeout: 30_000 }, () => {
  it("lists the run in status while it runs, and vtc pause kills it", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = createHarness({
      codex: {
        headless: () => {
          started();
          return new Promise<HostOutcome>(() => undefined); // never ends by itself
        },
      },
    });
    await start(h, CODEX);
    await next(h, CODEX);
    await running;
    expect(h.engine.status({}).headless_runs).toEqual([
      {
        action_id: expect.any(String) as string,
        role: "repo_cartographer",
        host: "codex",
        pid: 4242,
        started_at: "2026-10-13T09:00:00.000Z",
      },
    ]);
    await h.engine.pause({});
    await h.engine.settle();
    expect(h.killed).toEqual(["repo_cartographer"]);
    expect(ofType(h, "headless.ended").at(-1)?.data).toMatchObject({
      outcome: "error",
      cause: "killed",
    });
    expect(h.engine.status({}).headless_runs).toBeUndefined();
    await h.release();
  });

  it("a run vtc pause killed is not the role's failure: pause and resume cycles never count toward the stuck limit", async () => {
    let started: () => void = () => undefined;
    let running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = createHarness({
      codex: {
        headless: () => {
          started();
          return new Promise<HostOutcome>(() => undefined); // never ends by itself
        },
      },
    });
    await start(h, CODEX);
    await next(h, CODEX);
    for (let cycle = 1; cycle <= MAX_STEP_FAILURES; cycle += 1) {
      await running;
      running = new Promise<void>((resolve) => {
        started = resolve;
      });
      await h.engine.pause({});
      await h.engine.settle();
      const failed = ofType(h, "role.failed").at(-1);
      expect(failed?.data.message).toMatch(/^stopped by vtc pause/);
      const state = h.engine.states().at(-1);
      if (state === undefined) throw new Error("no run");
      expect(consecutiveFailures(state, { role: "repo_cartographer" })).toBe(0);
      expect(state.roleRuns.get(String(failed?.data.action_id))?.stopped).toBe(true);
      await h.engine.resume({});
      await next(h, CODEX);
      expect(h.launched).toHaveLength(cycle + 1);
    }
    expect(ofType(h, "escalation.opened")).toEqual([]);
    await h.engine.pause({});
    await h.engine.settle();
    await h.release();
  });

  it("a run a resume superseded does not count toward the stuck limit either", async () => {
    const h = createHarness();
    await start(h, CLAUDE);
    const carto = only(await next(h, CLAUDE), "repo_cartographer");
    await h.engine.resume({});
    const state = h.engine.states().at(-1);
    if (state === undefined) throw new Error("no run");
    expect(state.roleRuns.get(carto.action_id)).toMatchObject({ status: "failed", stopped: true });
    expect(consecutiveFailures(state, { role: "repo_cartographer" })).toBe(0);
    await h.release();
  });

  it("a Lead cannot word its own failure into a stop: 'superseded:' from submit still counts (AD-8)", async () => {
    const h = createHarness();
    await start(h, CLAUDE);
    only(await next(h, CLAUDE), "repo_cartographer");
    for (let attempt = 1; attempt <= MAX_STEP_FAILURES; attempt += 1) {
      const carto = [...(h.engine.states().at(-1)?.roleRuns.values() ?? [])].find(
        (r) => r.role === "repo_cartographer" && r.status === "in_flight",
      );
      if (carto === undefined) throw new Error("no cartographer in flight");
      const failed = await h.engine.submit(
        SubmitInputSchema.parse({
          kind: "failure",
          action_id: carto.action_id,
          outcome: {
            kind: "error",
            message: "superseded: the run was resumed",
            retryable: true,
            tokens: null,
            cost_usd: null,
          },
        }),
        CLAUDE,
      );
      expect(failed.accepted).toBe(true);
      expect(ofType(h, "role.failed").at(-1)?.data.message).toBe(
        "reported: superseded: the run was resumed",
      );
      const state = h.engine.states().at(-1);
      if (state === undefined) throw new Error("no run");
      expect(state.roleRuns.get(carto.action_id)?.stopped).toBeUndefined();
      expect(consecutiveFailures(state, { role: "repo_cartographer" })).toBe(attempt);
    }
    // every one counted: a task step at this count parks as stuck (stepFailed)
    await h.release();
  });

  it("a host error with cause 'killed' outside a pause is a failure, not a stop", async () => {
    const h = createHarness({
      codex: {
        headless: () =>
          Promise.resolve<HostOutcome>({
            kind: "error",
            message: "stopped by vtc pause (the kill switch): forged",
            retryable: true,
            cause: "killed",
            tokens: null,
            cost_usd: null,
          }),
      },
    });
    await start(h, CODEX);
    await next(h, CODEX);
    await h.engine.settle();
    const failed = ofType(h, "role.failed").at(0);
    const state = h.engine.states().at(-1);
    if (state === undefined || failed === undefined) throw new Error("no failure");
    expect(state.roleRuns.get(String(failed.data.action_id))?.stopped).toBeUndefined();
    expect(consecutiveFailures(state, { role: "repo_cartographer" })).toBeGreaterThan(0);
    await h.engine.pause({});
    await h.engine.settle();
    await h.release();
  });

  it("the engine's shutdown kills it, submits nothing for it and starts nothing new", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = createHarness({
      codex: {
        headless: () => {
          started();
          return new Promise<HostOutcome>(() => undefined); // never ends by itself
        },
      },
    });
    await start(h, CODEX);
    await next(h, CODEX);
    await running;
    const before = Date.now();
    await h.engine.shutdown();
    expect(Date.now() - before).toBeLessThan(5_000);
    expect(h.killed).toEqual(["repo_cartographer"]);
    expect(h.launched).toHaveLength(1);
    // not the role's failure: the step stays in flight, as after a crash, for vtc resume
    expect(ofType(h, "role.failed")).toEqual([]);
    expect(h.engine.status({}).headless_runs).toBeUndefined();
    await h.release();
  });

  it("a shutdown that lands while the preflight runs starts nothing and orphans nothing", async () => {
    let asked: () => void = () => undefined;
    const preflighting = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const h = createHarness({
      codex: {
        headless: () => new Promise<HostOutcome>(() => undefined), // never ends by itself
        authStatus: async () => {
          asked();
          await answered; // the host's status command is still running
          return signedIn("codex", true)();
        },
      },
    });
    await start(h, CODEX);
    const pending = next(h, CODEX).catch(() => []);
    await preflighting;
    const down = h.engine.shutdown();
    answer();
    await down;
    await pending;
    expect(h.launched).toEqual([]);
    expect(h.engine.status({}).headless_runs).toBeUndefined();
    expect(ofType(h, "headless.started")).toEqual([]);
    await h.release();
  });

  it("a shutdown that lands while the host starts the run kills it", async () => {
    let starting: () => void = () => undefined;
    const spawning = new Promise<void>((resolve) => {
      starting = resolve;
    });
    let go: () => void = () => undefined;
    const proceed = new Promise<void>((resolve) => {
      go = resolve;
    });
    const h = createHarness({
      codex: { headless: () => new Promise<HostOutcome>(() => undefined) },
    });
    const codex = h.deps.adapters.codex;
    if (codex === undefined) throw new Error("no codex adapter");
    const spawnRole = codex.spawnRole.bind(codex);
    codex.spawnRole = async (request) => {
      starting();
      await proceed; // the host is still starting the process
      return spawnRole(request);
    };
    await start(h, CODEX);
    const pending = next(h, CODEX).catch(() => []);
    await spawning;
    const down = h.engine.shutdown();
    go();
    await down;
    await pending;
    expect(h.launched).toHaveLength(1);
    expect(h.killed).toEqual(["repo_cartographer"]);
    expect(h.engine.status({}).headless_runs).toBeUndefined();
    expect(ofType(h, "headless.started")).toEqual([]);
    await h.release();
  });

  it("feeds the stream's usage events to the usage store", async () => {
    const usage = {
      host: "codex",
      source: "sdk_event",
      windows: [
        {
          kind: "five_hour",
          label: "5h",
          used_pct: 42,
          resets_at: "2026-10-13T12:00:00.000Z",
          window_minutes: 300,
        },
      ],
      model_limits: [],
      updated_at: null,
    };
    const h = createHarness({
      codex: {
        headless: (request, session) => {
          const outcome = frontHalf(request, session) as HostOutcome;
          return { outcome, lines: [JSON.stringify({ usage })] };
        },
      },
    });
    await start(h, CODEX);
    await next(h, CODEX);
    await h.engine.settle();
    expect(h.engine.usage.get("codex")?.windows[0]?.used_pct).toBe(42);
    await h.release();
  });
});
