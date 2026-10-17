/**
 * Loading every run of a repo from `.vtc/runs/<run>/events.jsonl` (AD-7 rule 5): the engine
 * rebuilds its state from the logs on start, and snapshot mode serves the same projection
 * without a lock (AD-5 rule 7). Reports what `parseEventLog` reported, so the caller can turn a
 * damaged log into an incident (§15).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventLogPath, parseEventLog, RunIdSchema } from "@vtc/shared";
import { projectRun, type RunState } from "./state.js";

export interface LoadedRun {
  readonly state: RunState;
  readonly invalidLines: readonly number[];
  readonly strippedLines: readonly number[];
  readonly truncatedTail: boolean;
}

/** Every run with at least one valid event, oldest first (by `started_at`, then id). */
export const loadRuns = (repoRoot: string): LoadedRun[] => {
  const dir = join(repoRoot, ".vtc", "runs");
  if (!existsSync(dir)) return [];
  const loaded: LoadedRun[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RunIdSchema.safeParse(entry.name).success) continue;
    const path = join(repoRoot, eventLogPath(entry.name));
    if (!existsSync(path)) continue;
    const parsed = parseEventLog(readFileSync(path, "utf8"));
    const events = parsed.events.filter((e) => e.run === entry.name);
    if (events.length === 0) continue;
    loaded.push({
      state: projectRun(events),
      invalidLines: parsed.invalidLines,
      strippedLines: parsed.strippedLines,
      truncatedTail: parsed.truncatedTail,
    });
  }
  return loaded.sort(
    (a, b) =>
      a.state.run.started_at.localeCompare(b.state.run.started_at) ||
      a.state.id.localeCompare(b.state.id),
  );
};
