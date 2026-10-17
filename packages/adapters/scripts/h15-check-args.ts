/** The command line of `live:h15` (scripts/h15-check.ts, spine §5 reading 239). Pure. */

export const H15_TARGETS = [
  "codex-model-refusal",
  "codex-signed-out",
  "codex-limit",
  "claude-strict",
  "claude-sandbox",
  "claude-usage-unit",
] as const;
export type H15Target = (typeof H15_TARGETS)[number];

export interface H15Args {
  readonly target: H15Target;
  /** Where the check writes what it saw (raw and redacted); required, never inside the repo. */
  readonly out: string;
  /**
   * `codex-model-refusal`: the id to ask for (default `CODEX_REFUSAL_PROBE_MODEL`, which no plan
   * has); `claude-strict` and `claude-sandbox`: the Claude model (default `haiku`).
   */
  readonly model?: string;
}

const TARGET_TAKES_MODEL: Readonly<Record<H15Target, boolean>> = {
  "codex-model-refusal": true,
  "codex-signed-out": false,
  "codex-limit": false,
  "claude-strict": true,
  "claude-sandbox": true,
  "claude-usage-unit": true,
};

export const parseH15Args = (argv: readonly string[]): H15Args => {
  const [first, ...flags] = argv;
  if (first === undefined) throw new Error(`name a check: ${H15_TARGETS.join(", ")}`);
  const target = H15_TARGETS.find((t) => t === first);
  if (target === undefined) {
    throw new Error(
      `the check must be one of ${H15_TARGETS.join(", ")}, got ${JSON.stringify(first)}`,
    );
  }
  const values: { out?: string; model?: string } = {};
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i] ?? "";
    if (flag !== "--out" && flag !== "--model") throw new Error(`unknown flag ${flag}`);
    if (flag === "--model" && !TARGET_TAKES_MODEL[target]) {
      throw new Error(`--model is not a flag of ${target}`);
    }
    const value = flags[i + 1];
    if (value === undefined || value.startsWith("--") || value === "") {
      throw new Error(`${flag} needs a value`);
    }
    if (flag === "--model" && !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u.test(value)) {
      throw new Error("--model needs a model id");
    }
    values[flag === "--out" ? "out" : "model"] = value;
  }
  if (values.out === undefined) throw new Error("--out <dir> is required: where the check writes");
  return {
    target,
    out: values.out,
    ...(values.model === undefined ? {} : { model: values.model }),
  };
};
