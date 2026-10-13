/**
 * One `vtc` subcommand (AD-19). Each lives in its own file, owned by the team named in its
 * header (AD-15). Frozen: commands receive their arguments and a {@link CommandContext} and
 * resolve to the process exit code.
 */
import type { EngineClient } from "@vtc/shared";

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface CommandContext {
  readonly io: CliIo;
  /** Absolute working directory the command was started in. */
  readonly cwd: string;
  /** Absolute VTC home (`~/.vtc`, or `$VTC_HOME`). */
  readonly vtcHome: string;
  /**
   * An MCP client of the running daemon for the repo containing `cwd` (AD-12, AD-19), opened on
   * first use. Control commands (`pause`, `resume`, `status`) use it; it never goes over HTTP.
   */
  readonly engine: () => Promise<EngineClient>;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  /** `args` excludes the command name. Resolves to the exit code. */
  run(args: readonly string[], ctx: CommandContext): Promise<number>;
}

/** Exit code of a command whose implementation has not landed yet. */
export const EXIT_NOT_IMPLEMENTED = 2;

/** A command whose owner has not implemented it yet: reports that and exits 2. */
export const pendingCommand = (name: string, summary: string): CommandSpec => ({
  name,
  summary,
  run: (_args, ctx) => {
    ctx.io.err(`vtc ${name}: not implemented yet`);
    return Promise.resolve(EXIT_NOT_IMPLEMENTED);
  },
});
