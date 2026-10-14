import { describe, expect, it } from "vitest";
import { EventPageSchema, type EventPage, type VtcEvent } from "@vtc/shared";
import {
  loadRunEvents,
  MAX_EVENT_PAGES,
  noticeForEvent,
  runNotices,
  type RunNotice,
} from "@/lib/notices";
import { readFixture } from "../fixtures";
import { NOTICE_EVENTS, noticeEvent } from "../notice-fixtures";
import { w3Event, WAVE3_EVENTS } from "../wave3-fixtures";

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
    const log = await loadRunEvents(
      {
        events: (_run, after) => {
          calls.push(after);
          return Promise.resolve(pages[after]!);
        },
      },
      "golden-1",
    );
    expect(calls).toEqual([0, 46]);
    expect(log.events.map((e) => e.seq)).toEqual([45, 46, 47, 48, 49, 50]);
    expect(log.truncated).toBe(false);
  });

  it("says the log is truncated when it is longer than the pages it reads", async () => {
    let calls = 0;
    const log = await loadRunEvents(
      {
        events: (_run, after) => {
          calls += 1;
          return Promise.resolve(
            EventPageSchema.parse({ run: "golden-1", events: [], next_after: after + 1 }),
          );
        },
      },
      "golden-1",
    );
    expect(calls).toBe(MAX_EVENT_PAGES);
    expect(log.truncated).toBe(true);
  });

  it("stops when a page makes no progress", async () => {
    let calls = 0;
    const stuck = EventPageSchema.parse({ run: "golden-1", events: [], next_after: 0 });
    const log = await loadRunEvents(
      {
        events: () => {
          calls += 1;
          return Promise.resolve(stuck);
        },
      },
      "golden-1",
    );
    expect(calls).toBe(1);
    expect(log.truncated).toBe(false);
  });
});

