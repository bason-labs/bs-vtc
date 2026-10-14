/**
 * Claude Code's login state through `claude auth status --json` (AD-25 rule 3): exit 0 means
 * logged in; of the JSON only `loggedIn`, the `authMethod` label and whether `authMethod` or
 * `apiKeySource` names an API key are read (spine §5 reading 48, the same command `vtc doctor`
 * runs). Never a credential read (AD-9).
 *
 * Billing (D-bq, spine §5 reading 171): the subscription, unless the status reports an API key
 * (`authMethod` `api_key` or `apiKeyHelper`, or an `apiKeySource` such as `ANTHROPIC_API_KEY` or
 * `apiKeyHelper`); unknown (`null`) when the output cannot be read or names no login method.
 */
import type { HostBilling } from "@vtc/shared";
import type { AuthStatusCommand } from "../common/auth-status.js";
import { methodLabel } from "../common/auth-status.js";
import { isRecord, parseJsonObject, text } from "../common/json.js";
import { CLAUDE_BINARY, HOST } from "./command.js";

/** `api_key`, `apiKey`, `apiKeyHelper`, `ANTHROPIC_API_KEY`: a login billed to an API key. */
const API_KEY = /api[_ -]?key/iu;

const billingOf = (status: Record<string, unknown>): HostBilling | null => {
  const method = text(status.authMethod);
  const source = text(status.apiKeySource);
  if ([method, source].some((value) => value !== null && API_KEY.test(value))) return "api_key";
  return method === null ? null : "subscription";
};

export const CLAUDE_AUTH_STATUS: AuthStatusCommand = {
  host: HOST,
  command: { command: CLAUDE_BINARY, args: ["auth", "status", "--json"], env: {} },
  read: ({ stdout }) => {
    const status = parseJsonObject(stdout.trim());
    if (status === null || !isRecord(status)) {
      return { loggedOut: false, method: null, billing: null };
    }
    return {
      loggedOut: status.loggedIn === false,
      method: methodLabel(status.authMethod),
      billing: billingOf(status),
    };
  },
};
