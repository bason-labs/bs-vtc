/**
 * Automation as the daemon wires it (AD-27 rules 7 and 8; D-bv, D-bz, D-ca): engine facts reach
 * the upstream module when the settings allow, otherwise an `automation.skipped` says why; `vtc
 * pause` stops automation; the module's only sink records `upstream.*` and `automation.skipped`
 * events (into the next run's log when none is open); the Lead relays a daily summary once per UTC
 * day; without `EngineDeps.automation` nothing is evaluated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AutomationDeps, type StartInput } from "@vtc/shared";
import type { AutomationFact, CreateUpstream, UpstreamWiringDeps } from "../../src/core/index.js";
import { isGitHubRemote, wireAutomation } from "../../src/daemon/automation.js";
import { cleanupDirs } from "../helpers/repo.js";
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
});