describe("wave-3 notices (Level 3, headless runs, lookback; contracts 4.5.0)", () => {
  const notices = runNotices(WAVE3_EVENTS);
  const of = (type: string) => notices.filter((n) => n.type === type);

  it("explains a failed Level-3 preflight and what to configure", () => {
    expect(of("merge.preflight")).toHaveLength(1);
    expect(of("merge.preflight")[0]).toMatchObject({
      tone: "warn",
      title: "Level 3 is not available: this run merges at Level 2",
    });
    expect(of("merge.preflight")[0]?.detail).toContain("required status check");
    expect(of("merge.preflight")[0]?.note).toMatch(/never changes repository settings/);
  });

  it("shows a passed preflight as nothing", () => {
    const ok = w3Event(95, "merge.preflight", {
      configured_level: 3,
      effective_level: 3,
      ok: true,
      policy: null,
    });
    expect(noticeForEvent(ok)).toBeNull();
  });

  it("shows auto-merge turned off, a red base CI and a revert for the feature", () => {
    expect(runNotices(WAVE3_EVENTS, "F-1").map((n) => n.type)).toEqual([
      "feature.reverted",
      "feature.post_merge_ci",
      "feature.auto_merge_disabled",
    ]);
    expect(of("feature.post_merge_ci")[0]).toMatchObject({
      tone: "danger",
      title: "Base CI failed after the merge",
      detail: "Failed required runs: ci / test",
    });
    expect(of("feature.reverted")[0]?.note).toMatch(/vtc merge-level restore/);
  });

  it("marks a red base CI resolved once a later poll of the same commit is green", () => {
    const green = w3Event(
      96,
      "feature.post_merge_ci",
      { merge_commit: "c".repeat(40), status: "green", runs: [] },
      { feature: "F-1" },
    );
    expect(noticeForEvent(green)).toBeNull();
    const ci = runNotices([...WAVE3_EVENTS, green]).find((n) => n.type === "feature.post_merge_ci");
    expect(ci?.resolved).toBe(true);
  });

  it("shows a headless run that did not finish and a preflight that stopped one", () => {
    expect(of("headless.ended")[0]).toMatchObject({
      tone: "danger",
      title: "Headless engineer run a-12 ended: Error: no output (idle timeout)",
    });
    expect(of("headless.preflight")[0]).toMatchObject({
      tone: "danger",
      title: "Auto-resume on codex did not start",
      detail: "Failed check: the host is not logged in. codex login status: not logged in",
    });
    expect(of("headless.preflight")[0]?.note).toMatch(/never retries/);
  });

  it("marks a failed preflight resolved by a later passing one on the same host", () => {
    const ok = w3Event(97, "headless.preflight", {
      host: "codex",
      purpose: "auto_resume",
      ok: true,
    });
    expect(
      runNotices([...WAVE3_EVENTS, ok]).find((n) => n.type === "headless.preflight")?.resolved,
    ).toBe(true);
  });

  it("keeps a failed preflight open when the later passing one had another purpose", () => {
    const other = w3Event(97, "headless.preflight", {
      host: "codex",
      purpose: "lookback_replay",
      ok: true,
    });
    expect(
      runNotices([...WAVE3_EVENTS, other]).find((n) => n.type === "headless.preflight")?.resolved,
    ).toBe(false);
  });

  it("marks a failed headless run resolved once a later run of the same step ends done", () => {
    const done = (task: string, role: string) =>
      w3Event(
        98,
        "headless.ended",
        { action_id: "a-30", outcome: "done", exit_code: 0, duration_ms: 60_000 },
        { role, host: "codex", task },
      );
    const ended = (events: readonly VtcEvent[]) =>
      runNotices(events).find((n) => n.type === "headless.ended")?.resolved;
    expect(ended(WAVE3_EVENTS)).toBe(false);
    expect(ended([...WAVE3_EVENTS, done("T-1", "engineer")])).toBe(true);
    expect(ended([...WAVE3_EVENTS, done("T-2", "engineer")])).toBe(false);
    expect(ended([...WAVE3_EVENTS, done("T-1", "qa")])).toBe(false);
  });

  it("resolves a failed run with no task by a later done run of that role on that host", () => {
    const run = (
      seq: number,
      outcome: "error" | "done",
      host: "claude-code" | "codex",
      task?: string,
    ) =>
      w3Event(
        seq,
        "headless.ended",
        {
          action_id: `a-${String(seq)}`,
          outcome,
          ...(outcome === "error" ? { cause: "timeout" } : {}),
          exit_code: null,
          duration_ms: 60_000,
        },
        { role: "architect", host, ...(task === undefined ? {} : { task }) },
      );
    const failed = run(90, "error", "codex");
    const resolved = (later: VtcEvent) =>
      runNotices([failed, later]).find((n) => n.seq === 90)?.resolved;
    expect(resolved(run(91, "done", "codex"))).toBe(true);
    expect(resolved(run(91, "done", "claude-code"))).toBe(false);
    expect(resolved(run(91, "done", "codex", "T-1"))).toBe(false);
  });

  it("shows a canary rollback", () => {
    expect(of("lookback.rolled_back")[0]).toMatchObject({
      tone: "warn",
      title: "Prompt canary rolled back for engineer on claude-code",
    });
  });

  it("ignores the wave-3 events that need no attention", () => {
    for (const e of WAVE3_EVENTS) {
      if (["gate.requested", "fact.waived", "lookback.dispatched"].includes(e.type)) {
        expect(noticeForEvent(e)).toBeNull();
      }
    }
  });
});

describe("prompt_selection incidents (AD-21; spine §5 readings 137 and 176)", () => {
  const cannotPin = (seq: number, task?: string) =>
    noticeEvent(
      seq,
      "incident.recorded",
      {
        kind: "prompt_selection",
        detail:
          "qa on claude-code: this target cannot take a pin until its role is switched (its agent carries its own editable section); the compiled default ran",
      },
      task === undefined ? {} : { task },
    );

  it("explains that the compiled default ran and when a target cannot take a pin", () => {
    expect(noticeForEvent(cannotPin(54))).toMatchObject({
      type: "incident.recorded",
      tone: "warn",
      title: "A pinned or canary prompt was not used",
      detail: expect.stringContaining("this target cannot take a pin") as unknown,
      note: expect.stringMatching(/compiled default prompt ran/) as unknown,
    });
    expect(noticeForEvent(cannotPin(54))?.note).toMatch(/until its role is switched/);
  });

  it("shows the same incident recorded again once, newest, with how often", () => {
    const thrown = noticeEvent(57, "incident.recorded", {
      kind: "prompt_selection",
      detail: "the prompt selector threw: pins.yaml is not valid YAML",
    });
    const notices = runNotices([cannotPin(54, "T-1"), cannotPin(55, "T-2"), cannotPin(56), thrown]);
    expect(notices.map((n) => [n.seq, n.repeats])).toEqual([
      [57, 1],
      [56, 3],
    ]);
  });

  it("never folds other incidents together", () => {
    const write = (seq: number) =>
      noticeEvent(seq, "incident.recorded", { kind: "checkout_write", detail: "x changed" });
    expect(runNotices([write(54), write(55)]).map((n) => n.repeats)).toEqual([1, 1]);
  });
});
