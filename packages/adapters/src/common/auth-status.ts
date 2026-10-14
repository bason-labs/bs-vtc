/**
 * `HostAdapter.authStatus()` (AD-25 rule 3, AD-9): the host's login state, read only through the
 * host's own sanctioned status command (`claude auth status --json`, `codex login status`). Exit 0
 * means logged in. VTC never opens a credential file or the keychain; the command's output is
 * reduced to a fixed method label here and nothing else of it (account names, masked keys) is
 * passed on, plus who pays for role runs on that login (`billing`, D-bq, spine §5 reading 171: an
 * API-key login is allowed and shown with a warning; `null` when the output does not say). A
 * command that cannot start, is killed or hangs leaves the state unknown (`null`), never `false`.
 */
import { homedir } from "node:os";
import {
  HostAuthStatusSchema,
  type HostAuthStatus,
  type HostBilling,
  type HostCommand,
  type HostId,
} from "@vtc/shared";
import { createCommandOutputRunner } from "./command-output.js";
import type { Spawner } from "./process.js";

/** How one host reports its login. */
export interface AuthStatusCommand {
  readonly host: HostId;
  readonly command: HostCommand;
  /**
   * Pure: from a finished command's output, whether it says logged out despite exit 0 (`false`),
   * the login method as a short label, or `null`, and who pays for role runs on that login
   * (`HostBilling`, D-bq), or `null` when the output does not say.
   */
  readonly read: (output: { readonly stdout: string; readonly stderr: string }) => {
    readonly loggedOut: boolean;
    readonly method: string | null;
    readonly billing: HostBilling | null;
  };
}

export interface AuthStatusOptions {
  readonly spawner: Spawner;
  readonly now: () => Date;
  /** How long the status command may run before it is killed. Default 20 s. */
  readonly timeoutMs?: number;
  /**
   * The status command's working directory. Default: the user's home, which only the user can
   * write. Never the OS temp directory: other local users and roles (D-ag) can write there, and a
   * file planted in the working directory must never be what runs (§15).
   */
  readonly cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** The most output read from a status command; the rest is dropped. */
const MAX_OUTPUT_CHARS = 16_000;

/** A method label as the host prints it ("claude.ai", "ChatGPT"): short and plain, or nothing. */
export const methodLabel = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/u.test(value) ? value : null;

/** Runs status commands and stops any still running on `dispose()` (§15: no orphans). */
export const createAuthStatusRunner = (options: AuthStatusOptions) => {
  const runner = createCommandOutputRunner({
    spawner: options.spawner,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxChars: MAX_OUTPUT_CHARS,
  });
  return {
    async check(status: AuthStatusCommand): Promise<HostAuthStatus> {
      // the method and billing are only ever reported for a login the command confirmed
      const result = (
        logged_in: boolean | null,
        method: string | null,
        billing: HostBilling | null = null,
      ): HostAuthStatus =>
        HostAuthStatusSchema.parse({
          host: status.host,
          logged_in,
          method: logged_in === true ? method : null,
          billing: logged_in === true ? billing : null,
          checked_at: options.now().toISOString(),
        });
      // a directory only the user can write, and no repo's: no planted file or repo settings
      // are anywhere near the status command
      const output = await runner.run(status.command, options.cwd ?? homedir());
      if (output.kind === "failed") return result(null, null);
      if (output.code !== 0) return result(false, null);
      const read = status.read({ stdout: output.stdout, stderr: output.stderr });
      return read.loggedOut ? result(false, null) : result(true, read.method, read.billing);
    },
    dispose(): void {
      runner.dispose();
    },
  };
};
