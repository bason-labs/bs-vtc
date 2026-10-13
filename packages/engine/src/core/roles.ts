/**
 * The role contracts the engine dispatches against (§5, AD-14). The neutral role sources in
 * `roles/` (sub-project 3) are the source of truth: the compiler emits them into each host
 * plugin as {@link ROLE_CONTRACTS_ASSET}, and the daemon loads them from its `AssetBundle`
 * (`compiledRoleContracts`). A broken or incomplete set stops the daemon. Until the plugins carry
 * the file, the engine uses these built-in contracts and the daemon says so on stderr; a test
 * compares them with `roles/<role>/role.yaml` once those exist, so the two cannot drift
 * unnoticed. Model ids come from the engine (AD-6 rule 2): role tier → project override →
 * built-in tier map.
 */
import {
  HOST_IDS,
  RoleContractSchema,
  type AssetBundle,
  type AssetNamespace,
  type HostId,
  type ModelTier,
  type ProjectConfig,
  type ResolvedModel,
  type RoleContract,
  type RoleContractInput,
} from "@vtc/shared";

/** Model id per tier and host, used when `project.yaml` sets none (`hosts.models`). */
export const DEFAULT_TIER_MODELS: Readonly<Record<HostId, Readonly<Record<ModelTier, string>>>> = {
  "claude-code": { top: "opus", mid: "sonnet", low: "haiku" },
  codex: { top: "gpt-5-codex", mid: "gpt-5-codex", low: "gpt-5-codex-mini" },
};

const VERDICTS = ["pass", "fail", "unknown", "unchecked"] as const;

const both = (tier: ModelTier, effort: "low" | "medium" | "high" = "medium") =>
  Object.fromEntries(HOST_IDS.map((h) => [h, { tier, effort }])) as RoleContractInput["models"];

const role = (
  input: Omit<RoleContractInput, "version" | "budget"> & {
    readonly budget?: RoleContractInput["budget"];
  },
): RoleContract =>
  RoleContractSchema.parse({ version: "1.0.0", budget: { context_tokens: 60_000 }, ...input });

