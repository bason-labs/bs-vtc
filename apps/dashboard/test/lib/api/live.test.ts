import { describe, expect, it, vi } from "vitest";
import type { VtcEvent } from "@vtc/shared";
import { connectLiveStream, type LiveStatus } from "@/lib/api/live";
import { ApiError } from "@/lib/api/errors";
import { createInvalidationBus, runTopic, topicsForEvent } from "@/lib/api/topics";
import { readEventLog } from "../../fixtures";
import { NOTICE_EVENTS } from "../../notice-fixtures";
import { WAVE3_EVENTS } from "../../wave3-fixtures";

const events = (): VtcEvent[] =>
  readEventLog()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as VtcEvent);

const sse = (evs: readonly VtcEvent[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const e of evs) {
        c.enqueue(
          new TextEncoder().encode(`id: ${e.run}:${e.seq}\ndata: ${JSON.stringify(e)}\n\n`),
        );
      }
      c.close();
    },
  });

describe("topicsForEvent", () => {
  const byType = (type: string) => events().find((e) => e.type === type)!;
  it("maps task events to the task, task list and graph", () => {
    expect(topicsForEvent(byType("task.status_changed")).sort()).toEqual(
      ["graph", "status", "task:T-1", "tasks"].sort(),
    );
  });
  it("maps escalations, usage and features", () => {
    expect(topicsForEvent(byType("escalation.opened"))).toEqual(
      expect.arrayContaining(["escalations", "task:T-2"]),
    );
    expect(topicsForEvent(byType("usage.updated"))).toEqual(expect.arrayContaining(["usage"]));
    expect(topicsForEvent(byType("feature.created"))).toEqual(
      expect.arrayContaining(["features", "graph"]),
    );
    expect(topicsForEvent(byType("run.phase_changed"))).toEqual(
      expect.arrayContaining(["runs", "graph"]),
    );
  });
  it("marks run notices stale on push, PR, incident and merge-level events", () => {
    // branch.pushed and feature.pr_updated resolve earlier failures.
    for (const e of NOTICE_EVENTS) {
      expect(topicsForEvent(e)).toEqual(expect.arrayContaining(["notices"]));
    }
    expect(topicsForEvent(byType("task.status_changed"))).not.toContain("notices");
  });
  it("marks the wave-3 views stale on their events (gates, headless, Level 3, research, lookback)", () => {
    const topics = (type: string) => topicsForEvent(WAVE3_EVENTS.find((e) => e.type === type)!);
    expect(topics("gate.requested")).toEqual(expect.arrayContaining(["gates", "status"]));
    expect(topics("gate.approved")).toEqual(expect.arrayContaining(["gates"]));
    expect(topics("fact.waived")).toEqual(expect.arrayContaining(["gates", "research"]));
    expect(topics("fact.verified")).toEqual(["research"]);
    expect(topics("headless.started")).toEqual(
      expect.arrayContaining(["headless", "status", "graph", "task:T-1"]),
    );
    expect(topics("headless.ended")).toEqual(expect.arrayContaining(["headless", "notices"]));
    expect(topics("merge.preflight")).toEqual(expect.arrayContaining(["level3", "notices"]));
    expect(topics("feature.checklist")).toEqual(expect.arrayContaining(["level3", "features"]));
    expect(topics("feature.reverted")).toEqual(expect.arrayContaining(["level3", "notices"]));
    expect(topics("final_review.step_finished")).toEqual(
      expect.arrayContaining(["level3", "features"]),
    );
    expect(topics("lookback.canary_evaluated")).toEqual(["lookback"]);
    expect(topics("lookback.rolled_back")).toEqual(expect.arrayContaining(["lookback", "notices"]));
  });
  it("ignores event types it does not know", () => {
    expect(topicsForEvent({ ...byType("run.started"), type: "plugin.custom_thing" })).toEqual([]);
  });
});

describe("createInvalidationBus", () => {
  it("coalesces a burst into one call per subscriber", async () => {
    const bus = createInvalidationBus(5);
    const graph = vi.fn();
    const usage = vi.fn();
    bus.subscribe(runTopic("r1", "graph"), graph);
    bus.subscribe("usage", usage);
    bus.invalidate([runTopic("r1", "graph"), "usage"]);
    bus.invalidate([runTopic("r1", "graph")]);
    bus.invalidate([runTopic("r2", "graph")]);
    await new Promise((r) => setTimeout(r, 20));
    expect(graph).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledOnce();
  });
  it("stops calling after unsubscribe", async () => {
    const bus = createInvalidationBus(0);
    const cb = vi.fn();
    const off = bus.subscribe("usage", cb);
    off();
    bus.invalidate(["usage"]);
    await new Promise((r) => setTimeout(r, 5));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("connectLiveStream", () => {
  it("delivers each valid event once and resumes from the last id after a drop", async () => {
    const log = events();
    const opened: (string | null)[] = [];
    let calls = 0;
    const received: number[] = [];
    const statuses: LiveStatus[] = [];
    const done = new Promise<void>((resolve) => {
      const close = connectLiveStream({
        openStream: (lastId) => {
          opened.push(lastId);
          calls += 1;
          if (calls === 1) return Promise.resolve(sse(log.slice(0, 3)));
          // The engine resends seq 3 after the reconnect: delivered once only.
          if (calls === 2) return Promise.resolve(sse(log.slice(2, 5)));
          close();
          resolve();
          return Promise.reject(new ApiError("offline", "gone"));
        },
        onEvent: (e) => received.push(e.seq),
        onStatus: (s) => statuses.push(s),
        sleep: () => Promise.resolve(),
      });
    });
    await done;
    expect(received).toEqual([1, 2, 3, 4, 5]);
    expect(opened).toEqual([null, "golden-1:3", "golden-1:5"]);
    expect(statuses).toContain("live");
    expect(statuses).toContain("reconnecting");
  });

  it("skips malformed messages", async () => {
    const received: number[] = [];
    await new Promise<void>((resolve) => {
      const close = connectLiveStream({
        openStream: () => {
          close();
          return Promise.resolve(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('data: nope\n\ndata: {"v":1}\n\n'));
                c.close();
              },
            }),
          );
        },
        onEvent: (e) => received.push(e.seq),
        onStatus: (s) => {
          if (s === "closed") resolve();
        },
        sleep: () => Promise.resolve(),
      });
    });
    expect(received).toEqual([]);
  });

  it("stops retrying when the session is refused", async () => {
    const statuses: LiveStatus[] = [];
    const open = vi.fn(() => Promise.reject(new ApiError("forbidden", "no", 403)));
    await new Promise<void>((resolve) => {
      connectLiveStream({
        openStream: open,
        onEvent: () => undefined,
        onStatus: (s) => {
          statuses.push(s);
          if (s === "unauthorized") resolve();
        },
        sleep: () => Promise.resolve(),
      });
    });
    expect(open).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe("unauthorized");
  });

  it("backs off exponentially up to a cap", async () => {
    const waits: number[] = [];
    let n = 0;
    await new Promise<void>((resolve) => {
      const close = connectLiveStream({
        openStream: () => {
          n += 1;
          if (n === 8) {
            close();
            resolve();
          }
          return Promise.reject(new ApiError("offline", "down"));
        },
        onEvent: () => undefined,
        onStatus: () => undefined,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      });
    });
    expect(waits.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
