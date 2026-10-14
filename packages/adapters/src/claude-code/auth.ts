/**
 * Claude Code's login state through `claude auth status --json` (AD-25 rule 3): exit 0 means
 * logged in; of the JSON only `loggedIn` and the `authMethod` label are read (spine §5 reading 48,
 * the same command `vtc doctor` runs). Never a credential read (AD-9).
 */
import type { AuthStatusCommand } from "../common/auth-status.js";
import { methodLabel } from "../common/auth-status.js";
import { isRecord, parseJsonObject } from "../common/json.js";
import { CLAUDE_BINARY, HOST } from "./command.js";

export const CLAUDE_AUTH_STATUS: AuthStatusCommand = {
  host: HOST,
  command: { command: CLAUDE_BINARY, args: ["auth", "status", "--json"], env: {} },
  read: ({ stdout }) => {
    const status = parseJsonObject(stdout.trim());
    if (status === null || !isRecord(status)) return { loggedOut: false, method: null };
    return { loggedOut: status.loggedIn === false, method: methodLabel(status.authMethod) };
  },
};
