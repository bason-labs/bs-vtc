/**
 * Claude Code's login state through `claude auth status --json` (AD-25 rule 3): exit 0 means
 * logged in; of the JSON only `loggedIn`, the `authMethod` label, the `apiProvider` name and whether `authMethod` or
 * `apiKeySource` names an API key are read (spine §5 reading 48, the same command `vtc doctor`
 * runs). Never a credential read (AD-9).
 *
 * Billing (D-bq and D-ci, spine §5 readings 171 and 203), from what the status prints:
 * - `provider` when a third party bills: an `apiProvider` other than `firstParty` (Bedrock,
 *   Vertex, Foundry, a gateway; 2.1.299 also names `anthropicAws` and `mantle`) or the
 *   `third_party` method. It comes first, because that provider bills whatever API key the
 *   environment also names.
 * - `api_key` when the status reports an API key (an `authMethod` or `apiKeySource` that names an
 *   API-key environment variable or helper).
 * - `subscription` only for a first-party `claude.ai` login.
 * - Otherwise unknown (`null`), never a guess. That includes `oauth_token`: in 2.1.299 it covers
 *   every token source but `claude.ai` and the key helper (a `setup-token` login, but also
 *   `ANTHROPIC_AUTH_TOKEN` for a proxy and a profile token), and the status never says which.
 */
import type { HostBilling } from "@vtc/shared";
import type { AuthStatusCommand } from "../common/auth-status.js";
import { methodLabel } from "../common/auth-status.js";
import { isRecord, parseJsonObject, text } from "../common/json.js";
import { CLAUDE_BINARY, HOST } from "./command.js";

/** `api_key`, `apiKey`, `apiKeyHelper` or an API-key environment variable: billed to an API key. */
const API_KEY = /api[_ -]?key/iu;

/** The `authMethod` of a Claude subscription login: the claude.ai sign-in, nothing else. */
const SUBSCRIPTION_METHOD = "claude.ai";

/** The `authMethod` Claude prints for any login through a third-party provider. */
const THIRD_PARTY_METHOD = "third_party";

/** Anthropic's own service; any other `apiProvider` bills a cloud account or gateway. */
const FIRST_PARTY = "firstParty";

const billingOf = (status: Record<string, unknown>): HostBilling | null => {
  const method = text(status.authMethod);
  const source = text(status.apiKeySource);
  const provider = status.apiProvider;
  // a provider value that is not a plain name: unknown
  if (provider !== undefined && provider !== null && typeof provider !== "string") return null;
  if ((typeof provider === "string" && provider !== FIRST_PARTY) || method === THIRD_PARTY_METHOD) {
    return "provider";
  }
  if ([method, source].some((value) => value !== null && API_KEY.test(value))) return "api_key";
  return method === SUBSCRIPTION_METHOD ? "subscription" : null;
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
