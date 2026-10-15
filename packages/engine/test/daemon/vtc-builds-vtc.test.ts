/**
 * "VTC builds VTC" across two daemons (D-bv (2), D-cd; spine §5 reading 216): a crash in a user
 * project's run raises a fixable defect in VTC's repo, located by its VTC frames; that project's
 * engine cannot build bs-vtc, so nothing starts there; the daemon on the bs-vtc checkout picks the
 * issue up at its next tick and starts one automatic run with the issue as its spec. The real
 * upstream module and bridge, in-memory GitHub (D-cc: no real gh), fake engines.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationDeps, StartInput, VtcEvent } from "@vtc/shared";
import type { Engine, EventDraft } from "../../src/core/index.js";
import { wireAutomation } from "../../src/daemon/automation.js";
import { bridgeUpstream } from "../../src/daemon/upstream-bridge.js";
import { createUpstream } from "../../src/upstream/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { fakeAssets, memoryGitHub } from "../upstream/fakes.js";

afterEach(cleanupDirs);

const UPSTREAM = "bason-labs/bs-vtc";

/** An engine stand-in: runs a test opens and finishes, and the automatic runs it was asked for. */
const fakeEngine = () => {
  const runs = new Map<
    string,
    { finished: boolean; automation?: { issue: number; target: { repo: string } } }
  >();
  const automatic: { input: StartInput; issue: { issue: number; target: { repo: string } } }[] = [];
  const notices: string[] = [];
  let listener: ((event: VtcEvent) => void) | undefined;
  const engine = {
    guardDir: tempDir("vtc-guard-"),
    states: () =>
      [...runs.entries()].map(([id, r]) => ({
        id,
        run: { ...(r.finished ? { finished_at: "2026-10-15T09:00:00.000Z" } : {}), paused: false },
        automation: r.automation ?? null,
        findings: new Map(),
        events: [],
      })),
    startAutomatic: (input: StartInput, issue: { issue: number; target: { repo: string } }) => {
      automatic.push({ input, issue });
      runs.set(`R-${String(runs.size + 1)}`, { finished: false, automation: issue });
      return Promise.resolve({
        run: `R-${String(runs.size)}`,
        track: input.track,
        phase: "discover",
      });
    },
    config: () => ({}),
    recordModuleEvent: (run: string, _draft: EventDraft): boolean =>
      runs.get(run)?.finished === false,
    onEvent: (fn: (event: VtcEvent) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    relay: () => undefined,
    notice: (text: string) => {
      notices.push(text);
    },
  } as unknown as Engine;
  return {
    engine,
    runs,
    automatic,
    notices,
    event: (event: Pick<VtcEvent, "type" | "run" | "data">) => {
      listener?.({ ts: "2026-10-15T10:00:00.000Z", seq: 1, actor: "engine", ...event } as VtcEvent);
    },
  };
};

describe("VTC builds VTC: a project's crash is fixed by the bs-vtc checkout's engine", () => {
  it("raises the located defect from the project and starts its run on the checkout, once", async () => {
    const github = memoryGitHub({ now: () => new Date("2026-10-15T10:00:00.000Z") });
    const checkout = tempDir("bs-vtc-");
    const automation: AutomationDeps = {
      issues: github.issues,
      pullRequests: github.pullRequests,
      upstream: { repo: UPSTREAM, share: true, checkout },
      hosting: "branch",
      ffmpeg: false,
    };
    const daemon = (repoRoot: string, remoteUrl: string) => {
      const fake = fakeEngine();
      const wiring = wireAutomation(
        fake.engine,
        {
          repoRoot,
          vtcHome: tempDir("vtc-home-"),
          automation,
          now: () => new Date("2026-10-15T10:00:00.000Z"),
        },
        {
          githubRemote: true,
          sweepEveryMs: 60 * 60_000,
          createUpstream: bridgeUpstream(createUpstream, {
            guardDir: fake.engine.guardDir,
            vtcVersion: "0.5.0",
            assets: fakeAssets(),
            remoteUrl,
            clientNames: () => [],
            knownValues: () => [],
            redactSelectors: () => undefined,
            projectEvidence: () => undefined,
            lookbackPr: () => Promise.resolve("none"),
            evidenceSnapshot: () => ({ routes: {}, events: [] }),
            gitOps: () => ({ readFileAtCommit: () => Promise.resolve(undefined) }),
            remoteRefs: () => ({
              fetch: () => Promise.resolve(),
              message: () => Promise.resolve(null),
            }),
            plumbing: () => {
              throw new Error("no PR in this test");
            },
          }),
        },
      );
      return { fake, wiring };
    };

    // a user's project: its run crashes twice in the same VTC code
    const project = daemon(tempDir("acme-app-"), "git@github.com:acme/app.git");
    project.fake.runs.set("R-1", { finished: false });
    const crash = {
      type: "incident.recorded",
      run: "R-1",
      data: {
        kind: "crash",
        detail: "background job dispatch failed: boom",
        stack: "    at Engine.spawn (packages/engine/src/core/engine.ts:900:11)",
      },
    } as const;
    project.fake.event(crash);
    project.fake.event(crash);
    await project.wiring.idle();
    expect(github.state.issues.map((i) => [i.repo, i.number, i.labels])).toEqual([
      [UPSTREAM, 1, ["vtc:auto", "vtc:kind/defect", "vtc:fixable"]],
    ]);
    // the project's engine cannot build bs-vtc
    expect(project.fake.automatic).toEqual([]);
    await project.wiring.close();

    // the bs-vtc checkout's daemon picks the issue up when it starts
    const own = daemon(checkout, `git@github.com:${UPSTREAM}.git`);
    await own.wiring.idle();
    expect(own.fake.automatic.map((a) => [a.issue.target.repo, a.issue.issue])).toEqual([
      [UPSTREAM, 1],
    ]);
    expect(own.fake.automatic[0]?.input.request).toContain(`${UPSTREAM}#1`);
    expect(own.fake.automatic[0]?.input.request).toContain("engine/core/engine:Engine.spawn");
    expect(own.fake.notices).toEqual([]);
    await own.wiring.close();

    // restarted on the checkout: the issue's run was started once, so none starts again
    const again = daemon(checkout, `git@github.com:${UPSTREAM}.git`);
    for (const [id, run] of own.fake.runs) again.fake.runs.set(id, { ...run, finished: true });
    await again.wiring.idle();
    expect(again.fake.automatic).toEqual([]);
    await again.wiring.close();
  });
});
