/** The command line of `live:check` (scripts/live-check.ts). Pure. */
import type { RoleTools } from "@vtc/shared";

export const LIVE_CHECK_TARGETS = ["claude-code", "codex", "codex-usage", "auth"] as const;
export type LiveCheckTarget = (typeof LIVE_CHECK_TARGETS)[number];

const PROFILES: readonly RoleTools["profile"][] = ["read_only", "write_scoped", "code_sandboxed"];

export interface LiveCheckArgs {
  readonly target: LiveCheckTarget;
  readonly resume: boolean;
  readonly model?: string;
  readonly profile: RoleTools["profile"];
  readonly pluginDir?: string;
  /** Write the redacted stream here (`*.resume*` beside it for the resumed run). */
  readonly record?: string;
  /** `SpawnRoleRequest.maxTurns` (Claude only): `1` records a turn-cap stream. */
  readonly maxTurns?: number;
  /** Stop the run with `HeadlessRun.kill()` this long after it starts: records a kill stream. */
  readonly killAfterMs?: number;
  /** Run only when the host says it is signed out: records an auth-failure stream. */
  readonly signedOut: boolean;
}

const VALUE_FLAGS = [
  "--model",
  "--profile",
  "--plugin-dir",
  "--record",
  "--max-turns",
  "--kill-after",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

const positiveInteger = (flag: string, text: string): number => {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} needs a positive integer, got ${JSON.stringify(text)}`);
  }
  return value;
};

export const parseLiveCheckArgs = (argv: readonly string[]): LiveCheckArgs => {
  const [first, ...rest] = argv;
  const targetText = first === undefined || first.startsWith("--") ? "codex-usage" : first;
  const flags = first === undefined || first.startsWith("--") ? argv : rest;
  const target = LIVE_CHECK_TARGETS.find((t) => t === targetText);
  if (target === undefined) {
    throw new Error(`unknown target ${targetText}: use ${LIVE_CHECK_TARGETS.join(", ")}`);
  }
  const values: Partial<Record<ValueFlag, string>> = {};
  let resume = false;
  let signedOut = false;
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i] ?? "";
    if (flag === "--resume") resume = true;
    else if (flag === "--signed-out") signedOut = true;
    else {
      const known = VALUE_FLAGS.find((f) => f === flag);
      if (known === undefined) throw new Error(`unknown flag ${flag}`);
      const value = flags[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${known} needs a value`);
      }
      values[known] = value;
      i += 1;
    }
  }
  const profileText = values["--profile"] ?? "read_only";
  const profile = PROFILES.find((p) => p === profileText);
  if (profile === undefined) {
    throw new Error(`unknown profile ${profileText}: use ${PROFILES.join(", ")}`);
  }
  const maxTurnsText = values["--max-turns"];
  const maxTurns =
    maxTurnsText === undefined ? undefined : positiveInteger("--max-turns", maxTurnsText);
  if (maxTurns !== undefined && target === "codex") {
    throw new Error("Codex has no turn cap of its own (§12.1): --max-turns is for claude-code");
  }
  const killText = values["--kill-after"];
  const model = values["--model"];
  const pluginDir = values["--plugin-dir"];
  const record = values["--record"];
  return {
    target,
    resume,
    ...(model === undefined ? {} : { model }),
    profile,
    ...(pluginDir === undefined ? {} : { pluginDir }),
    ...(record === undefined ? {} : { record }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(killText === undefined ? {} : { killAfterMs: positiveInteger("--kill-after", killText) }),
    signedOut,
  };
};
