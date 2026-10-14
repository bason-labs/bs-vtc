/**
 * Codex's login state through `codex login status` (AD-25 rule 3): exit 0 means logged in. The
 * output names the kind of login ("Logged in using ChatGPT", or an API key with a masked key);
 * only that kind becomes the method label, never the rest of the line. Never a credential read
 * (AD-9).
 */
import type { AuthStatusCommand } from "../common/auth-status.js";
import { CODEX_BINARY, HOST } from "./command.js";

const KINDS: readonly (readonly [RegExp, string])[] = [
  [/logged in using chatgpt/iu, "ChatGPT"],
  [/logged in using an api key/iu, "API key"],
];

export const CODEX_AUTH_STATUS: AuthStatusCommand = {
  host: HOST,
  command: { command: CODEX_BINARY, args: ["login", "status"], env: {} },
  read: ({ stdout, stderr }) => {
    const output = `${stdout}\n${stderr}`;
    return {
      loggedOut: /not logged in/iu.test(output),
      method: KINDS.find(([pattern]) => pattern.test(output))?.[1] ?? null,
    };
  },
};
