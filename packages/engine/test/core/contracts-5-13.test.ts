/**
 * Contracts 5.13.0 on the engine side (spine §5 readings 267, 268), from the owner's Codex runs:
 * a Codex Lead's consult runs the advisor headless and relays its answer, and `cancel` ends a run
 * started by mistake so the repo can start another.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostOutcome, RoleResultInput, SpawnRoleRequest } from "@vtc/shared";
import type { CallContext } from "../../src/core/index.js";
import { cleanupDirs } from "../helpers/repo.js";
import { CLAUDE, createHarness, inSession, type Harness } from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const CODEX: CallContext = { host: "codex" };

const start = (h: Harness, call: CallContext) =>
  h.engine.start(
    {
      request: "TV page keeps loading\n\nThe first song never starts on the projector.",
      track: "quick_fix",
      repo: "existing",
      has_ui: true,
      risk_hints: [],
    },
    call,
  );

const done = (output: Partial<RoleResultInput>, cost = 0.1): HostOutcome => ({
  kind: "done",
  session_ref: null,
  output: { summary: "done", ...output },
  model: "gpt-6.1-sol",
  tokens: { in: 100, out: 50, cache_r: 0, cache_w: 0 },
  cost_usd: cost,
});

/** The advisor answers; every other role keeps working until the engine stops it. */
const advisorAnswers =
  (cost = 0.1) =>
  (request: SpawnRoleRequest): HostOutcome | Promise<HostOutcome> =>
    request.role.startsWith("advisor_")
      ? done(
          {
            role: request.role,
            exit: "done",
            summary: "Most likely the realtime listener re-renders the player on every tick.",
          },
          cost,
        )
      : new Promise<HostOutcome>(() => undefined);

const events = (h: Harness, run: string): { type: string; actor: string; data: unknown }[] =>
  readFileSync(join(h.repo, `.vtc/runs/${run}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; actor: string; data: unknown });

const ask = (h: Harness, call: CallContext, question = "Why does /tv keep loading?") =>
  h.engine.consult({ advisor: "advisor_estimator", question, inputs: [] }, call);

describe(
  "consult on a Codex Lead runs the advisor headless (reading 267)",
  { timeout: 30_000 },
  () => {
    it("launches the advisor on the Lead's host and relays its answer in the next notices", async () => {
      const h = createHarness({ codex: { headless: advisorAnswers() } });
      const { run } = await start(h, CODEX);
      const out = await ask(h, CODEX);
      expect(out).toMatchObject({ run, launched: { host: "codex" } });
      expect("action" in out).toBe(false);
      const launched = h.launched.find((l) => l.request.role === "advisor_estimator");
      expect(launched?.request).toMatchObject({ dispatch: "headless", role: "advisor_estimator" });
      expect(launched?.request.prompt).toContain("The human asks: Why does /tv keep loading?");
      await h.engine.settle();
      const action = "launched" in out ? out.launched.action_id : "";
      const notices = (await h.engine.next({}, CODEX)).notices ?? [];
      expect(notices).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^Advisor advisor_estimator \\(${action}\\) answered \\(exit done; full result in \\.vtc/state/results/${action}\\.json\\): Most likely the realtime listener`,
            ),
          ),
        ]),
      );
      // relayed once
      expect((await h.engine.next({}, CODEX)).notices ?? []).not.toEqual(
        expect.arrayContaining([expect.stringContaining("Advisor advisor_estimator")]),
      );
      // the phase flow is untouched: no escalation, the run still specifies
      expect(events(h, run).some((e) => e.type === "escalation.opened")).toBe(false);
      // the Cartographer the Lead's next launched works until stopped
      await h.engine.pause({});
      await h.release();
    });

    it("still refuses once the run's advisor budget is spent", async () => {
      const h = createHarness({
        project: { budgets: { advisor_usd: 0.15 } },
        codex: { headless: advisorAnswers(0.2) },
      });
      await start(h, CODEX);
      await ask(h, CODEX);
      await h.engine.settle();
      await expect(ask(h, CODEX, "Again?")).rejects.toThrow(
        /advisor budget is spent \(\$0\.20 of \$0\.15/,
      );
      await h.release();
    });

    it("throws why when the advisor cannot run headless here, and parks nothing", async () => {
      const h = createHarness({ platform: "linux", codex: { headless: advisorAnswers() } });
      const { run } = await start(h, CODEX);
      await expect(ask(h, CODEX)).rejects.toMatchObject({ code: "conflict" });
      await expect(ask(h, CODEX)).rejects.toThrow(
        /^advisor_estimator could not start as a headless codex run/,
      );
      expect(h.launched.some((l) => l.request.role === "advisor_estimator")).toBe(false);
      expect(events(h, run).some((e) => e.type === "escalation.opened")).toBe(false);
      await h.release();
    });

    it("a Claude Lead still gets the spawn_role to run in its session", async () => {
      const h = createHarness({ codex: { headless: advisorAnswers() } });
      await start(h, CLAUDE);
      const { action } = inSession(await ask(h, CLAUDE));
      expect(action).toMatchObject({ type: "spawn_role", role: "advisor_estimator" });
      expect(h.launched.some((l) => l.request.role === "advisor_estimator")).toBe(false);
      await h.release();
    });
  },
);

describe("cancel ends a run (reading 268)", { timeout: 30_000 }, () => {
  it("finishes the run as aborted, stops its headless runs and frees the repo", async () => {
    const h = createHarness({ codex: { headless: advisorAnswers() } });
    const { run } = await start(h, CODEX);
    await h.engine.next({}, CODEX);
    expect(h.launched.length).toBeGreaterThan(0);
    const out = await h.engine.cancel({}, CODEX);
    expect(out).toMatchObject({ run, stopped_runs: 1, closed_escalations: 0, worktrees_left: [] });
    await h.engine.settle();
    expect(h.killed.length).toBe(1);
    expect(events(h, run).findLast((e) => e.type === "run.finished")).toMatchObject({
      actor: "human",
      data: { outcome: "aborted" },
    });
    await expect(h.engine.cancel({ run }, CODEX)).rejects.toMatchObject({ code: "finished" });
    // the repo is free: a new run starts
    const second = await start(h, CODEX);
    expect(second.run).not.toBe(run);
    await h.release();
  });

  it("is human-only: a role session and a bare cli connection are refused", async () => {
    const h = createHarness();
    await start(h, CLAUDE);
    const lead: CallContext = { host: "claude-code", session: "S-lead", client: "bridge" };
    await h.engine.next({}, lead);
    const role: CallContext = { host: "claude-code", session: "S-role", client: "bridge" };
    await expect(h.engine.cancel({}, role)).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.engine.cancel({}, { host: null, client: "cli" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(h.engine.status({}).run.finished_at).toBeUndefined();
    // the Lead session, relaying the human, may
    expect((await h.engine.cancel({}, lead)).run).toBe(h.engine.status({}).run.id);
    await h.release();
  });
});
