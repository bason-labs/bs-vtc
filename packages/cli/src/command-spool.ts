/**
 * The tool signal's spool (D-cs; spine §5 reading 221, `@vtc/shared` signals.ts): for each shell
 * call of a VTC role agent in a Lead session, `vtc hook pre-tool-use` appends one
 * `CommandShapeSpoolRow` per shape of the command (`shellCallShapes` from `@vtc/adapters`, the
 * same shaping a headless run's stream gets, so a `bash -lc` wrapper counts as its script) to
 * `<vtcHome>/guard/<repo-key>/command-shapes.jsonl` (`core.guardDirFor`,
 * `COMMAND_SHAPE_SPOOL_FILE`), the engine's private directory, which no role may write. The engine
 * drains it into the dispatch's `role.submitted`.
 *
 * Only the shape is written: the program, its subcommand and a hash of the flag names, never the
 * command line, an argument value or a path. The file is opened `O_APPEND` (one write for all of a
 * call's rows), created 0600, never through a symlink (`O_NOFOLLOW`) and never as anything but a
 * regular file (`O_NONBLOCK`, so a FIFO in its place cannot hold the hook). Every failure is
 * swallowed by the caller: the spool never blocks a call.
 */
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { shellCallShapes } from "@vtc/adapters";
import { core } from "@vtc/engine";
import {
  COMMAND_SHAPE_SPOOL_FILE,
  CommandShapeSpoolRowSchema,
  type CommandShapeSpoolRow,
} from "@vtc/shared";

/** The host tools whose input is a shell command line (Claude Code's `Bash`). */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

/** The spool rows of one shell call, each checked against its schema; none for an empty line. */
export const spoolRowsOf = (input: {
  readonly command: string;
  readonly agent: string;
  readonly session?: string | undefined;
  readonly cwd: string;
  readonly at: Date;
}): CommandShapeSpoolRow[] => {
  if (!isAbsolute(input.cwd)) return [];
  const base = {
    v: 1 as const,
    at: input.at.toISOString(),
    agent: input.agent,
    ...(input.session === undefined || input.session === "" ? {} : { session: input.session }),
    cwd: resolve(input.cwd),
  };
  return shellCallShapes(input.command).flatMap((shape) => {
    const row = CommandShapeSpoolRowSchema.safeParse({ ...base, shape });
    return row.success ? [row.data] : [];
  });
};

const flag = (name: "O_NOFOLLOW" | "O_NONBLOCK"): number =>
  (constants as Partial<Record<string, number>>)[name] ?? 0;

/** Appends `rows` to the repo's spool in one write. Throws on any failure (the hook swallows it). */
export const appendSpoolRows = (
  vtcHome: string,
  repoRoot: string,
  rows: readonly CommandShapeSpoolRow[],
): void => {
  if (rows.length === 0) return;
  const dir = core.guardDirFor(vtcHome, repoRoot);
  core.ensurePrivateDir(dir);
  const fd = openSync(
    join(dir, COMMAND_SHAPE_SPOOL_FILE),
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      flag("O_NOFOLLOW") |
      flag("O_NONBLOCK"),
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${COMMAND_SHAPE_SPOOL_FILE} is not a file`);
    writeSync(fd, Buffer.from(rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8"));
  } finally {
    closeSync(fd);
  }
};
