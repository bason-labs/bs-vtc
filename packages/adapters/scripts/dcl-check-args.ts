/** The command line of `live:dcl` (scripts/dcl-check.ts, spine §5 reading 206). Pure. */

export const DCL_TARGETS = [
  "codex-web",
  "codex-precedence",
  "codex-mcp",
  "codex-plugin",
  "claude-arm",
] as const;
export type DclTarget = (typeof DCL_TARGETS)[number];

/**
 * The `web_search` modes the Codex check may run (D-cl: "each candidate mode"). `live` is not a
 * candidate: D-cf never emits it, so the check never asks for it either.
 */
export const DCL_WEB_SEARCH_MODES = ["cached", "indexed", "disabled"] as const;
export type DclWebSearchMode = (typeof DCL_WEB_SEARCH_MODES)[number];

/** The role sandboxes a `host_web` role can run under on Codex (never `code_sandboxed`). */
export const DCL_PROFILES = ["read_only", "write_scoped"] as const;
export type DclProfile = (typeof DCL_PROFILES)[number];

export interface DclArgs {
  readonly target: DclTarget;
  /** Where the check writes what it saw (raw and redacted); required, never inside the repo. */
  readonly out: string;
  /** `codex-web` only. Default `cached`. */
  readonly mode: DclWebSearchMode;
  /** `codex-web` only. Default `write_scoped` (the Research Analyst's profile). */
  readonly profile: DclProfile;
  /**
   * `codex-web` only: ask the role to open this exact URL (one no index can hold, e.g. with a
   * fresh random path) instead of searching the news, to see whether the mode fetches a page the
   * model picks.
   */
  readonly open?: string;
  /** `claude-arm` only: the compiled plugin to copy into the arm. Default: the repo's build. */
  readonly pluginDir?: string;
  /** `claude-arm` only: the model id. Default `haiku`, the engine's low tier. */
  readonly model?: string;
}

const pick = <T extends string>(flag: string, text: string, options: readonly T[]): T => {
  const found = options.find((option) => option === text);
  if (found === undefined) {
    throw new Error(`${flag} must be one of ${options.join(", ")}, got ${JSON.stringify(text)}`);
  }
  return found;
};

const VALUE_FLAGS = ["--out", "--mode", "--profile", "--open", "--plugin-dir", "--model"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

/** Which flags each target takes besides `--out`. */
const TARGET_FLAGS: Readonly<Record<DclTarget, readonly ValueFlag[]>> = {
  "codex-web": ["--mode", "--profile", "--open"],
  "codex-precedence": [],
  "codex-mcp": [],
  "codex-plugin": ["--plugin-dir"],
  "claude-arm": ["--plugin-dir", "--model"],
};

export const parseDclArgs = (argv: readonly string[]): DclArgs => {
  const [first, ...flags] = argv;
  if (first === undefined) throw new Error(`name a check: ${DCL_TARGETS.join(", ")}`);
  const target = pick("the check", first, DCL_TARGETS);
  const values: Partial<Record<ValueFlag, string>> = {};
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i] ?? "";
    const known = VALUE_FLAGS.find((f) => f === flag);
    if (known === undefined) throw new Error(`unknown flag ${flag}`);
    if (known !== "--out" && !TARGET_FLAGS[target].includes(known)) {
      throw new Error(`${known} is not a flag of ${target}`);
    }
    const value = flags[i + 1];
    if (value === undefined || value.startsWith("--") || value === "") {
      throw new Error(`${known} needs a value`);
    }
    values[known] = value;
  }
  const out = values["--out"];
  if (out === undefined) throw new Error("--out <dir> is required: where the check writes");
  const pluginDir = values["--plugin-dir"];
  const model = values["--model"];
  const open = values["--open"];
  if (open !== undefined && !/^https:\/\/[^\s]+$/u.test(open)) {
    throw new Error("--open needs an https URL");
  }
  return {
    target,
    out,
    mode: pick("--mode", values["--mode"] ?? "cached", DCL_WEB_SEARCH_MODES),
    profile: pick("--profile", values["--profile"] ?? "write_scoped", DCL_PROFILES),
    ...(open === undefined ? {} : { open }),
    ...(pluginDir === undefined ? {} : { pluginDir }),
    ...(model === undefined ? {} : { model }),
  };
};
