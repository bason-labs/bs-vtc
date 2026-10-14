/**
 * Replay trials are no work of the run (spine §5 readings 176 and 177): the read models behind
 * status, the task views, Flow Studio and the event view leave out a `lookback_replay` dispatch and
 * every `role.*` and `headless.*` event of its action, and Lookback reads the run without them even
 * where the engine's private `<guard>/replays/` file is missing (a clone, a fresh machine).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEventLog, type VtcEvent } from "@vtc/shared";
import {
  applyEvent,
  createReadModel,
  isReplayTrialEvent,
  readModelState,
  type Engine,
  type RunState,
} from "../../src/core/index.js";
import { emptyRunState } from "../../src/core/state.js";
import { liveEvents, lookbackEventsOf } from "../../src/daemon/index.js";

const golden = parseEventLog(
  readFileSync(new URL("../../../../fixtures/golden-run/events.jsonl", import.meta.url), "utf8"),
).events;

/** The golden run with a replay trial (`a-90`) dispatched, launched and submitted at its end. */
const withTrial = (): RunState => {
  const last = golden.at(-1);
  if (last === undefined) throw new Error("empty golden log");
  let seq = last.seq;
  const at = (type: string, rest: Record<string, unknown>): VtcEvent =>
    ({
      v: 1,
      seq: (seq += 1),
      ts: last.ts,
      run: last.run,
      type,
      ...rest,
    }) as VtcEvent;
  const envelope = {
    role: "engineer",
    prompt_sha: "4".repeat(64),
    host: "claude-code",
    model: "claude-sonnet-5",
  };
  const trial = [
    at("role.dispatched", {
      actor: "engine",
      ...envelope,
      data: {
        action_id: "a-90",
        dispatch: "headless",
        agent: "vtc-engineer",
        pack: ".vtc/state/packs/a-90.md",
        resume: null,
        purpose: "lookback_replay",
        replay: { proposal: "p-1", task: "golden-0:T-1", arm: "b", trial: 1 },
      },
    }),
    at("headless.started", {
      actor: "engine",
      role: "engineer",
      host: "claude-code",
      data: {
        action_id: "a-90",
        pid: 4242,
        resume: null,
        wall_timeout_ms: 1000,
        idle_timeout_ms: 1000,
      },
    }),
    at("role.submitted", {
      actor: "role",
      ...envelope,
      tokens: { in: 1, out: 1, cache_r: 0, cache_w: 0 },
      cost_usd: 0.01,
      data: {
        action_id: "a-90",
        exit: "built",
        findings: 0,
        questions: 0,
        session_ref: null,
        head: "c".repeat(40),
      },
    }),
  ];
  const state = emptyRunState(last.run, golden[0]?.ts ?? last.ts);
  for (const e of [...golden, ...trial]) applyEvent(state, e);
  return state;
};

describe("replay trials in the read models (reading 177)", () => {
  it("the views leave the trial out; the log keeps it", () => {
    const state = withTrial();
    expect(state.roleRuns.has("a-90")).toBe(true);
    const view = readModelState(state);
    expect(view.roleRuns.has("a-90")).toBe(false);
    expect(view.events.some((e) => (e.data as { action_id?: string }).action_id === "a-90")).toBe(
      false,
    );
    // the same state object again: the cached view
    expect(readModelState(state)).toBe(view);
    const model = createReadModel({
      repoRoot: "/nonexistent",
      mode: "snapshot",
      versions: { engine: "0.0.0", contracts: "5.0.0" },
      prototypeUrl: () => null,
      runs: () => [state],
      usage: () => new Map(),
      git: null,
    });
    const page = model.events(state.id, 0, 500);
    if (!page.ok) throw new Error(page.message);
    expect(page.body.events.map((e) => e.type)).toEqual(golden.map((e) => e.type));
    const status = model.status();
    if (!status.ok) throw new Error(status.message);
    expect(JSON.stringify(status.body)).not.toContain("a-90");
    const graph = model.graph(state.id, "project", undefined);
    if (!graph.ok) throw new Error(graph.message);
    expect(JSON.stringify(graph.body)).not.toContain("a-90");
    const task = model.task(state.id, "T-1");
    if (!task.ok) throw new Error(task.message);
    expect(JSON.stringify(task.body)).not.toContain("a-90");
  });

  it("the live event stream leaves the trial out too, so a reload shows what it showed", () => {
    const state = withTrial();
    let emit: ((event: VtcEvent) => void) | undefined;
    const engine = {
      states: () => [state],
      onEvent: (fn: (event: VtcEvent) => void) => {
        emit = fn;
        return () => undefined;
      },
    } as unknown as Pick<Engine, "onEvent" | "states">;
    const seen: VtcEvent[] = [];
    liveEvents(engine, (e) => seen.push(e));
    for (const e of state.events) emit?.(e);
    expect(seen.map((e) => e.seq)).toEqual(golden.map((e) => e.seq));
    const trial = state.events.filter((e) => e.seq > (golden.at(-1)?.seq ?? 0));
    expect(trial.map((e) => isReplayTrialEvent(state, e))).toEqual([true, true, true]);
  });

  it("a run without a trial is its own view", () => {
    const state = emptyRunState("r1", "2026-10-13T09:00:00.000Z");
    for (const e of golden) applyEvent(state, { ...e, run: "r1" });
    expect(readModelState(state)).toBe(state);
  });
});

describe("Lookback reads the run without its trials (reading 176)", () => {
  it("drops a marked trial when the private <guard>/replays file is missing", () => {
    const state = withTrial();
    // no private record of the trial: the log's marker alone leaves it out
    const events = lookbackEventsOf(state, new Set());
    expect(events.some((e) => (e.data as { action_id?: string }).action_id === "a-90")).toBe(false);
    expect(events).toHaveLength(golden.length);
  });

  it("drops an unmarked trial (a log before 4.11.0) only through the private record", () => {
    const state = withTrial();
    const unmarked = {
      events: state.events.map((e) =>
        e.type === "role.dispatched" && (e.data as { action_id?: string }).action_id === "a-90"
          ? {
              ...e,
              data: {
                ...e.data,
                purpose: undefined,
                replay: undefined,
              },
            }
          : e,
      ),
    };
    expect(lookbackEventsOf(unmarked)).toHaveLength(golden.length + 3);
    expect(lookbackEventsOf(unmarked, new Set(["a-90"]))).toHaveLength(golden.length);
  });
});
