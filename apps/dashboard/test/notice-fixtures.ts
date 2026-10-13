import { EventSchema, type VtcEvent, type VtcEventInput } from "@vtc/shared";
import { GOLDEN_RUN } from "../scripts/fixture-routes.ts";
import { readFixture } from "./fixtures";

/** One validated event of the golden run, as the engine would log it. */
export const noticeEvent = (
  seq: number,
  type: string,
  data: Record<string, unknown>,
  extra: Partial<VtcEventInput> = {},
): VtcEvent =>
  EventSchema.parse({
    v: 1,
    seq,
    ts: `2026-10-13T10:${String(seq).padStart(2, "0")}:00.000Z`,
    run: GOLDEN_RUN,
    type,
    actor: "engine",
    data,
    ...extra,
  });

const SHA = "a".repeat(40);

/**
 * The typed events wave 1 added (contracts 4.1.0) that Flow Studio surfaces as run notices: a
 * failed push (later retried), a failed PR update, both new incident kinds and the no-remote
 * merge-level downgrade.
 */
export const NOTICE_EVENTS: readonly VtcEvent[] = [
  noticeEvent(45, "run.merge_level_changed", { from: 2, to: 1, reason: "no_remote" }, {}),
  noticeEvent(
    46,
    "branch.push_failed",
    { branch: "vtc/F-1", detail: "fatal: unable to access remote: Could not resolve host" },
    { feature: "F-1" },
  ),
  noticeEvent(47, "branch.pushed", { branch: "vtc/F-1", commit: SHA }, { feature: "F-1" }),
  noticeEvent(
    48,
    "feature.pr_failed",
    { detail: "gh: HTTP 502 while opening the draft PR" },
    { feature: "F-1" },
  ),
  noticeEvent(49, "incident.recorded", {
    kind: "config_changed",
    detail: ".vtc/project.yaml changed during the run",
  }),
  noticeEvent(50, "incident.recorded", {
    kind: "checkout_write",
    detail: "src/auth/reset.ts changed in the checkout and no role wrote it",
    evidence: [{ type: "file", ref: "src/auth/reset.ts" }],
  }),
];

/** The golden run's event page with {@link NOTICE_EVENTS} appended. */
export const eventPageWithNotices = (): unknown => {
  const page = readFixture("events") as { run: string; events: unknown[]; next_after: null };
  return { ...page, events: [...page.events, ...NOTICE_EVENTS] };
};
