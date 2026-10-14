/**
 * Runtime argv guards for engine-launched runs (AD-9, AD-25 rules 1–2). The adapter safety
 * contract asserts these on every argv a test builds; the launcher checks them again on the argv
 * it is about to start, so a profile or session from anywhere else can never widen a real run.
 */
import {
  findDisallowedHostArgs,
  findForbiddenHostArgs,
  headlessIsolationGaps,
  type HostCommand,
  type HostId,
} from "@vtc/shared";

/** An argument as it appears in a refusal: short, so a settings document is never echoed whole. */
const shown = (arg: string): string => (arg.length > 60 ? `${arg.slice(0, 57)}...` : arg);

/**
 * Pure: why `command` must not start as a headless run on `host`, empty when nothing is wrong:
 * an AD-9 marker in the binary, argv or environment names, a disallowed flag (no API-key mode, no
 * automatic approver), or a missing isolation flag.
 */
export const headlessArgvProblems = (host: HostId, command: HostCommand): string[] => [
  ...findForbiddenHostArgs([command.command, ...command.args, ...Object.keys(command.env)]).map(
    (arg) => `forbidden ${shown(arg)}`,
  ),
  ...findDisallowedHostArgs(command.args).map((arg) => `disallowed ${shown(arg)}`),
  ...headlessIsolationGaps(host, command.args).map((gap) => `missing ${gap}`),
];

/**
 * Pure: the sandbox profile's `cliArgs` as `<flag> <value>` pairs whose flags are all in
 * `allowed` (the ones the host's own `sandboxProfile` emits). Throws otherwise, so a profile can
 * never repeat an isolation flag the command sets itself (most parsers let a later flag win) or
 * add one of its own.
 */
export const checkProfileArgs = (
  host: HostId,
  cliArgs: readonly string[],
  allowed: readonly string[],
): void => {
  const flags = cliArgs.filter((_, i) => i % 2 === 0);
  const extra = flags.filter((flag) => !allowed.includes(flag));
  if (cliArgs.length % 2 !== 0 || extra.length > 0) {
    throw new Error(
      `refusing a headless ${host} run: its sandbox profile may only pass ${allowed.join(", ")} with a value each${
        extra.length === 0 ? "" : `, got ${extra.map(shown).join(", ")}`
      }`,
    );
  }
};

/** A host session id as both hosts print them (UUIDs): never empty, never starting with `-`. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

/**
 * Throws unless `id` is a plain session id, so a stored `SessionRef` can never be read as an
 * option by the host's parser (Claude's `--resume` takes an optional value).
 */
export const checkSessionId = (host: HostId, id: string): void => {
  if (!SESSION_ID.test(id)) {
    throw new Error(
      `refusing to resume a ${host} session: ${JSON.stringify(shown(id))} is not a session id`,
    );
  }
};
