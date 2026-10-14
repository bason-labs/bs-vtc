/**
 * Human edits (spec §13 improvement loop step 1: "attributed failures from the training split,
 * plus human edit diffs"). Pure, over run events in log order.
 *
 * A human edit is an artifact a role submitted (`role.submitted.artifacts`, with its SHA-256)
 * that a human gate then froze (`gate.approved.frozen`, actor `human`) at another SHA-256, with
 * no role submitting that path in between: the human (or the Lead on their behalf) changed the
 * role's work before approving it. The edit is credited to the dispatch that last wrote the path
 * in that run, and carries that dispatch's prompt version and split, so the lookback role sees
 * only train-split edits of the version under review.
 *
 * The submitted SHA-256 is the engine's own only where its submit path hashes the artifact's bytes
 * (isolated and advisor roles today); elsewhere it is what the role reported. A role reporting a
 * wrong one can make up an edit of its own work: the lookback role then reads a made-up "human
 * edit", which may mislead its proposal but blames nothing (edits are shown to the lookback role,
 * never counted in scorecards or attributions, and a proposal still faces replay and the canary).
 *
 * The events name the two versions by SHA only; the diff text comes from the injected reader of
 * `lookbackAtRunEnd` (git is outside this module, AD-21).
 */
import {
  isEventOfType,
  readEventData,
  type HumanGateId,
  type PromptVersionRef,
  type VtcEvent,
} from "@vtc/shared";
import { buildTraces, traceRef, traceSlug, traceSplit, type LockedShaFor } from "./traces.js";

/** Most human edits one lookback dispatch reads (the newest). */
export const LOOKBACK_MAX_HUMAN_EDITS = 10;

/** Longest diff text of one edit a lookback dispatch reads. */
export const HUMAN_EDIT_DIFF_MAX_CHARS = 8000;

export interface HumanEdit {
  /** The run-qualified slug of the dispatch that wrote the file ({@link traceSlug}). */
  readonly id: string;
  readonly run: string;
  /** `role.dispatched.action_id` of that dispatch. */
  readonly trace: string;
  /** `seq` of the approval that froze the edited file. */
  readonly seq: number;
  readonly prompt: PromptVersionRef;
  readonly split: "train" | "holdout";
  readonly path: string;
  /** What the role submitted. */
  readonly role_sha256: string;
  /** What the human gate froze. */
  readonly human_sha256: string;
  readonly gates: readonly HumanGateId[];
}

/** Every human edit in the events, in log order. Dispatches with no prompt version are skipped. */
export const humanEdits = (
  events: readonly VtcEvent[],
  lockedShaFor: LockedShaFor,
): HumanEdit[] => {
  const traces = new Map(buildTraces(events, lockedShaFor).map((t) => [traceRef(t), t]));
  /** `run\npath` → the dispatch that last submitted it and the SHA it submitted. */
  const written = new Map<string, { run: string; trace: string; sha: string }>();
  const edits: HumanEdit[] = [];
  for (const event of events) {
    if (isEventOfType(event, "role.submitted")) {
      const data = readEventData(event);
      for (const artifact of data.artifacts) {
        if (artifact.sha256 === undefined) continue;
        written.set(`${event.run}\n${artifact.path}`, {
          run: event.run,
          trace: data.action_id,
          sha: artifact.sha256,
        });
      }
      continue;
    }
    if (!isEventOfType(event, "gate.approved") || event.actor !== "human") continue;
    const data = readEventData(event);
    for (const frozen of data.frozen) {
      const key = `${event.run}\n${frozen.path}`;
      const wrote = written.get(key);
      if (wrote === undefined) continue;
      written.delete(key);
      if (wrote.sha === frozen.sha256) continue;
      const prompt = traces.get(traceRef(wrote))?.prompt;
      if (prompt === undefined) continue;
      edits.push({
        id: traceSlug(wrote),
        run: wrote.run,
        trace: wrote.trace,
        seq: event.seq,
        prompt,
        split: traceSplit(wrote),
        path: frozen.path,
        role_sha256: wrote.sha,
        human_sha256: frozen.sha256,
        gates: data.gates,
      });
    }
  }
  return edits;
};

/** Cuts a diff to {@link HUMAN_EDIT_DIFF_MAX_CHARS}, saying so. */
export const capDiff = (diff: string): string => {
  if (diff.length <= HUMAN_EDIT_DIFF_MAX_CHARS) return diff;
  const marker = "\n…[diff cut]";
  return `${diff.slice(0, HUMAN_EDIT_DIFF_MAX_CHARS - marker.length)}${marker}`;
};
