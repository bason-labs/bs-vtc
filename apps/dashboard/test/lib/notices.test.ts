import { describe, expect, it } from "vitest";
import { EventPageSchema, type EventPage } from "@vtc/shared";
import { loadRunEvents, noticeForEvent, runNotices, type RunNotice } from "@/lib/notices";
import { readFixture } from "../fixtures";
import { NOTICE_EVENTS, noticeEvent } from "../notice-fixtures";

const byType = (type: string, kind?: string) =>
  NOTICE_EVENTS.find(
    (e) => e.type === type && (kind === undefined || (e.data as { kind?: string }).kind === kind),
  )!;

describe("noticeForEvent (typed 4.1.0 events the human must see)", () => {
  it("shows a failed push with git's redacted message and the retry rule", () => {
    expect(noticeForEvent(byType("branch.push_failed"))).toMatchObject({
      seq: 46,
      type: "branch.push_failed",
      tone: "danger",
      title: "Push of vtc/F-1 failed",
      detail: "fatal: unable to access remote: Could not resolve host",
      note: "Merged tasks stay merged; the next push retries.",
      feature: "F-1",
    });
  });

  it("shows a failed PR update", () => {
    expect(noticeForEvent(byType("feature.pr_failed"))).toMatchObject({
      tone: "danger",
      title: "Pull request update failed",
      detail: "gh: HTTP 502 while opening the draft PR",
      feature: "F-1",
    });
  });

  it("shows a config change as a warning that does not pause the run", () => {
    expect(noticeForEvent(byType("incident.recorded", "config_changed"))).toMatchObject({
      tone: "warn",
      title: "Config changed during the run",
      detail: ".vtc/project.yaml changed during the run",
      note: "The run keeps the config it started with; the new config applies to the next run.",
    });
  });

  it("shows an unexplained checkout write with its evidence", () => {
    expect(noticeForEvent(byType("incident.recorded", "checkout_write"))).toMatchObject({
      tone: "danger",
      title: "Unexplained write in the checkout",
      evidence: ["file: src/auth/reset.ts"],
    });
  });

  it("names every other incident kind", () => {
    const crash = noticeEvent(52, "incident.recorded", { kind: "stale_lock", detail: "lock" });
    expect(noticeForEvent(crash)).toMatchObject({ tone: "danger", title: "Incident: stale lock" });
  });

  it("explains the no-remote merge-level downgrade", () => {
    expect(noticeForEvent(byType("run.merge_level_changed"))).toMatchObject({
      tone: "warn",
      title: "Merge level lowered from 2 to 1",
      detail: "This repository has no push remote.",
      note: "Tasks reach done once merged locally (Level 1).",
    });
    const human = noticeEvent(53, "run.merge_level_changed", { from: 1, to: 2, reason: "human" });
    expect(noticeForEvent(human)).toMatchObject({
      tone: "neutral",
      title: "Merge level raised from 1 to 2",
      detail: "Changed by the human.",
    });
  });

  it("ignores every other event", () => {
    expect(noticeForEvent(byType("branch.pushed"))).toBeNull();
    const golden = (readFixture("events") as EventPage).events;
    expect(golden.map(noticeForEvent).filter((n) => n !== null)).toEqual([]);
  });
});

describe("runNotices", () => {
  it("lists notices newest first and marks failures a later success resolved", () => {
    const notices = runNotices(NOTICE_EVENTS);
    expect(notices.map((n: RunNotice) => n.seq)).toEqual([50, 49, 48, 46, 45]);
    expect(notices.find((n) => n.type === "branch.push_failed")?.resolved).toBe(true);
    expect(notices.find((n) => n.type === "feature.pr_failed")?.resolved).toBe(false);
    const prUpdated = noticeEvent(
      51,
      "feature.pr_updated",
      {
        pr: {
          url: "https://github.com/acme/app/pull/7",
          state: "open",
          draft: true,
          head_sha: "b".repeat(40),
          ci: "pending",
        },
      },
      { feature: "F-1" },
    );
    expect(
      runNotices([...NOTICE_EVENTS, prUpdated]).find((n) => n.type === "feature.pr_failed")
        ?.resolved,
    ).toBe(true);
  });

  it("keeps only one feature's notices when asked", () => {
    expect(runNotices(NOTICE_EVENTS, "F-1").map((n) => n.type)).toEqual([
      "feature.pr_failed",
      "branch.push_failed",
    ]);
    expect(runNotices(NOTICE_EVENTS, "F-2")).toEqual([]);
  });
});

describe("loadRunEvents", () => {
  it("reads every page of the run's log", async () => {
    const calls: number[] = [];
    const pages: Record<number, EventPage> = {
      0: EventPageSchema.parse({
        run: "golden-1",
        events: NOTICE_EVENTS.slice(0, 2),
        next_after: 46,
      }),
      46: EventPageSchema.parse({
        run: "golden-1",
        events: NOTICE_EVENTS.slice(2),
        next_after: null,
      }),
    };
    const events = await loadRunEvents(
      {
        events: (_run, after) => {
          calls.push(after);
          return Promise.resolve(pages[after]!);
        },
      },
      "golden-1",
    );
    expect(calls).toEqual([0, 46]);
    expect(events.map((e) => e.seq)).toEqual([45, 46, 47, 48, 49, 50]);
  });

  it("stops when a page makes no progress", async () => {
    let calls = 0;
    const stuck = EventPageSchema.parse({ run: "golden-1", events: [], next_after: 0 });
    await loadRunEvents(
      {
        events: () => {
          calls += 1;
          return Promise.resolve(stuck);
        },
      },
      "golden-1",
    );
    expect(calls).toBe(1);
  });
});
