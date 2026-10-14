/**
 * Lookback's engine-side dispatch hooks (spec §13; spine AD-21 rules 1, 2 and 7, §5 reading 102):
 * the pinned editable section the lookback module selects is rendered first in the task pack;
 * `role.dispatched` records its `editable_sha256`, the canary arm when a canary covers the role,
 * and the effective prompt SHA as the envelope's `prompt_sha`; a task's canary arm is logged once
 * (`lookback.canary_assigned`, sticky across fix rounds). Core never imports `lookback/`: the
 * daemon hands the selector to the engine (`Engine.setPromptPins`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectivePromptSha, sha256Hex, type PromptVersionRef } from "@vtc/shared";
import type { PinnedPrompt, PromptPins, PromptTarget } from "../../src/core/kernel.js";
import { cleanupDirs } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  SPEC_ONE,
  throughPlan,
  type Harness,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  task?: string;
  role?: string;
  prompt_sha?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const ofType = (h: Harness, type: string): Line[] => events(h).filter((e) => e.type === type);

const start = (h: Harness) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CLAUDE,
  );

const EDITABLE = "Prefer the smallest map that names every entry point.";
const LOCKED = "You are the Repo Cartographer.";

const versionFor = (target: PromptTarget, editable = EDITABLE): PromptVersionRef => ({
  role: target.role,
  ...(target.mode === undefined ? {} : { mode: target.mode }),
  host: target.host,
  locked_sha256: sha256Hex(LOCKED),
  editable_sha256: sha256Hex(editable),
  effective_sha256: effectivePromptSha(LOCKED, editable),
});

/** Pins `role` to the editable section; everything else keeps the compiled default. */
const pinning =
  (role: string, extra: Partial<PinnedPrompt> = {}, seen: PromptTarget[] = []): PromptPins =>
  (target) => {
    seen.push(target);
    if (target.role !== role) return null;
    return { version: versionFor(target), text: EDITABLE, ...extra };
  };

describe("AD-21 rules 1 and 2: the pinned editable section goes in the task pack", () => {
  it("without a selector the dispatch carries the compiled agent's prompt only", async () => {
    const h = createHarness();
    await start(h);
    const carto = only((await h.engine.next({}, CLAUDE)).actions, "repo_cartographer");
    const dispatched = ofType(h, "role.dispatched")[0];
    expect(dispatched?.data).not.toHaveProperty("editable_sha256");
    expect(dispatched?.data).not.toHaveProperty("canary_arm");
    expect(readFileSync(join(h.repo, carto.pack), "utf8")).not.toContain(EDITABLE);
    await h.release();
  });

  it("renders the pinned section first and records its SHA and the effective prompt version", async () => {
    const h = createHarness();
    const seen: PromptTarget[] = [];
    h.engine.setPromptPins(pinning("repo_cartographer", {}, seen));
    await start(h);
    const carto = only((await h.engine.next({}, CLAUDE)).actions, "repo_cartographer");
    expect(seen[0]).toMatchObject({
      run: h.engine.status({}).run.id,
      role: "repo_cartographer",
      host: "claude-code",
      agent: "vtc-repo-cartographer",
    });
    const pack = readFileSync(join(h.repo, carto.pack), "utf8");
    expect(pack.indexOf(EDITABLE)).toBeGreaterThanOrEqual(0);
    expect(pack.indexOf(EDITABLE)).toBeLessThan(pack.indexOf(`action: ${carto.action_id}`));
    const dispatched = ofType(h, "role.dispatched")[0];
    expect(dispatched?.prompt_sha).toBe(effectivePromptSha(LOCKED, EDITABLE));
    expect(dispatched?.data.editable_sha256).toBe(sha256Hex(EDITABLE));
    expect(dispatched?.data).not.toHaveProperty("canary_arm");
    const run = h.engine.states().at(-1)?.roleRuns.get(carto.action_id);
    expect(run?.prompt_sha).toBe(effectivePromptSha(LOCKED, EDITABLE));
    await h.release();
  });

  it("ignores a selection that names another role or host, is malformed, or throws", async () => {
    for (const pins of [
      ((target) => ({
        version: versionFor({ ...target, role: "planner" }),
        text: EDITABLE,
      })) satisfies PromptPins,
      ((target) => ({
        version: versionFor({ ...target, host: "codex" }),
        text: EDITABLE,
      })) satisfies PromptPins,
      ((target) => ({
        version: { ...versionFor(target), editable_sha256: "nope" },
        text: EDITABLE,
      })) satisfies PromptPins,
      ((target) => ({ version: versionFor(target), text: "   " })) satisfies PromptPins,
      (() => {
        throw new Error("pins.yaml is unreadable");
      }) satisfies PromptPins,
    ]) {
      const h = createHarness();
      h.engine.setPromptPins(pins);
      await start(h);
      const carto = only((await h.engine.next({}, CLAUDE)).actions, "repo_cartographer");
      expect(ofType(h, "role.dispatched")[0]?.data).not.toHaveProperty("editable_sha256");
      expect(readFileSync(join(h.repo, carto.pack), "utf8")).not.toContain(EDITABLE);
      await h.release();
    }
  });
});

describe("AD-21 rule 7: a canary arm is recorded per dispatch and once per task", () => {
  it("records canary_arm on role.dispatched and lookback.canary_assigned once per task and role", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const candidate = effectivePromptSha(LOCKED, EDITABLE);
    const baseline = effectivePromptSha(LOCKED, "the compiled default");
    h.engine.setPromptPins(
      pinning("engineer", { canary: { arm: "candidate", candidate, baseline } }),
    );
    h.gates.queue("round", "fail");
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    // the failed round sends the task back to the Engineer: same task, same arm, no new event
    const again = only((await h.engine.next({}, CLAUDE)).actions, "engineer");
    expect(again.task).toBe("T-1");
    const engineers = ofType(h, "role.dispatched").filter((e) => e.role === "engineer");
    expect(engineers).toHaveLength(2);
    for (const e of engineers) expect(e.data.canary_arm).toBe("candidate");
    expect(ofType(h, "role.dispatched").find((e) => e.role === "qa")?.data).not.toHaveProperty(
      "canary_arm",
    );
    expect(ofType(h, "lookback.canary_assigned")).toEqual([
      expect.objectContaining({
        task: "T-1",
        role: "engineer",
        data: { arm: "candidate", candidate, baseline },
      }),
    ]);
    await h.release();
  });
});
