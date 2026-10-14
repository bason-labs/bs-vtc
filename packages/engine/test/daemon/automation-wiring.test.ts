/**
 * Automation as the daemon wires it (AD-27 rules 7 and 8; D-bv, D-bz, D-ca): engine facts reach
 * the upstream module when the settings allow, otherwise an `automation.skipped` says why; `vtc
 * pause` stops automation; the module's only sink records `upstream.*` and `automation.skipped`
 * events (into the next run's log when none is open); the Lead relays a daily summary once per UTC
 * day; without `EngineDeps.automation` nothing is evaluated.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  scorecardPath,
  type AutomationDeps,
  type Scorecard,
  type StartInput,
  type VtcEvent,
} from "@vtc/shared";
import type {
  AutomationFact,
  CreateUpstream,
  Engine,
  EventDraft,
  UpstreamWiringDeps,
} from "../../src/core/index.js";
import { isGitHubRemote, wireAutomation } from "../../src/daemon/automation.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { CLAUDE, createHarness, type Harness } from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

const AUTOMATION: AutomationDeps = {
  upstream: { repo: "bason-labs/bs-vtc", share: true },
  hosting: "branch",
  ffmpeg: false,
};

const REQUEST: StartInput = {
  request: "Password reset\n\nUsers reset passwords.",
  track: "feature",
  repo: "existing",
  has_ui: false,
  risk_hints: [],
};

interface Line {
  type: string;
  run: string;
  data: Record<string, unknown>;
}
const eventsOf = (h: Harness, run: string): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${run}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

/** A fake upstream module: records the facts and the deps it was built with. */
const fakeUpstream = () => {
  const facts: AutomationFact[] = [];
  let deps: UpstreamWiringDeps | undefined;
  const create: CreateUpstream = (d) => {
    deps = d;
    return {
      onFact: (fact) => {
        facts.push(fact);
        return Promise.resolve();
      },
    };
  };
  return {
    facts,
    create,
    deps: () => {
      if (deps === undefined) throw new Error("not built");
      return deps;
    },
  };
};

const started = async (h: Harness): Promise<string> => (await h.engine.start(REQUEST, CLAUDE)).run;

