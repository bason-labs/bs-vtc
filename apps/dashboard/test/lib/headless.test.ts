import { describe, expect, it } from "vitest";
import { AutoResumeCheckSchema, HostErrorCauseSchema } from "@vtc/shared";
import { HEADLESS_CAUSES, headlessRuns, PREFLIGHT_CHECKS } from "@/lib/headless";
import { HEADLESS_EVENTS, w3Event } from "../wave3-fixtures";

describe("headlessRuns (headless.* events and StatusResult.headless_runs, AD-25)", () => {
  it("lists engine-launched role runs newest first with how each ended", () => {
    const runs = headlessRuns(HEADLESS_EVENTS);
    expect(runs.map((r) => [r.actionId, r.role, r.host, r.task, r.status.label])).toEqual([
      ["a-13", "qa", "codex", "T-2", "Running"],
      ["a-12", "engineer", "codex", "T-1", "Error: no output (idle timeout)"],
    ]);
    expect(runs[0]?.detail).toBe("Resumes session sess-9 · limits 60 min, idle 10 min");
    expect(runs[1]?.detail).toBe("pid 4242 · limits 60 min, idle 10 min · ran 10 min 15 s");
  });

  it("adds runs the engine reports in flight that the log has not shown yet", () => {
    const runs = headlessRuns(HEADLESS_EVENTS, [
      {
        action_id: "a-20",
        role: "architect",
        host: "claude-code",
        pid: 77,
        started_at: "2026-10-13T12:00:00.000Z",
      },
      {
        action_id: "a-13",
        role: "qa",
        host: "codex",
        pid: null,
        started_at: "2026-10-13T11:15:00.000Z",
      },
    ]);
    expect(runs.map((r) => r.actionId)).toEqual(["a-20", "a-13", "a-12"]);
    expect(runs[0]).toMatchObject({ role: "architect", task: null });
    expect(runs[0]?.status.label).toBe("Running");
  });

  it("does not call a start with no end running once the live engine stops reporting it", () => {
    const runs = headlessRuns(HEADLESS_EVENTS, []);
    expect(runs.find((r) => r.actionId === "a-13")?.status).toEqual({
      label: "No end recorded",
      tone: "warn",
    });
  });

  it("says a start with no end did not finish once the run finished", () => {
    const finished = w3Event(90, "run.finished", { outcome: "done" });
    const status = headlessRuns([...HEADLESS_EVENTS, finished]).find(
      (r) => r.actionId === "a-13",
    )?.status;
    expect(status).toEqual({ label: "Did not finish", tone: "warn" });
  });

  it("keeps a start with no end running while the live engine reports it", () => {
    const runs = headlessRuns(HEADLESS_EVENTS, [
      {
        action_id: "a-13",
        role: "qa",
        host: "codex",
        pid: null,
        started_at: "2026-10-13T11:15:00.000Z",
      },
    ]);
    expect(runs.find((r) => r.actionId === "a-13")?.status.live).toBe(true);
  });

  it("names every cause and preflight check", () => {
    for (const c of HostErrorCauseSchema.options) expect(HEADLESS_CAUSES[c]).not.toBe("");
    for (const c of AutoResumeCheckSchema.options) expect(PREFLIGHT_CHECKS[c]).not.toBe("");
  });
});
