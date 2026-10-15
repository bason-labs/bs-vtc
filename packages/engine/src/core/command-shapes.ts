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
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  COMMAND_SHAPE_SPOOL_FILE,
  CommandShapeSpoolRowSchema,
  type CommandShape,
} from "@vtc/shared";
import { readPrivateFile, writePrivateFile } from "./guard.js";

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
 * Takes the dispatch's rows out of the spool and returns their shapes, in order (none when the
 * spool is missing or holds none). Never throws: a spool that cannot be read or rewritten gives
 * what it could read, and a rewrite that would lose a row appended meanwhile is skipped.
 */
export const drainCommandShapeSpool = (
  guardDir: string,
  match: SpoolMatch,
  now: Date,
): CommandShape[] => {
  const path = join(guardDir, COMMAND_SHAPE_SPOOL_FILE);
  const text = readPrivateFile(path);
  if (text === null || text === "") return [];
  const end = text.lastIndexOf("\n");
  // a line still being written (no newline yet) stays as it is
  const complete = end < 0 ? "" : text.slice(0, end);
  const dirs = [...new Set([match.cwd, realOr(match.cwd)])];
  const since = Date.parse(match.since);
  const oldest = now.getTime() - SPOOL_ROW_MAX_AGE_MS;
  const shapes: CommandShape[] = [];
  const kept: string[] = [];
  let changed = false;
  for (const line of complete === "" ? [] : complete.split("\n")) {
    let row;
    try {
      const parsed = CommandShapeSpoolRowSchema.safeParse(JSON.parse(line));
      row = parsed.success ? parsed.data : undefined;
    } catch {
      row = undefined;
    }
    const at = row === undefined ? Number.NaN : Date.parse(row.at);
    if (row === undefined || Number.isNaN(at) || at < oldest) {
      changed = true;
      continue;
    }
    if (
      at >= since &&
      at <= now.getTime() &&
      agentMatches(match.agents, row.agent) &&
      dirs.some((d) => inside(d, row.cwd))
    ) {
      shapes.push(row.shape);
      changed = true;
      continue;
    }
    kept.push(line);
  }
  if (!changed) return shapes;
  try {
    // rows the hook appended since the read stay (they are past `text`)
    const current = readPrivateFile(path) ?? "";
    if (!current.startsWith(text)) return shapes;
    const rest = current.slice(end + 1);
    writePrivateFile(path, `${kept.map((l) => `${l}\n`).join("")}${rest}`);
  } catch {
    // the rows stay; the next drain or the age limit takes them
  }
  return shapes;
};