export const BUILTIN_ROLES: readonly RoleContract[] = [
  role({
    id: "repo_cartographer",
    kind: "core",
    mission: "Map an existing repository for the run.",
    inputs: ["request"],
    output: { artifacts: ["repo_map"], verdicts: [] },
    exits: ["done", "blocked", "unknown"],
    reviewer: "engine",
    models: both("low"),
    tools: { profile: "write_scoped", write_paths: [".vtc/research/**"] },
  }),
  role({
    id: "research_analyst",
    kind: "core",
    mission: "Research a new idea or a large feature with cited sources.",
    inputs: ["request"],
    output: { artifacts: ["research_brief"], verdicts: [] },
    exits: ["done", "blocked", "unknown"],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "write_scoped", write_paths: [".vtc/research/**"] },
  }),
  role({
    id: "ba",
    kind: "core",
    mission: "Write the spec with REQ-n requirements and acceptance criteria.",
    inputs: ["request"],
    output: { artifacts: ["spec"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict", "unknown"],
    reviewer: "spec_verifier",
    models: both("top", "high"),
    tools: { profile: "write_scoped", write_paths: [".vtc/spec/**"] },
  }),
  role({
    id: "architect",
    kind: "core",
    mission: "Propose the architecture spine for the approved spec.",
    inputs: ["spec"],
    output: { artifacts: ["architecture"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict", "unknown"],
    reviewer: "security",
    models: both("top", "high"),
    tools: { profile: "write_scoped", write_paths: [".vtc/architecture/**"] },
  }),
  role({
    id: "designer",
    kind: "core",
    mission: "Design flows, screens and tokens for the approved spec.",
    inputs: ["spec"],
    output: { artifacts: ["design"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict", "unknown"],
    reviewer: "visual_qa",
    models: both("top"),
    tools: { profile: "write_scoped", write_paths: [".vtc/design/**"] },
  }),
  role({
    id: "planner",
    kind: "core",
    mission: "Split the approved design into tasks with intent contracts.",
    inputs: ["spec", "architecture"],
    output: { artifacts: ["tasks"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict", "unknown"],
    reviewer: "engine",
    models: both("top", "high"),
    tools: { profile: "read_only" },
  }),
  role({
    id: "qa",
    kind: "core",
    mission: "Author acceptance tests, or judge test adequacy.",
    inputs: ["spec"],
    output: { artifacts: [], verdicts: [] },
    exits: ["done", "blocked", "unknown"],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "read_only" },
    modes: {
      author: {
        output: {
          artifacts: ["acceptance_test", "hidden_acceptance_test", "scenario"],
          verdicts: [],
        },
        tools: { profile: "write_scoped", write_paths: ["tests/**"] },
      },
      judge: {
        output: { artifacts: [], verdicts: [...VERDICTS] },
        exits: ["done", "unknown"],
      },
    },
  }),
  role({
    id: "engineer",
    kind: "core",
    mission: "Implement the task inside its files_scope until the acceptance tests pass.",
    inputs: ["spec", "acceptance_test"],
    output: { artifacts: ["interface_contract"], verdicts: [] },
    exits: ["built", "blocked", "spec_conflict", "out_of_scope_fault"],
    reviewer: "qa",
    models: both("mid", "high"),
    tools: { profile: "code_sandboxed" },
  }),
  role({
    id: "spec_verifier",
    kind: "core",
    mission: "Judge one acceptance criterion against the built code, with evidence.",
    inputs: ["spec", "diff"],
    output: { artifacts: [], verdicts: [...VERDICTS] },
    exits: ["done", "unknown"],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "read_only" },
  }),
  role({
    id: "security",
    kind: "core",
    mission: "Threat-model the design, or verify the built diff.",
    inputs: ["spec"],
    output: { artifacts: [], verdicts: [] },
    exits: ["done", "unknown"],
    reviewer: "engine",
    models: both("top"),
    tools: { profile: "read_only" },
    modes: {
      design: {
        output: { artifacts: ["threat_model"], verdicts: [] },
        tools: { profile: "write_scoped", write_paths: [".vtc/architecture/**"] },
      },
      verify: { output: { artifacts: [], verdicts: [...VERDICTS] } },
    },
  }),
  role({
    id: "visual_qa",
    kind: "core",
    mission: "Judge the rendered UI against the design criteria V1–V8.",
    inputs: ["design_md"],
    output: { artifacts: [], verdicts: [...VERDICTS] },
    exits: ["done", "unknown"],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "read_only" },
  }),
];

export interface RoleRegistry {
  get(role: string): RoleContract | undefined;
}

/**
 * The registry: the compiled contracts when given (they must cover every role the engine
 * dispatches, `compiledRoleContracts` checks it), else the built-ins.
 */
export const createRoleRegistry = (contracts: readonly RoleContract[] = []): RoleRegistry => {
  const byId = new Map<string, RoleContract>(
    (contracts.length > 0 ? contracts : BUILTIN_ROLES).map((r) => [r.id, r]),
  );
  return { get: (id) => byId.get(id) };
};

/**
 * Where the compiler writes the compiled role contracts in each host plugin (a JSON array of
 * `RoleContract`). Proposed to shared as a contract constant (AD-14, AD-15 rule 2).
 */
export const ROLE_CONTRACTS_ASSET = "vtc/role-contracts.json";

export class RoleContractsError extends Error {
  constructor(detail: string) {
    super(`the compiled role contracts (${ROLE_CONTRACTS_ASSET}) are unusable: ${detail}`);
    this.name = "RoleContractsError";
  }
}

/**
 * The compiled role contracts a plugin namespace carries, validated against `RoleContractSchema`
 * and checked to cover every role the engine dispatches; `null` when no plugin carries them.
 * Throws {@link RoleContractsError} on a broken or incomplete set (the daemon must not start on
 * one: write scopes and result checks come from these contracts).
 */
export const compiledRoleContracts = (assets: AssetBundle): RoleContract[] | null => {
  for (const namespace of [
    "plugin:claude-code",
    "plugin:codex",
  ] as const satisfies readonly AssetNamespace[]) {
    const bytes = assets.read(namespace, ROLE_CONTRACTS_ASSET);
    if (bytes === undefined) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch (error) {
      throw new RoleContractsError(
        `${namespace}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(raw)) throw new RoleContractsError(`${namespace}: not an array`);
    const contracts = raw.map((entry, i) => {
      const parsed = RoleContractSchema.safeParse(entry);
      if (!parsed.success)
        throw new RoleContractsError(
          `${namespace}[${String(i)}]: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`,
        );
      return parsed.data;
    });
    const missing = BUILTIN_ROLES.map((r) => r.id).filter(
      (id) => !contracts.some((c) => c.id === id),
    );
    if (missing.length > 0)
      throw new RoleContractsError(`${namespace}: no contract for ${missing.join(", ")}`);
    return contracts;
  }
  return null;
};

/** The tier a role runs at on a host (mode overrides first). */
export const roleTier = (contract: RoleContract, host: HostId, mode?: string): ModelTier => {
  const models =
    (mode === undefined ? undefined : contract.modes?.[mode]?.models) ?? contract.models;
  return models[host].tier;
};

/** A concrete model for a role run (AD-6 rule 2): explicit role model, project map, built-in map. */
export const resolveModel = (
  contract: RoleContract,
  host: HostId,
  config: Pick<ProjectConfig, "hosts">,
  options: { readonly mode?: string; readonly tier?: ModelTier } = {},
): ResolvedModel => {
  const models =
    (options.mode === undefined ? undefined : contract.modes?.[options.mode]?.models) ??
    contract.models;
  const entry = models[host];
  const tier = options.tier ?? entry.tier;
  const explicit =
    options.tier === undefined || options.tier === entry.tier ? entry.model : undefined;
  return {
    tier,
    effort: entry.effort,
    model: explicit ?? config.hosts.models?.[host]?.[tier] ?? DEFAULT_TIER_MODELS[host][tier],
  };
};
