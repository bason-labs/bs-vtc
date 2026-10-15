/**
 * The tool signal's source (D-cs; spine §5 reading 221 (1)): the normalised shapes of a role run's
 * shell calls, recorded on its `role.submitted.command_shapes` (`countCommandShapes`). A headless
 * run's shapes come from its adapter's stream (`ParsedStream.commandShapes`); an in-session
 * subagent's from the spool `vtc hook pre-tool-use` appends to in the engine's private directory
 * (`<vtcHome>/guard/<repo-key>/command-shapes.jsonl`, `COMMAND_SHAPE_SPOOL_FILE`), which no role
 * may write. {@link drainCommandShapeSpool} takes a dispatch's rows out of it: the row's agent is
 * the dispatch's (the host's `agent_type`, plugin namespace allowed), its `cwd` is inside the
 * dispatch's working directory, and it was written between the dispatch and now. What it took is
 * removed from the spool, with every line that does not parse and every row older than
 * {@link SPOOL_ROW_MAX_AGE_MS} (no dispatch can claim it any more); the rest stays for the runs
 * still in flight. Only the engine drains, under the run's lock.
 *
 * Known limit: a row names no dispatch, only its agent and `cwd`, so when several runs of one agent
 * are in flight in one working directory (the per-AC Spec Verifier calls, the three Visual QA
 * calls) the first of them to submit takes the rows of all of them, and a run working at the repo
 * root takes the rows of every task worktree under it. The tool signal counts distinct tasks, so
 * its facts hold; only the per-run `command_shapes` record can be misattributed.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync, renameSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  COMMAND_SHAPE_SPOOL_FILE,
  CommandShapeSpoolRowSchema,
  type CommandShape,
} from "@vtc/shared";
import { appendPrivateFile, readPrivateFile, removePrivateFile } from "./guard.js";

/** A spool row no dispatch claimed within this long is dropped (a run never lasts a day). */
export const SPOOL_ROW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SpoolMatch {
  /** The dispatch's agent names: its base name and the name its host was given (namespaced). */
  readonly agents: readonly string[];
  /** The dispatch's working directory (absolute). */
  readonly cwd: string;
  /** When it was dispatched (ISO). */
  readonly since: string;
}

const inside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const agentMatches = (agents: readonly string[], agent: string): boolean =>
  agents.some((a) => agent === a || agent.endsWith(`:${a}`));

/**
 * Takes the dispatch's rows out of the spool and returns their shapes, in the order they were
 * written (none when the spool is missing or holds none). The spool is first renamed to a private
 * drain file, an atomic move that takes it from the hook: a row the hook appends from then on
 * starts a fresh spool, so no rewrite can lose it. The rows the drain keeps are appended back to
 * the spool and the drain file removed. The one loss left: a hook that opened the spool before the
 * rename and writes after the drain read it (its row lands in the drain file); such a row is
 * telemetry only, and a hook write is a single `O_APPEND` write of one short line. Never throws:
 * a spool that cannot be moved gives no shapes and stays; a drain file that cannot be read or
 * written back loses its rows.
 */
export const drainCommandShapeSpool = (
  guardDir: string,
  match: SpoolMatch,
  now: Date,
): CommandShape[] => {
  const path = join(guardDir, COMMAND_SHAPE_SPOOL_FILE);
  const draining = `${path}.${randomBytes(6).toString("hex")}.drain`;
  try {
    if (!lstatSync(path).isFile()) return [];
    renameSync(path, draining);
  } catch {
    return [];
  }
  try {
    const text = readPrivateFile(draining) ?? "";
    // a line its writer never finished cannot be finished any more (its writer holds the old file)
    const end = text.lastIndexOf("\n");
    const complete = end < 0 ? "" : text.slice(0, end);
    const dirs = [...new Set([match.cwd, realOr(match.cwd)])];
    const since = Date.parse(match.since);
    const oldest = now.getTime() - SPOOL_ROW_MAX_AGE_MS;
    const claimed: { at: number; shape: CommandShape }[] = [];
    const kept: string[] = [];
    for (const line of complete === "" ? [] : complete.split("\n")) {
      let row;
      try {
        const parsed = CommandShapeSpoolRowSchema.safeParse(JSON.parse(line));
        row = parsed.success ? parsed.data : undefined;
      } catch {
        row = undefined;
      }
      const at = row === undefined ? Number.NaN : Date.parse(row.at);
      if (row === undefined || Number.isNaN(at) || at < oldest) continue;
      if (
        at >= since &&
        at <= now.getTime() &&
        agentMatches(match.agents, row.agent) &&
        dirs.some((d) => inside(d, row.cwd))
      ) {
        claimed.push({ at, shape: row.shape });
        continue;
      }
      kept.push(line);
    }
    // kept rows go back after any the hook appended meanwhile, so a later drain sorts by time
    if (kept.length > 0) {
      try {
        appendPrivateFile(path, kept.map((l) => `${l}\n`).join(""));
      } catch {
        // telemetry only: the kept rows are lost
      }
    }
    return claimed.sort((a, b) => a.at - b.at).map((c) => c.shape);
  } finally {
    removePrivateFile(draining);
  }
};
