/**
 * Claude Code's login state through `claude auth status --json` (AD-25 rule 3): exit 0 means
 * logged in; of the JSON only `loggedIn`, the `authMethod` label and whether `authMethod` or
 * `apiKeySource` names an API key are read (spine §5 reading 48, the same command `vtc doctor`
 * runs). Never a credential read (AD-9).
 *
 * Billing (D-bq, spine §5 reading 171): `api_key` when the status reports an API key (an
 * `authMethod` or `apiKeySource` that names an API-key environment variable or helper); the
 * subscription only for a known subscription login (`authMethod` `claude.ai` or `oauth_token`)
 * on Anthropic's own service (`apiProvider` absent or `firstParty`); otherwise unknown (`null`),
 * never a guess. A `third_party` login or a cloud `apiProvider` (Bedrock, Vertex, Foundry, a
 * gateway) bills that provider per token, not the subscription, so it is never `subscription`.
 */
import type { HostBilling } from "@vtc/shared";
import type { AuthStatusCommand } from "../common/auth-status.js";
import { methodLabel } from "../common/auth-status.js";
import { isRecord, parseJsonObject, text } from "../common/json.js";
import { CLAUDE_BINARY, HOST } from "./command.js";

/** `api_key`, `apiKey`, `apiKeyHelper` or an API-key environment variable: billed to an API key. */
const API_KEY = /api[_ -]?key/iu;

/** The `authMethod` labels of a Claude subscription login (claude.ai sign-in, `setup-token`). */
const SUBSCRIPTION_METHODS: ReadonlySet<string> = new Set(["claude.ai", "oauth_token"]);

/** Anthropic's own service; any other `apiProvider` bills a cloud account per token. */
const FIRST_PARTY = "firstParty";

const billingOf = (status: Record<string, unknown>): HostBilling | null => {
  const method = text(status.authMethod);
  const source = text(status.apiKeySource);
  if ([method, source].some((value) => value !== null && API_KEY.test(value))) return "api_key";
  const provider = status.apiProvider;
  if (provider !== undefined && provider !== null && provider !== FIRST_PARTY) return null;
  return method !== null && SUBSCRIPTION_METHODS.has(method) ? "subscription" : null;
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