/** An engine stand-in whose runs a test opens, finishes and pauses at will. */
const fakeEngine = () => {
  const runs = new Map<string, { finished: boolean; paused: boolean }>();
  const recorded: { run: string; type: string; data: unknown }[] = [];
  let listener: ((event: VtcEvent) => void) | undefined;
  const engine = {
    guardDir: tempDir("vtc-guard-"),
    states: () =>
      [...runs.entries()].map(([id, r]) => ({
        id,
        run: {
          ...(r.finished ? { finished_at: "2026-10-13T09:00:00.000Z" } : {}),
          paused: r.paused,
        },
        events: [],
      })),
    config: () => ({}),
    recordModuleEvent: (run: string, draft: EventDraft): boolean => {
      const r = runs.get(run);
      if (r === undefined || r.finished) return false;
      recorded.push({ run, type: draft.type, data: draft.data });
      return true;
    },
    onEvent: (fn: (event: VtcEvent) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    relay: () => undefined,
    notice: () => undefined,
  } as unknown as Engine;
  return {
    engine,
    runs,
    recorded,
    started: (run: string) => {
      listener?.({ type: "run.started", run } as VtcEvent);
    },
  };
};

const OPENED = {
  type: "upstream.issue_opened",
  actor: "engine" as const,
  data: {
    target: { kind: "upstream", repo: "bason-labs/bs-vtc" },
    kind: "defect",
    fingerprint: "0123456789abcdef",
    number: 7,
    url: "https://github.com/bason-labs/bs-vtc/issues/7",
  },
};

describe("automation wiring (AD-27 rules 7 and 8)", () => {
  it("tells a GitHub push remote", () => {
    expect(isGitHubRemote("https://github.com/acme/app.git")).toBe(true);
    expect(isGitHubRemote("git@github.com:acme/app.git")).toBe(true);
    expect(isGitHubRemote("ssh://git@github.com/acme/app.git")).toBe(true);
    expect(isGitHubRemote("https://gitlab.com/acme/app.git")).toBe(false);
    expect(isGitHubRemote("/tmp/remote.git")).toBe(false);
    expect(isGitHubRemote(null)).toBe(false);
  });

  it("hands each engine fact to the upstream module when the settings allow it", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: up.create },
    );
    const run = await started(h);
    h.engine.recordModuleEvent(run, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind: "gate_infra", detail: "the scanner could not start" },
    });
    await wiring.idle();
    expect(up.facts).toEqual([
      expect.objectContaining({
        target: "upstream",
        kind: "defect",
        errorClass: "incident.gate_infra",
        run,
        source: "incident.recorded",
      }),
    ]);
    expect(wiring.settings()).toMatchObject({ issues: true, prs: true, upstream: true });
    expect(up.deps().settings().upstreamRepo).toBe("bason-labs/bs-vtc");
    await wiring.close();
    await h.release();
  });

  it("vtc pause stops automation: a fact while the run is paused is an automation.skipped (paused)", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: up.create },
    );
    const run = await started(h);
    await h.engine.pause({});
    expect(wiring.settings()).toMatchObject({ issues: false, prs: false, upstream: false });
    expect(wiring.settings()?.notes).toContain("automation is paused (vtc pause)");
    h.engine.recordModuleEvent(run, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind: "crash", detail: "a job failed" },
    });
    await wiring.idle();
    expect(up.facts).toEqual([]);
    expect(eventsOf(h, run).find((e) => e.type === "automation.skipped")?.data).toMatchObject({
      reason: "paused",
      kind: "defect",
    });
    await wiring.close();
    await h.release();
  });

  it("without a GitHub remote a project fact is skipped with no_github_remote; an upstream one still goes", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: false, createUpstream: up.create },
    );
    const run = await started(h);
    h.engine.recordModuleEvent(run, {
      type: "feature.reverted",
      actor: "engine",
      feature: "F-1",
      data: { merge_commit: "a".repeat(40), detail: "reverted on main" },
    });
    h.engine.recordModuleEvent(run, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind: "gate_infra", detail: "no sandbox" },
    });
    await wiring.idle();
    expect(up.facts.map((f) => f.kind)).toEqual(["defect"]);
    expect(eventsOf(h, run).find((e) => e.type === "automation.skipped")?.data).toMatchObject({
      reason: "no_github_remote",
      kind: "escaped_defect",
    });
    await wiring.close();
    await h.release();
  });

  it("without EngineDeps.automation nothing is evaluated and the settings are null", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, now: () => h.clock },
      { githubRemote: true, createUpstream: up.create },
    );
    const run = await started(h);
    h.engine.recordModuleEvent(run, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind: "gate_infra", detail: "x" },
    });
    await wiring.idle();
    expect(up.facts).toEqual([]);
    expect(wiring.settings()).toBeNull();
    expect(eventsOf(h, run).some((e) => e.type === "automation.skipped")).toBe(false);
    await wiring.close();
    await h.release();
  });

  it("the module's sink records upstream.* and automation.skipped only, into the next run's log when none is open", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: up.create },
    );
    const { emit } = up.deps();
    expect(() => {
      emit({ type: "run.paused", actor: "engine", data: { reason: "x" } });
    }).toThrow(/only upstream\.\* and automation\.skipped/);
    expect(() => {
      emit({ type: "upstream.issue_opened", actor: "engine", data: { number: 1 } });
    }).toThrow(/invalid upstream\.issue_opened/);
    // no run is open: kept for the next one
    const opened = {
      type: "upstream.issue_opened",
      actor: "engine" as const,
      data: {
        target: { kind: "upstream", repo: "bason-labs/bs-vtc" },
        kind: "defect",
        fingerprint: "0123456789abcdef",
        number: 7,
        url: "https://github.com/bason-labs/bs-vtc/issues/7",
      },
    };
    emit(opened);
    const run = await started(h);
    await wiring.idle();
    expect(eventsOf(h, run).find((e) => e.type === "upstream.issue_opened")?.data).toEqual(
      opened.data,
    );
    // and while it is open, straight into its log
    emit({ ...opened, data: { ...opened.data, number: 8 } }, run);
    expect(
      eventsOf(h, run)
        .filter((e) => e.type === "upstream.issue_opened")
        .map((e) => e.data.number),
    ).toEqual([7, 8]);
    await wiring.close();
    await h.release();
  });

  it("an event for a finished run is never written into another run's log: the next run records it, and a flush keeps what it could not record", async () => {
    const fake = fakeEngine();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      fake.engine,
      { repoRoot: tempDir(), vtcHome: tempDir(), automation: AUTOMATION },
      { githubRemote: true, createUpstream: up.create },
    );
    fake.runs.set("R-1", { finished: true, paused: false });
    fake.runs.set("R-2", { finished: false, paused: false });
    // R-1 finished: not into R-2, the open run
    up.deps().emit(OPENED, "R-1");
    expect(fake.recorded).toEqual([]);
    // the next run to start finished before the flush: the line stays
    fake.runs.set("R-3", { finished: true, paused: false });
    fake.started("R-3");
    await wiring.idle();
    expect(fake.recorded).toEqual([]);
    fake.runs.set("R-4", { finished: false, paused: false });
    fake.started("R-4");
    await wiring.idle();
    expect(fake.recorded).toEqual([{ run: "R-4", type: OPENED.type, data: OPENED.data }]);
    // flushed once: a later run records nothing more
    fake.runs.set("R-5", { finished: false, paused: false });
    fake.started("R-5");
    await wiring.idle();
    expect(fake.recorded).toHaveLength(1);
    await wiring.close();
  });

  it("the module starts an automatic run from an issue", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: up.create },
    );
    const issue = {
      kind: "ci_failure" as const,
      fingerprint: "0123456789abcdef",
      target: { kind: "project" as const, repo: "acme/app" },
      issue: 42,
    };
    await up.deps().startRun(REQUEST, issue);
    const run = h.engine.status({}).run.id;
    expect(eventsOf(h, run).find((e) => e.type === "run.started")?.data.automation).toEqual(issue);
    await wiring.close();
    await h.release();
  });

  it("relays a daily summary to the Lead once per UTC day (NextResult.notices)", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: up.create },
    );
    const run = await started(h);
    h.advance(60_000);
    up.deps().emit(
      {
        type: "upstream.pr_opened",
        actor: "engine",
        data: {
          target: { kind: "project", repo: "acme/app" },
          kind: "ci_failure",
          fingerprint: "0123456789abcdef",
          number: 12,
          url: "https://github.com/acme/app/pull/12",
          branch: "vtc/auto/ci_failure/01234567",
          evidence: "complete",
        },
      },
      run,
    );
    await wiring.idle();
    // the same day: nothing yet
    expect((await h.engine.next({}, CLAUDE)).notices).toBeUndefined();
    // the next UTC day: one summary, with the PR's link
    h.advance(24 * 60 * 60_000);
    h.engine.recordModuleEvent(run, {
      type: "run.paused",
      actor: "engine",
      data: { reason: "a reason" },
    });
    await wiring.idle();
    const notices = (await h.engine.next({}, CLAUDE)).notices ?? [];
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(
      /^Automation on 2026-10-13 \(UTC\): 0 issue\(s\) and 1 draft PR\(s\) opened/,
    );
    expect(notices[0]).toContain("https://github.com/acme/app/pull/12");
    expect((await h.engine.next({}, CLAUDE)).notices).toBeUndefined();
    await wiring.close();
    await h.release();
  });

  it("after Lookback rewrites the scorecards, hands over each new cost regression once", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: up.create },
    );
    const run = await started(h);
    const card = (effective: string, from: string, tokens: number): Scorecard => ({
      v: 1,
      prompt: {
        role: "engineer",
        host: "claude-code",
        locked_sha256: "1".repeat(64),
        editable_sha256: effective,
        effective_sha256: effective,
      },
      grader_bundle_sha: "9".repeat(64),
      window: { from, to: "2026-10-12T00:00:00.000Z" },
      metrics: { tokens_per_success: { value: tokens, ci_low: null, ci_high: null, n: 20 } },
      breakdown: [],
      written_at: "2026-10-12T00:00:00.000Z",
    });
    const cards = [
      card("a".repeat(64), "2026-10-01T00:00:00.000Z", 10000),
      card("b".repeat(64), "2026-10-05T00:00:00.000Z", 15000),
    ];
    const index = {
      v: 1,
      scorecards: cards.map((c) => ({
        prompt: c.prompt,
        path: scorecardPath(c.prompt.role, c.prompt.host, c.prompt.effective_sha256),
        written_at: c.written_at,
      })),
    };
    for (const [c, entry] of cards.map((c, i) => [c, index.scorecards[i]] as const)) {
      const file = join(h.repo, entry?.path ?? "");
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(c));
    }
    writeFileSync(join(h.repo, ".vtc/lookback/scorecards/index.json"), JSON.stringify(index));
    wiring.scorecardsWritten(run);
    await wiring.idle();
    expect(up.facts).toEqual([
      expect.objectContaining({
        target: "upstream",
        kind: "cost",
        run,
        role: "engineer",
        metric: "tokens_per_success",
        baseline: 10000,
        current: 15000,
        baselinePromptSha: "a".repeat(64),
        promptSha: "b".repeat(64),
      }),
    ]);
    // the same pair of versions is not handed over again at the next run's end
    wiring.scorecardsWritten(run);
    await wiring.idle();
    expect(up.facts).toHaveLength(1);
    await wiring.close();
    await h.release();
  });

  it("never sweeps while a run is paused", async () => {
    const fake = fakeEngine();
    fake.runs.set("R-1", { finished: false, paused: true });
    let sweeps = 0;
    const create: CreateUpstream = () => ({
      onFact: () => Promise.resolve(),
      sweep: () => {
        sweeps += 1;
        return Promise.resolve();
      },
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const wiring = wireAutomation(
        fake.engine,
        { repoRoot: tempDir(), vtcHome: tempDir(), automation: AUTOMATION },
        { githubRemote: true, createUpstream: create, sweepEveryMs: 1000 },
      );
      await wiring.idle();
      vi.advanceTimersByTime(3000);
      await wiring.idle();
      expect(sweeps).toBe(0);
      // resumed: the next tick sweeps
      fake.runs.set("R-1", { finished: false, paused: false });
      vi.advanceTimersByTime(1000);
      await wiring.idle();
      expect(sweeps).toBe(1);
      await wiring.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries the module's sweep when it starts (the module paces it)", async () => {
    const h = createHarness();
    let sweeps = 0;
    const create: CreateUpstream = () => ({
      onFact: () => Promise.resolve(),
      sweep: () => {
        sweeps += 1;
        return Promise.resolve();
      },
    });
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: create },
    );
    await wiring.idle();
    expect(sweeps).toBe(1);
    await wiring.close();
    await h.release();
  });
});
