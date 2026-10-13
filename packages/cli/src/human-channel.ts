/**
 * The cli as a human channel (D-an, spine §5 reading 71). The human-only engine tools
 * (`HUMAN_ONLY_TOOLS`: approve, answer, change_request) record a human decision. A bare
 * `{client: "cli"}` hello is never proof of a human, so:
 * - the cli's ordinary engine client (`CommandContext.engine`) refuses them itself
 *   ({@link guardHumanOnly}): it never carries the install token;
 * - the one way the cli may call them is a hello built by {@link humanCliHello}: only in an
 *   interactive terminal, only after the human confirmed, and only to a daemon that knows the
 *   field (contracts 4.3.0+). It is the only cli source that puts `install_token` in a hello.
 * No cli command calls a human-only tool today (approval happens in the Lead chat, AD-5 rule 5).
 */
import {
  CONTRACTS_VERSION,
  humanChannelRequired,
  isHumanOnlyTool,
  type EngineClient,
  type EngineDiscovery,
  type EngineSocketHello,
  type HumanOnlyToolName,
} from "@vtc/shared";
import { contractsAtLeast, HELLO_FIELDS_SINCE } from "./bridge.js";

/** `client` without the human-only tools: a call to one is refused before it is sent. */
export const guardHumanOnly = (client: EngineClient): EngineClient => ({
  call: (tool, input) =>
    isHumanOnlyTool(tool)
      ? Promise.reject(new Error(humanChannelRequired(tool)))
      : client.call(tool, input),
  close: () => client.close(),
});

export interface HumanChannelDeps {
  /** stdin and stdout are terminals (`interactiveTerminal`). */
  readonly interactive: () => boolean;
  /** Asks the human at the terminal (`ttyConfirm`). */
  readonly confirm: (question: string) => Promise<boolean>;
  /** The install token (`readInstallToken`), read only once the human confirmed. */
  readonly installToken: () => string;
}

/**
 * The hello of a cli connection that may call `tool`: `what` (e.g. "approve the plan of run
 * r1") is put to the human first. Throws unless the terminal is interactive, the human said yes
 * and the daemon speaks contracts 4.3.0 or later.
 */
export const humanCliHello = async (
  tool: HumanOnlyToolName,
  what: string,
  daemon: Pick<EngineDiscovery, "contracts_version">,
  deps: HumanChannelDeps,
): Promise<EngineSocketHello> => {
  if (!deps.interactive())
    throw new Error(`${humanChannelRequired(tool)}: run it yourself in an interactive terminal`);
  if (!contractsAtLeast(daemon.contracts_version, HELLO_FIELDS_SINCE))
    throw new Error(
      `the running engine speaks contracts ${daemon.contracts_version}, which takes no human channel from the cli: run vtc engine --stop in the repo, then try again`,
    );
  if (!(await deps.confirm(`You are about to ${what} (${tool}). Is this your decision?`)))
    throw new Error(`${tool} not confirmed: nothing was sent`);
  return {
    v: 1,
    client: "cli",
    host: null,
    contracts_version: CONTRACTS_VERSION,
    install_token: deps.installToken(),
  };
};
