/**
 * The role contracts the engine dispatches against (§5, AD-14). The neutral role sources in
 * `roles/` (sub-project 3) are the only source: the compiler emits them into each host plugin as
 * `ROLE_CONTRACTS_ASSET` (`@vtc/shared`), and the daemon loads them from its `AssetBundle`
 * (`compiledRoleContracts`). A missing, broken or incomplete set stops the daemon: write scopes,
 * exits, verdicts and models come from these contracts (AD-8 rule 9), never from a second copy in
 * the engine. Model ids come from the engine (AD-6 rule 2): role tier → project override →
 * built-in tier map.
 */
import {
  resolveRoleMode,
  ROLE_CONTRACTS_ASSET,
  RoleContractSchema,
  type AssetBundle,
  type AssetNamespace,
  type HostId,
  type ModelTier,
  type ProjectConfig,
  type ResolvedModel,
  type RoleContract,
} from "@vtc/shared";

/**
 * Model id per tier and host, used when `project.yaml` sets none (`hosts.models`). Codex has no
 * built-in ids until a spike names them (spine §5 readings 26 and 51, D-ae): a Codex role with no
 * explicit or project model runs on the host session's model with only the resolved effort.
 */
export const DEFAULT_TIER_MODELS: Readonly<
  Record<HostId, Readonly<Partial<Record<ModelTier, string>>>>
> = {
  "claude-code": { top: "opus", mid: "sonnet", low: "haiku" },
  codex: {},
};

/** The roles the engine's flow dispatches by id (§6.1, §6.3): a compiled set must cover them. */
export const REQUIRED_ROLES = [
  "repo_cartographer",
  "research_analyst",
  "ba",
  "architect",
  "designer",
  "planner",
  "qa",
  "engineer",
  "spec_verifier",
  "security",
  "visual_qa",
] as const;

export interface RoleRegistry {
  get(role: string): RoleContract | undefined;
}

/** The registry over the compiled contracts (`compiledRoleContracts`; tests inject fixtures). */
export const createRoleRegistry = (contracts: readonly RoleContract[]): RoleRegistry => {
  const byId = new Map<string, RoleContract>(contracts.map((r) => [r.id, r]));
  return { get: (id) => byId.get(id) };
};

/** A role run's effective write paths (its mode's, else the role's); none for an unknown role. */
export const writePathsOf = (
  roles: RoleRegistry,
  run: { readonly role: string; readonly mode?: string | undefined },
): readonly string[] => {
  const contract = roles.get(run.role);
  if (contract === undefined) return [];
  const effective = resolveRoleMode(contract, run.mode);
  return effective.ok ? effective.contract.tools.write_paths : [];
};

export class RoleContractsError extends Error {
  constructor(detail: string) {
    super(`the compiled role contracts (${ROLE_CONTRACTS_ASSET}) are unusable: ${detail}`);
    this.name = "RoleContractsError";
  }
}

/**
 * The compiled role contracts the plugin assets carry (the first plugin namespace that has them),
 * validated against `RoleContractSchema` and checked to cover {@link REQUIRED_ROLES}. Throws
 * {@link RoleContractsError} when no plugin carries them, or on a broken or incomplete set (the
 * daemon must not start on one).
 */
export const compiledRoleContracts = (assets: AssetBundle): RoleContract[] => {
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
    const ids = contracts.map((c) => c.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate !== undefined)
      throw new RoleContractsError(`${namespace}: ${duplicate} is listed twice`);
    const missing = REQUIRED_ROLES.filter((id) => !ids.includes(id));
    if (missing.length > 0)
      throw new RoleContractsError(`${namespace}: no contract for ${missing.join(", ")}`);
    return contracts;
  }
  throw new RoleContractsError("no plugin in the asset bundle carries them");
};

/** The tier a role runs at on a host (mode overrides first). */
export const roleTier = (contract: RoleContract, host: HostId, mode?: string): ModelTier => {
  const models =
    (mode === undefined ? undefined : contract.modes?.[mode]?.models) ?? contract.models;
  return models[host].tier;
};

/**
 * The model of a role run (AD-6 rule 2): explicit role model, project map, built-in map. Without
 * any of them `model` is absent: the host session's default model runs it (spine §5 reading 51).
 */
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
  const model = explicit ?? config.hosts.models?.[host]?.[tier] ?? DEFAULT_TIER_MODELS[host][tier];
  return { tier, effort: entry.effort, ...(model === undefined ? {} : { model }) };
};
