/**
 * Automation as the daemon wires it (AD-27 rules 7 and 8; D-bv, D-bz, D-ca): engine facts reach
 * the upstream module when the settings allow, otherwise an `automation.skipped` says why; `vtc
 * pause` stops automation; the module's only sink records `upstream.*` and `automation.skipped`
 * events (into the next run's log when none is open); the Lead relays a daily summary once per UTC
 * day; without `EngineDeps.automation` nothing is evaluated.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  AutomaticRelease,
  AutomationFact,
  CreateUpstream,
  Engine,
  EventDraft,
  UpstreamWiringDeps,
} from "../../src/core/index.js";
import { isGitHubRemote, wireAutomation } from "../../src/daemon/automation.js";
import { automationPausedByHuman, setAutomationPaused } from "../../src/core/guard.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { CLAUDE, createHarness, type Harness } from "../helpers/engine-harness.js";
import { driveToRelease, ISSUE, REQUEST as AUTO_REQUEST } from "../helpers/automatic-run.js";

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
  const runs = new Map<
    string,
    { finished: boolean; paused: boolean; automation?: { issue: number; target: { repo: string } } }
  >();
  const automatic: { input: StartInput; issue: unknown }[] = [];
  const recorded: { run: string; type: string; data: unknown }[] = [];
  const notices: string[] = [];
  const relayed: string[] = [];
  /** While set, recording an event throws (a full disk, a log the engine refuses). */
  const failRecord = { on: false };
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
        automation: r.automation ?? null,
        findings: new Map(),
        events: [],
      })),
    startAutomatic: (input: StartInput, issue: { issue: number; target: { repo: string } }) => {
      if ([...runs.values()].some((r) => !r.finished))
        return Promise.reject(
          Object.assign(new Error("a run is already active in this repo"), { code: "run_active" }),
        );
      automatic.push({ input, issue });
      runs.set(`R-${String(runs.size + 1)}`, { finished: false, paused: false, automation: issue });
      return Promise.resolve({
        run: `R-${String(runs.size)}`,
        track: input.track,
        phase: "discover",
      });
    },
    config: () => ({}),
    recordModuleEvent: (run: string, draft: EventDraft): boolean => {
      if (failRecord.on) throw new Error("the event log refused the append");
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
    relay: (_run: string | undefined, text: string) => {
      relayed.push(text);
    },
    notice: (text: string) => {
      notices.push(text);
    },
  } as unknown as Engine;
  return {
    engine,
    runs,
    recorded,
    notices,
    relayed,
    automatic,
    failRecord,
    /** An event of `run` reaches the wiring's listener. */
    event: (event: Pick<VtcEvent, "type" | "run" | "data"> & Partial<VtcEvent>) => {
      listener?.({ ts: "2026-10-13T09:00:00.000Z", seq: 1, actor: "engine", ...event } as VtcEvent);
    },
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

  it("asks gh whether it is logged in (D-bz): logged out, automation is off with the note and facts skip as gh_unavailable, until a later probe says it is", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    let loggedIn = false;
    let probes = 0;
    const wiring = wireAutomation(
      h.engine,
      {
        repoRoot: h.repo,
        vtcHome: h.home,
        automation: {
          ...AUTOMATION,
          ghLogin: () => {
            probes += 1;
            return Promise.resolve(loggedIn);
          },
        },
        now: () => h.clock,
      },
      { githubRemote: true, createUpstream: up.create },
    );
    await wiring.idle();
    expect(probes).toBe(1);
    expect(wiring.settings()).toMatchObject({ issues: false, prs: false, upstream: false });
    expect(wiring.settings()?.notes).toContain(
      "automatic issues and PRs are off: gh is not logged in (run gh auth login)",
    );
    const run = await started(h);
    h.engine.recordModuleEvent(run, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind: "crash", detail: "a job failed" },
    });
    await wiring.idle();
    expect(up.facts).toEqual([]);
    expect(eventsOf(h, run).find((e) => e.type === "automation.skipped")?.data).toMatchObject({
      reason: "gh_unavailable",
      kind: "defect",
    });
    // the human runs gh auth login; the next probe (a run's start, or the hourly timer) sees it
    loggedIn = true;
    await wiring.refreshLogin();
    expect(wiring.settings()).toMatchObject({ issues: true, prs: true, upstream: true });
    h.engine.recordModuleEvent(run, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind: "crash", detail: "a job failed again" },
    });
    await wiring.idle();
    expect(up.facts.map((f) => f.kind)).toEqual(["defect"]);
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
    await wiring.idle();
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

  /** Two scorecards of the Engineer: version b's tokens per success 50% over version a's. */
  const writeRegressedCards = (repo: string): void => {
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
      const file = join(repo, entry?.path ?? "");
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(c));
    }
    writeFileSync(join(repo, ".vtc/lookback/scorecards/index.json"), JSON.stringify(index));
  };

  it("a cost regression skipped while automation was paused is raised at the first evaluation after resume (reading 212(8))", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: up.create },
    );
    const run = await started(h);
    writeRegressedCards(h.repo);
    setAutomationPaused(h.engine.guardDir, "2026-10-13T09:00:00.000Z");
    wiring.scorecardsWritten(run);
    await wiring.idle();
    expect(up.facts).toEqual([]);
    expect(eventsOf(h, run).filter((e) => e.type === "automation.skipped")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ reason: "paused", kind: "cost" }) as object,
      }),
    ]);
    setAutomationPaused(h.engine.guardDir, null);
    wiring.scorecardsWritten(run);
    await wiring.idle();
    expect(up.facts).toEqual([
      expect.objectContaining({ kind: "cost", role: "engineer", metric: "tokens_per_success" }),
    ]);
    // handed over once: the next evaluation does not raise it again
    wiring.scorecardsWritten(run);
    await wiring.idle();
    expect(up.facts).toHaveLength(1);
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

  it("hands an automatic run's release to the module once, for its draft PR (AD-27 rules 2 and 6)", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    const releases: AutomaticRelease[] = [];
    const create: CreateUpstream = () => ({
      onFact: () => Promise.resolve(),
      onAutomaticRelease: (release) => {
        releases.push(release);
        return Promise.resolve();
      },
    });
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: create },
    );
    await h.engine.startAutomatic(AUTO_REQUEST, ISSUE, CLAUDE);
    await driveToRelease(h);
    await wiring.idle();
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ automation: ISSUE, feature: "F-1", specVerifier: "pass" });
    await wiring.close();
    await h.release();
  });

  it("a release the module failed on is an engine notice, not a lost error", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    const create: CreateUpstream = () => ({
      onFact: () => Promise.resolve(),
      onAutomaticRelease: () => Promise.reject(new Error("gh exploded")),
    });
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: create },
    );
    await h.engine.startAutomatic(AUTO_REQUEST, ISSUE, CLAUDE);
    await driveToRelease(h);
    await wiring.idle();
    expect(h.engine.notices.join("\n")).toMatch(
      /could not open the PR of run .* \(issue #42\): gh exploded/,
    );
    await wiring.close();
    await h.release();
  });
  it("a job that throws is an engine notice: the queue keeps going and idle never rejects", async () => {
    const fake = fakeEngine();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      fake.engine,
      { repoRoot: tempDir(), vtcHome: tempDir(), automation: AUTOMATION },
      { githubRemote: true, createUpstream: up.create },
    );
    fake.runs.set("R-1", { finished: false, paused: true });
    const crash = { type: "incident.recorded", run: "R-1", data: { kind: "crash", detail: "x" } };
    // paused: the skip's event cannot be recorded
    fake.failRecord.on = true;
    fake.event(crash);
    await expect(wiring.idle()).resolves.toBeUndefined();
    expect(fake.notices.join("\n")).toMatch(/the event log refused the append/);
    // the next fact is still handled
    fake.failRecord.on = false;
    fake.runs.set("R-1", { finished: false, paused: false });
    fake.event(crash);
    await wiring.idle();
    expect(up.facts.map((f) => f.kind)).toEqual(["defect"]);
    await expect(wiring.close()).resolves.toBeUndefined();
  });

  it("a fact the module fails on is an automation.skipped error with the redacted message (contracts 5.4.0)", async () => {
    const fake = fakeEngine();
    const wiring = wireAutomation(
      fake.engine,
      { repoRoot: tempDir(), vtcHome: tempDir(), automation: AUTOMATION },
      {
        githubRemote: true,
        createUpstream: () => ({
          onFact: () =>
            Promise.reject(new Error("gh failed: token ghp_abcdefghijklmnopqrstuvwxyz0123456789")),
        }),
      },
    );
    fake.runs.set("R-1", { finished: false, paused: false });
    fake.event({ type: "incident.recorded", run: "R-1", data: { kind: "crash", detail: "x" } });
    await wiring.idle();
    const skipped = fake.recorded.filter((r) => r.type === "automation.skipped");
    expect(skipped).toEqual([
      {
        run: "R-1",
        type: "automation.skipped",
        data: expect.objectContaining({ reason: "error", kind: "defect" }) as unknown,
      },
    ]);
    const detail = (skipped[0]?.data as { detail: string }).detail;
    expect(detail).toContain("gh failed");
    expect(detail).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    // still an engine notice too
    expect(fake.notices.join("\n")).toContain("could not handle a defect fact");
    await wiring.close();
  });

  it("a guard-dir write that throws is an engine notice, and a later fact is still handled", async () => {
    const h = createHarness();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
      { githubRemote: true, createUpstream: up.create },
    );
    const run = await started(h);
    await wiring.idle();
    // the summary's file is now a directory: the next day's summary write throws
    const summary = join(h.engine.guardDir, "automation-summary.json");
    rmSync(summary, { force: true });
    mkdirSync(join(summary, "x"), { recursive: true });
    h.advance(24 * 60 * 60_000);
    h.engine.recordModuleEvent(run, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind: "gate_infra", detail: "the scanner could not start" },
    });
    await expect(wiring.idle()).resolves.toBeUndefined();
    expect(h.engine.notices.join("\n")).toMatch(/automation \(the daily summary\) failed/);
    h.engine.recordModuleEvent(run, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind: "crash", detail: "a job failed" },
    });
    await wiring.idle();
    expect(up.facts.map((f) => f.errorClass)).toEqual(["incident.gate_infra", "incident.crash"]);
    await wiring.close();
    await h.release();
  });

  it("vtc pause stops automation with no run open, until the human's vtc resume (the kill switch)", async () => {
    const h = createHarness();
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
        h.engine,
        { repoRoot: h.repo, vtcHome: h.home, automation: AUTOMATION, now: () => h.clock },
        { githubRemote: true, createUpstream: create, sweepEveryMs: 1000 },
      );
      await wiring.idle();
      expect(sweeps).toBe(1);
      // idle: no run to pause, but automation stops all the same, and the answer says so
      // (NoRunControlResult, contracts 5.4.0)
      expect(await h.engine.pause({})).toEqual({ run: null, automation_paused: true });
      expect(automationPausedByHuman(h.engine.guardDir)).toBe(true);
      expect(wiring.settings()).toMatchObject({ issues: false, prs: false, upstream: false });
      expect(wiring.settings()?.notes).toContain("automation is paused (vtc pause)");
      vi.advanceTimersByTime(3000);
      await wiring.idle();
      expect(sweeps).toBe(1);
      // a run that starts meanwhile does not switch it back on
      await started(h);
      expect(automationPausedByHuman(h.engine.guardDir)).toBe(true);
      expect(wiring.settings()?.notes).toContain("automation is paused (vtc pause)");
      // the human's resume does, and says so
      expect(await h.engine.resume({})).toMatchObject({ automation_paused: false });
      expect(automationPausedByHuman(h.engine.guardDir)).toBe(false);
      vi.advanceTimersByTime(1000);
      await wiring.idle();
      expect(sweeps).toBe(2);
      await wiring.close();
    } finally {
      vi.useRealTimers();
    }
    await h.release();
  });

  it("an automatic action taken while no run is open is visible at once: in the wiring's pending events and in the next daily summary (D-ca)", async () => {
    const fake = fakeEngine();
    const up = fakeUpstream();
    let clock = new Date("2026-10-13T09:00:00.000Z");
    const wiring = wireAutomation(
      fake.engine,
      { repoRoot: tempDir(), vtcHome: tempDir(), automation: AUTOMATION, now: () => clock },
      { githubRemote: true, createUpstream: up.create },
    );
    await wiring.idle();
    // the daily sweep closes a quiet issue between runs
    clock = new Date("2026-10-13T10:00:00.000Z");
    up.deps().emit({
      type: "upstream.issue_closed",
      actor: "engine",
      data: {
        target: { kind: "upstream", repo: "bason-labs/bs-vtc" },
        kind: "defect",
        fingerprint: "0123456789abcdef",
        number: 7,
        url: "https://github.com/bason-labs/bs-vtc/issues/7",
        reason: "quiet",
      },
    });
    expect(wiring.pendingEvents()).toEqual([
      expect.objectContaining({
        type: "upstream.issue_closed",
        ts: "2026-10-13T10:00:00.000Z",
        data: expect.objectContaining({ number: 7 }) as object,
      }),
    ]);
    // the next UTC day's summary counts it, though no run's log holds it yet
    clock = new Date("2026-10-14T08:00:00.000Z");
    fake.runs.set("R-2", { finished: false, paused: false });
    fake.event({ type: "run.paused", run: "R-2", data: { reason: "x" } });
    await wiring.idle();
    expect(fake.relayed).toEqual([expect.stringMatching(/1 closed/) as string]);
    await wiring.close();
  });

  it("hands an advisory in the dependencies over only on VTC's own repo, and Lookback's new-agent signals as improvements (D-bv (4), D-cd)", async () => {
    const advisory = {
      type: "finding.recorded",
      run: "R-1",
      task: "T-1",
      data: {
        finding: {
          fingerprint: "5".repeat(64),
          source: "tool",
          source_name: "osv-scanner",
          rule_id: "GHSA-aaaa-bbbb-cccc",
          category: "supply_chain",
          title: "zod@4.6.7: a parsing flaw",
          severity: "high",
          confidence: 1,
          location: { path: "pnpm-lock.yaml", symbol: "zod@4.6.7" },
          evidence: { type: "command_output", ref: "gates/1/osv.json" },
          req_ids: [],
          route: "patch",
          task: "T-1",
          round_first_seen: 1,
          status: "open",
        },
      },
    } as const;
    for (const vtcRepo of [false, true]) {
      const fake = fakeEngine();
      const up = fakeUpstream();
      const wiring = wireAutomation(
        fake.engine,
        { repoRoot: tempDir(), vtcHome: tempDir(), automation: AUTOMATION },
        { githubRemote: true, createUpstream: up.create, vtcRepo: () => vtcRepo },
      );
      fake.runs.set("R-1", { finished: false, paused: false });
      fake.event(advisory);
      await wiring.idle();
      expect(up.facts.map((f) => f.kind)).toEqual(vtcRepo ? ["security"] : []);
      // another project's dependencies are not VTC's: nothing raised, nothing skipped
      expect(fake.recorded.filter((r) => r.type === "automation.skipped")).toEqual([]);
      wiring.improvements([
        {
          target: "upstream",
          kind: "new_agent",
          run: "R-1",
          source: "lookback.new_agent",
          at: "2026-10-13T09:00:00.000Z",
          subject: "engineer_ml",
          metrics: { failures: 4, escalations: 0 },
          detail: "4 Engineer failures on ml tasks with no fitting profile",
        },
      ]);
      await wiring.idle();
      expect(up.facts.map((f) => f.kind)).toEqual(
        vtcRepo ? ["security", "new_agent"] : ["new_agent"],
      );
      await wiring.close();
    }
  });

  it("scans VTC's own dependencies once a day, on any project, and raises each advisory (D-bv (4), reading 216)", async () => {
    const guardHome = tempDir();
    let answer: { id: string; package: string }[] | null = null;
    let scans = 0;
    const automation: AutomationDeps = {
      ...AUTOMATION,
      vtcAdvisories: () => {
        scans += 1;
        return Promise.resolve(answer);
      },
    };
    let clock = new Date("2026-10-13T09:00:00.000Z");
    const fake = fakeEngine();
    fake.runs.set("R-1", { finished: true, paused: false });
    const up = fakeUpstream();
    const open = () =>
      wireAutomation(
        fake.engine,
        { repoRoot: tempDir(), vtcHome: guardHome, automation, now: () => clock },
        // not VTC's own repo: a gate's advisory here is the project's, but the scan's are VTC's
        { githubRemote: true, createUpstream: up.create, vtcRepo: () => false, sweepEveryMs: 5 },
      );
    // no database yet: nothing raised, and asked again at the next tick
    const first = open();
    await first.idle();
    await new Promise((r) => setTimeout(r, 30));
    await first.idle();
    await first.close();
    expect(scans).toBeGreaterThan(1);
    expect(up.facts).toEqual([]);
    answer = [
      { id: "GHSA-aaaa-bbbb-cccc", package: "vite" },
      { id: "GHSA-dddd-eeee-ffff", package: "@babel/core" },
    ];
    const second = open();
    await second.idle();
    expect(
      up.facts.map((f) => [f.target, f.kind, f.source, f.advisory?.id, f.advisory?.package]),
    ).toEqual([
      ["upstream", "security", "vtc.dependency_scan", "GHSA-aaaa-bbbb-cccc", "vite"],
      ["upstream", "security", "vtc.dependency_scan", "GHSA-dddd-eeee-ffff", "@babel/core"],
    ]);
    await second.close();
    // a restarted daemon the same day scans nothing again; a day later it does
    const before = scans;
    const third = open();
    await third.idle();
    await third.close();
    expect(scans).toBe(before);
    clock = new Date("2026-10-14T09:00:01.000Z");
    const fourth = open();
    await fourth.idle();
    await fourth.close();
    expect(scans).toBe(before + 1);
    expect(up.facts).toHaveLength(4);
  });

  it("an automatic run the module asks for while another run is open waits, and starts once that run finishes, once per issue (D-bv)", async () => {
    const fake = fakeEngine();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      fake.engine,
      { repoRoot: tempDir(), vtcHome: tempDir(), automation: AUTOMATION },
      { githubRemote: true, createUpstream: up.create },
    );
    fake.runs.set("R-1", { finished: false, paused: false });
    await up.deps().startRun(AUTO_REQUEST, ISSUE);
    await up.deps().startRun(AUTO_REQUEST, ISSUE);
    await wiring.idle();
    expect(fake.automatic).toEqual([]);
    expect(fake.notices).toEqual([]);
    // the human's run finishes: the queued run starts, once
    fake.runs.set("R-1", { finished: true, paused: false });
    fake.event({ type: "run.finished", run: "R-1", data: {} });
    await wiring.idle();
    expect(fake.automatic).toEqual([{ input: AUTO_REQUEST, issue: ISSUE }]);
    // its run finishes too: nothing starts again for the same issue
    fake.runs.set("R-2", { finished: true, paused: false, automation: ISSUE });
    await up.deps().startRun(AUTO_REQUEST, ISSUE);
    fake.event({ type: "run.finished", run: "R-2", data: {} });
    await wiring.idle();
    expect(fake.automatic).toHaveLength(1);
    await wiring.close();
  });

  it("while the kill switch is set, a fact of a finished run is an automation.skipped (paused)", async () => {
    const fake = fakeEngine();
    const up = fakeUpstream();
    const wiring = wireAutomation(
      fake.engine,
      { repoRoot: tempDir(), vtcHome: tempDir(), automation: AUTOMATION },
      { githubRemote: true, createUpstream: up.create },
    );
    // between runs: the last one finished, none is open
    fake.runs.set("R-1", { finished: true, paused: false });
    setAutomationPaused(fake.engine.guardDir, "2026-10-13T09:00:00.000Z");
    fake.event({
      type: "feature.post_merge_ci",
      run: "R-1",
      feature: "F-1",
      data: { merge_commit: "a".repeat(40), status: "red", runs: [] },
    });
    await wiring.idle();
    expect(up.facts).toEqual([]);
    const pending = readFileSync(join(fake.engine.guardDir, "automation-pending.jsonl"), "utf8");
    expect(JSON.parse(pending.trim()) as Line).toMatchObject({
      type: "automation.skipped",
      data: { reason: "paused", kind: "ci_failure" },
    });
    await wiring.close();
  });
});
