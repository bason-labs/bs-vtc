/**
 * Cross-family review (spec §12.4, D10; spine AD-17 rules 2 and 4): on a high-risk task with
 * `hosts.cross_family_review`, the other host family runs a read-only reviewer as an
 * engine-launched headless run, which needs `headless_allowed`; triage waits for it. Without the
 * opt-in it is unavailable and skipped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostOutcome } from "@vtc/shared";
import { cleanupDirs } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  SPEC_ONE,
  spawns,
  throughPlan,
  verdictPass,
  type Harness,
  type HeadlessScript,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

const judge: HeadlessScript = (request): HostOutcome => ({
  kind: "done",
  session_ref: null,
  output: {
    role: "qa",
    mode: "judge",
    task: "T-1",
    summary: "reviewed",
    exit: "done",
    verdicts: [
      {
        subject: "T-1",
        verdict: "pass",
        evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
      },
    ],
  },
  model: request.model.model ?? null,
  tokens: null,
  cost_usd: 0.2,
});

const toReviews = async (h: Harness) => {
  const actions = await throughPlan(h, [draft("T-1", { risk: "high" })], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
  return spawns((await h.engine.next({}, CLAUDE)).actions);
};

describe("cross-family review (§12.4)", () => {
  it("runs the other family's reviewer headless on a high-risk task, and triage waits for it", async () => {
    const h = createHarness({
      project: {
        merge_level: 1,
        concurrency: 3,
        hosts: { dispatch: "headless_allowed", cross_family_review: true },
      },
      codex: { headless: judge },
    });
    const first = await toReviews(h);
    // three at a time: two of the Lead's reviewers, and the cross-family one, which is never a
    // Lead action
    expect(first.map((r) => `${r.role}${r.mode === undefined ? "" : `/${r.mode}`}`)).toEqual([
      "spec_verifier",
      "qa/judge",
    ]);
    expect(h.launched.map((l) => [l.host, l.request.role, l.request.mode])).toEqual([
      ["codex", "qa", "judge"],
    ]);
    const log = readFileSync(
      join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`),
      "utf8",
    );
    expect(log).toContain('"purpose":"cross_family_review"');
    await h.engine.settle();
    let pending = first;
    for (let i = 0; i < 4 && pending.length > 0; i += 1) {
      const handed: typeof pending = [];
      for (const r of pending)
        handed.push(...spawns((await verdictPass(h, r, "src/t-1/impl.ts")).actions));
      await h.engine.settle();
      pending = [...handed, ...spawns((await h.engine.next({}, CLAUDE)).actions)].filter(
        (a, j, all) => all.findIndex((b) => b.action_id === a.action_id) === j,
      );
    }
    expect(h.launched).toHaveLength(1);
    await h.engine.settle();
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ done: 1 });
    await h.release();
  });

  it("without headless_allowed the cross-family review is skipped", async () => {
    const h = createHarness({
      project: { merge_level: 1, concurrency: 3, hosts: { cross_family_review: true } },
      codex: { headless: judge },
    });
    let pending = await toReviews(h);
    for (let i = 0; i < 4 && pending.length > 0; i += 1) {
      const handed: typeof pending = [];
      for (const r of pending)
        handed.push(...spawns((await verdictPass(h, r, "src/t-1/impl.ts")).actions));
      await h.engine.settle();
      pending = [...handed, ...spawns((await h.engine.next({}, CLAUDE)).actions)].filter(
        (a, j, all) => all.findIndex((b) => b.action_id === a.action_id) === j,
      );
    }
    expect(h.launched).toEqual([]);
    await h.engine.settle();
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ done: 1 });
    await h.release();
  });

  it("a Codex reviewer is not launched where Codex may not run headless (linux), and triage completes", async () => {
    const h = createHarness({
      platform: "linux",
      project: {
        merge_level: 1,
        concurrency: 3,
        hosts: { dispatch: "headless_allowed", cross_family_review: true },
      },
      codex: { headless: judge },
    });
    let pending = await toReviews(h);
    for (let i = 0; i < 4 && pending.length > 0; i += 1) {
      const handed: typeof pending = [];
      for (const r of pending)
        handed.push(...spawns((await verdictPass(h, r, "src/t-1/impl.ts")).actions));
      await h.engine.settle();
      pending = [...handed, ...spawns((await h.engine.next({}, CLAUDE)).actions)].filter(
        (a, j, all) => all.findIndex((b) => b.action_id === a.action_id) === j,
      );
    }
    expect(h.launched).toEqual([]);
    const log = readFileSync(
      join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`),
      "utf8",
    );
    expect(log).not.toContain('"purpose":"cross_family_review"');
    await h.engine.settle();
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ done: 1 });
    await h.release();
  });
});
