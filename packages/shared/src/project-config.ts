/**
 * `.vtc/project.yaml` (§4.3): track default, merge level, caps, budgets, risk rules,
 * allowlists, host preferences and concurrency. Every field has a spec default, so `{ version: 1 }`
 * is a valid file.
 */
import { z } from "zod";
import { DEFAULT_FINAL_REVIEW_SHARE } from "./feature.js";
import { HeadlessConfigSchema } from "./headless.js";
import {
  GlobSchema,
  HostIdSchema,
  SeveritySchema,
  SlugSchema,
  type TokenUsage,
} from "./primitives.js";
import { FetcherIdSchema, SearchProviderSchema } from "./research.js";
import { LOOKBACK_LIMITS } from "./lookback.js";
import { ModelTierSchema } from "./role-contract.js";
import { RoutingConfigSchema } from "./tier-routing.js";
import {
  DEFAULT_UPSTREAM_REPO,
  EVIDENCE_HOSTING_DEFAULT,
  EVIDENCE_LIMITS,
  EvidenceHostingSchema,
  GitHubRepoSchema,
  type EvidenceHosting,
  type GitHubRepo,
} from "./upstream.js";

/** Tracks (§6.2). */
export const TrackSchema = z.enum(["quick_fix", "feature", "new_project"]);
export type Track = z.infer<typeof TrackSchema>;

/** Auto-merge levels (§6.7): 1 local, 2 push + draft PR (default), 3 PR auto-merges after green CI. */
export const MergeLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type MergeLevel = z.infer<typeof MergeLevelSchema>;

/** Whether the engine may launch headless host processes (§12.5). */
export const DispatchModeSchema = z.enum(["plugin_only", "headless_allowed"]);
export type DispatchMode = z.infer<typeof DispatchModeSchema>;

const capSchema = (fallback: number) => z.int().min(3).max(5).default(fallback);

export const ProjectConfigSchema = z.strictObject({
  version: z.literal(1),
  /** Client this project belongs to; isolates research cache, allowlists and memory (§14). */
  client: SlugSchema.optional(),
  /** Overrides the Lead's intake classification when set (§6.2). */
  track_default: TrackSchema.optional(),
  merge_level: MergeLevelSchema.default(2),
  /** Per-task round caps by risk (§6.3 step 9; 3–5 rounds, D6). */
  caps: z.strictObject({ low: capSchema(3), med: capSchema(4), high: capSchema(5) }).prefault({}),
  /** List-price-equivalent USD (§11). */
  budgets: z
    .strictObject({
      task_usd: z
        .strictObject({
          S: z.number().positive().default(1.5),
          M: z.number().positive().default(5),
          L: z.number().positive().default(15),
        })
        .prefault({}),
      final_review_share: z.number().gt(0).lt(1).default(DEFAULT_FINAL_REVIEW_SHARE),
      /**
       * Advisor spend per run (§5.4 through the `consult` tool): the engine refuses a consult
       * once the run's advisor calls have spent this much (spine §5 reading 25).
       */
      advisor_usd: z.number().positive().default(5),
    })
    .prefault({}),
  /** Risk rules that park a task (§7.6). Built-in rules always apply; these add to them. */
  risk_rules: z
    .strictObject({
      paths: z.array(GlobSchema).default([]),
      max_diff_lines: z.int().positive().default(800),
      max_diff_files: z.int().positive().default(30),
    })
    .prefault({}),
  /** Dependency and license allowlists (§7.2 L4, §7.6 rule 4). */
  allowlists: z
    .strictObject({
      dependencies: z.array(z.string().min(1).max(214)).default([]),
      licenses: z.array(z.string().min(1).max(100)).default([]),
    })
    .prefault({}),
  hosts: z
    .strictObject({
      preferred: HostIdSchema.optional(),
      /**
       * `plugin_only` (default): the engine launches no headless Claude run and no run without
       * a live Lead; roles run as subagents the Lead dispatches, except that a Codex Lead's roles
       * always run as engine-launched headless Codex runs (H-1, `ROLE_DISPATCH_BY_LEAD_HOST`).
       * `headless_allowed`: the engine may also launch `claude -p` / `codex exec` for
       * auto-resume with no Lead, cross-family review and hosts without subagents. §12.5
       * requires written vendor confirmation before headless spawning ships commercially
       * (`planDispatch`, spine AD-17, AD-25).
       */
      dispatch: DispatchModeSchema.default("plugin_only"),
      /**
       * Supervision of engine-launched headless runs (AD-25 rule 4): wall and idle timeouts in
       * minutes. Absent: `HEADLESS_DEFAULTS` (`headlessPolicyFor`). New in 4.5.0.
       */
      headless: HeadlessConfigSchema.optional(),
      /** Opt-in cross-family review for high-risk tasks (D10, §12.4). */
      cross_family_review: z.boolean().default(false),
      /**
       * Model id per tier per host, overriding the engine's built-in mapping, e.g.
       * `models: { codex: { top: "<model id>" } }`. The engine is the only resolver
       * (`ResolvedModel`). The built-in Codex mapping names no ids until the spike does, so
       * without an override Codex runs on the session's model with only the reasoning effort set
       * (spine §5 reading 26, D-ae).
       */
      models: z
        .partialRecord(HostIdSchema, z.partialRecord(ModelTierSchema, z.string().min(1)))
        .optional(),
    })
    .prefault({}),
  /**
   * Difficulty-based model routing (H-9, D-cm; `RoutingConfig`): `start: role` keeps each role's
   * own tier; `min_tier` / `max_tier` bound every tier the engine picks for this project, and win
   * over the routing table, a Planner hint, an escalation and a budget drop (QA author keeps its
   * floor). `hosts.models` still maps the chosen tier to a model id. Absent: start by difficulty
   * on the full range. New in 5.4.0.
   */
  routing: RoutingConfigSchema.optional(),
  /** Parallel tasks (reviewers count toward it). Default 2; §11 bounds it to 1–3. */
  concurrency: z.int().min(1).max(3).default(2),
  usage: z
    .strictObject({
      /** Below this % of the 5-hour window, start only steps already in flight (§6.9). */
      reserve_pct: z.number().min(0).max(100).default(10),
    })
    .prefault({}),
  git: z
    .strictObject({
      /**
       * Sign the engine's commits and merges with the user's existing git signing setup (for
       * repos whose branch protection requires signed commits). Default false: engine git forces
       * `commit.gpgsign=false`. Even when true, a signing program or key that is set or changed
       * during a run is refused (spine §5 reading 22).
       */
      sign_commits: z.boolean().default(false),
    })
    .prefault({}),
  auto_merge: z
    .strictObject({
      /** Level 3 requires zero open findings at or above this severity (§6.7). */
      block_severity: SeveritySchema.default("medium"),
    })
    .prefault({}),
  /**
   * Upstream reports to VTC's own repo from this project (D-by, AD-27 rule 5). `share: false`
   * opts the project out; absent = on (the user asked for more automation). The user-level
   * `upstream.share` in `~/.vtc/config.yaml` turns it off for every project. New in 5.0.0.
   */
  upstream: z.strictObject({ share: z.boolean().optional() }).optional(),
  /**
   * Automatic issues and PRs in this project's repo (D-bz). `issues` / `prs` absent = on whenever
   * the project has a GitHub remote and `gh` is logged in, otherwise off with a visible note
   * (`automationFor`). `evidence.max_mb` lowers the per-PR media budget (never above
   * `EVIDENCE_LIMITS`); `evidence.video: false` drops recordings (screenshots only, `evidence:
   * partial`). New in 5.0.0.
   */
  automation: z
    .strictObject({
      issues: z.boolean().optional(),
      prs: z.boolean().optional(),
      evidence: z
        .strictObject({
          max_mb: z
            .number()
            .positive()
            .max(EVIDENCE_LIMITS.maxBytesPerPr / (1024 * 1024))
            .optional(),
          video: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** The project config file, repo-relative (§4.3). */
export const PROJECT_CONFIG_FILE = ".vtc/project.yaml";

/**
 * Why a run refuses to start (spine §5 reading 79): the working tree's `.vtc/project.yaml` is not
 * the one committed at the commit the run would start on. A run takes its project config from
 * that commit, so a change (by the user, or by a role in a Lead session) reaches a run only once
 * someone commits it.
 */
export const projectConfigNotCommitted = (commit: string): string =>
  `${PROJECT_CONFIG_FILE} differs from the copy committed at ${commit.slice(0, 12)}: commit the change (or undo it), then start the run again`;
export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;

// --------------------------------------------------------- user-level config

/** The user-level config file, relative to the VTC home (`~/.vtc/`, or `$VTC_HOME`). */
export const USER_CONFIG_FILE = "config.yaml";

/** An environment variable name (POSIX portable form). */
export const EnvVarNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

/**
 * One model's list price (§11 "Unit: list-price-equivalent USD, computed from the four token
 * types"), in USD per million tokens of each type: fresh input, cache read (cached input), output,
 * and cache write. New in 4.9.0.
 */
export const ModelPriceSchema = z.strictObject({
  input_per_mtok: z.number().nonnegative().max(10_000),
  cached_input_per_mtok: z.number().nonnegative().max(10_000),
  output_per_mtok: z.number().nonnegative().max(10_000),
  cache_write_per_mtok: z.number().nonnegative().max(10_000).default(0),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export type ModelPriceInput = z.input<typeof ModelPriceSchema>;

/** A model id as the price table keys it (the id `hosts.models` names, e.g. `gpt-6.1-sol`). */
export const PricedModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, "a model id");

/**
 * Pure (§11): the list-price-equivalent USD of `tokens` at `price`, rounded to a hundredth of a
 * cent. `TokenUsage.in` is fresh input only (a host that counts cached input inside its input
 * reports it apart, as the Codex adapter does), so each token is priced once. New in 4.9.0.
 */
export const priceTokens = (tokens: TokenUsage, price: ModelPrice): number => {
  const usd =
    (tokens.in * price.input_per_mtok +
      tokens.cache_r * price.cached_input_per_mtok +
      tokens.out * price.output_per_mtok +
      tokens.cache_w * price.cache_write_per_mtok) /
    1_000_000;
  return Math.round(usd * 10_000) / 10_000;
};

/**
 * A host's default price table (H-12; spine §5 reading 236): list prices taken from the
 * provider's public API pricing page, with that page's URL and the date they were read, shipped
 * with VTC by the host's adapter (`HostAdapter.defaultPrices`) and refreshed with each VTC release.
 * The user never has to fill a table: `~/.vtc/config.yaml` `prices` may override any model, never
 * must. New in 5.7.0.
 */
export const PriceTableSchema = z.strictObject({
  v: z.literal(1),
  /** The public pricing page the prices were read from (https only). */
  source_url: z.url().refine((u) => u.startsWith("https://"), "a price source must use https"),
  /** The day the prices were read (`YYYY-MM-DD`). */
  as_of: z.iso.date(),
  prices: z
    .record(PricedModelIdSchema, ModelPriceSchema)
    .refine((table) => Object.keys(table).length <= 200, "at most 200 priced models"),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;
export type PriceTableInput = z.input<typeof PriceTableSchema>;

/**
 * Pure (H-12): the prices the engine uses for one host, the user's `prices` over the host's
 * default table, model by model. Either may be absent. New in 5.7.0.
 */
export const effectivePrices = (
  defaults: PriceTable | undefined,
  user: Readonly<Record<string, ModelPrice>> | undefined,
): Readonly<Record<string, ModelPrice>> => ({ ...(defaults?.prices ?? {}), ...(user ?? {}) });

/**
 * Pure (H-12): the price ceiling of a set of known prices: each token type at the highest price
 * any of them charges for it, so tokens counted at the ceiling are never under-counted. `undefined`
 * when no price is known. New in 5.7.0.
 */
export const priceCeiling = (prices: readonly ModelPrice[]): ModelPrice | undefined => {
  if (prices.length === 0) return undefined;
  const max = (pick: (p: ModelPrice) => number): number => Math.max(...prices.map(pick));
  return {
    input_per_mtok: max((p) => p.input_per_mtok),
    cached_input_per_mtok: max((p) => p.cached_input_per_mtok),
    output_per_mtok: max((p) => p.output_per_mtok),
    cache_write_per_mtok: max((p) => p.cache_write_per_mtok),
  };
};

/**
 * Pure (H-12; replaces reading 152's refusal of unpriced runs): what a run with `tokens` on
 * `model` costs and what it counts toward budgets, given its host's effective prices
 * ({@link effectivePrices}). A listed model: both are its price. A model with no known price never
 * blocks a run: its cost is unknown (`cost_usd: null`, shown as "unknown") and the budget counts
 * its tokens at the {@link priceCeiling} of the host's known prices (`budget_usd`; `null` only when
 * the host has no known price at all, which `vtc doctor` warns about). New in 5.7.0.
 */
export const priceRun = (
  tokens: TokenUsage,
  model: string | null | undefined,
  prices: Readonly<Record<string, ModelPrice>>,
): {
  readonly cost_usd: number | null;
  readonly budget_usd: number | null;
  readonly basis: "listed" | "ceiling" | "none";
} => {
  const listed = model === null || model === undefined ? undefined : prices[model];
  if (listed !== undefined) {
    const usd = priceTokens(tokens, listed);
    return { cost_usd: usd, budget_usd: usd, basis: "listed" };
  }
  const ceiling = priceCeiling(Object.values(prices));
  return ceiling === undefined
    ? { cost_usd: null, budget_usd: null, basis: "none" }
    : { cost_usd: null, budget_usd: priceTokens(tokens, ceiling), basis: "ceiling" };
};

/**
 * `~/.vtc/config.yaml`: settings that belong to the person and the machine, never to a repo.
 * Read with `parsePersisted`; a missing file is `{ version: 1 }`.
 * - `env_passthrough` (D-ak, spine §5 reading 57): the detached daemon drops credential
 *   variables from its environment by default (AD-9). The names listed here pass through to it
 *   (and so to headless host runs and `gh`). Names only, never values. It lives only in this
 *   user-level file: `.vtc/project.yaml` is committed, so a repo could otherwise ask for the
 *   user's secrets; `ProjectConfigSchema` has no such key and rejects it. `vtc doctor` shows
 *   which names pass.
 * - `gates.allow_unsandboxed` (D-al, spine §5 reading 69): every gate command runs inside an OS
 *   sandbox (`GATE_SANDBOX`). Where none is available the gate run parks (`infra`, "no OS
 *   sandbox for gates") unless this is `true`; then gates run unconfined and every such gate run
 *   records an `unsandboxed_gate` incident. Like `env_passthrough` it exists only here, never in
 *   `project.yaml`, so a repo cannot switch the gate sandbox off.
 * - `gates.allow_tools_hashed_after_scripts` (H-14, spine §5 reading 250): new in 5.9.0, when a
 *   verify gate whose tools could be hashed only after an install gate with no scripts-free form
 *   ran its lifecycle scripts did not run without it. No effect since 5.10.0 (spine §5 reading
 *   251): such a gate runs, marked `after_scripts` with a warning, and the workspace-wide
 *   comparison covers every change after the hash. Still parsed so an existing file stays valid;
 *   `vtc doctor` says it can be removed. Only here, never in `project.yaml`.
 * - `prices` (§11, H-1; spine §5 reading 152): the engine's price table, model id → list price
 *   ({@link ModelPriceSchema}). The engine prices a run's tokens only when the host reported no
 *   cost (Codex reports none). Only here, never in `project.yaml`: a repo could otherwise price its
 *   own runs at zero. New in 4.9.0. Since 5.7.0 (H-12; spine §5 reading 236) it is an optional
 *   override over the host adapter's default table ({@link PriceTableSchema},
 *   {@link effectivePrices}); a model with no known price never blocks a run (its cost is unknown
 *   and the budget counts it at the {@link priceCeiling}, {@link priceRun}).
 */
export const UserConfigSchema = z.strictObject({
  version: z.literal(1),
  env_passthrough: z.array(EnvVarNameSchema).max(64).default([]),
  /** Optional, so a `UserConfig` built in code needs no change; absent reads as all defaults. */
  gates: z
    .strictObject({
      allow_unsandboxed: z.boolean().default(false),
      allow_tools_hashed_after_scripts: z.boolean().optional(),
    })
    .optional(),
  /**
   * Research fetchers' own API keys (AD-22 rule 1, spine §5 reading 120): for a fetcher id
   * (`github`, `search`, …), the name of the environment variable that holds its key. The value
   * is read from the environment at call time (`EngineDeps.researchApiKey`), sent only to that
   * fetcher's API and redacted as a known value; it is never written anywhere. New in 4.6.0.
   */
  research: z
    .strictObject({
      api_keys: z.partialRecord(FetcherIdSchema, EnvVarNameSchema).default({}),
      /**
       * The optional keyed provider behind the `search` fetcher (H-3, spine §5 reading 156).
       * Absent (the default): the fetcher sends nothing and research search runs on the host's
       * own web search in the role session. With a provider, its key is `api_keys.search`'s
       * variable. New in 4.10.0.
       */
      search_provider: SearchProviderSchema.optional(),
    })
    .optional(),
  prices: z
    .record(PricedModelIdSchema, ModelPriceSchema)
    .refine((table) => Object.keys(table).length <= 200, "at most 200 priced models")
    .optional(),
  /**
   * Upstream reporting (D-bz, D-by; AD-27). `repo`: VTC's own repo, default
   * {@link DEFAULT_UPSTREAM_REPO}. `share: false` turns upstream issues and PRs off for every
   * project (default on). `checkout`: absolute path of a local clone of that repo set up for VTC
   * (`vtc init`), where Lookback PRs and "VTC builds VTC" fix runs are made; absent: upstream
   * issues only, PRs skip with `no_upstream_checkout`. New in 5.0.0.
   */
  upstream: z
    .strictObject({
      repo: GitHubRepoSchema.optional(),
      share: z.boolean().optional(),
      checkout: z
        .string()
        .min(2)
        .max(1024)
        .refine((p) => p.startsWith("/") && !p.split("/").includes(".."), "an absolute path")
        .optional(),
    })
    .optional(),
  /**
   * Where automatic-PR media live (D-ce, spine §5 reading 196): `branch` (the orphan
   * `vtc-evidence` branch, the default) or `attach` (`gh --attach`, gh ≥ 2.99, github.com only).
   * New in 5.0.0.
   */
  automation: z.strictObject({ evidence_hosting: EvidenceHostingSchema.optional() }).optional(),
  /**
   * Lookback replay pace (D-cq), user-level because replays spend the user's weekly window: how
   * many recent failures and regression tasks one replay samples, the trials one RETRO may
   * launch, and the higher cap while more than `boost_above_weekly_pct` of the Lead host's weekly
   * window is left. Absent fields: `LOOKBACK_LIMITS` (`lookbackPaceFor`). New in 5.4.0.
   */
  lookback: z
    .strictObject({
      replay_failure_tasks: z.int().min(1).max(50).optional(),
      replay_regression_tasks: z.int().min(0).max(50).optional(),
      max_trials_per_retro: z.int().min(1).max(500).optional(),
      max_trials_per_retro_boosted: z.int().min(1).max(500).optional(),
      boost_above_weekly_pct: z.number().min(0).max(100).optional(),
    })
    .optional(),
});

/** One RETRO's replay pace (D-cq), from {@link lookbackPaceFor}. */
export interface LookbackPace {
  readonly failureTasks: number;
  readonly regressionTasks: number;
  /** The per-RETRO trial cap that applies now (the boosted one while the weekly window allows). */
  readonly maxTrialsPerRetro: number;
}

/**
 * Pure (D-cq): the replay pace for a RETRO. `weeklyRemainingPct` is the Lead host's weekly window
 * left, in percent, or `null` when unknown (then the base cap applies). The boosted cap never
 * goes below the base cap. New in 5.4.0.
 */
export const lookbackPaceFor = (
  user: Pick<UserConfig, "lookback"> | undefined,
  weeklyRemainingPct: number | null,
): LookbackPace => {
  const l = user?.lookback;
  const base = l?.max_trials_per_retro ?? LOOKBACK_LIMITS.maxTrialsPerRetro;
  const boosted = Math.max(
    base,
    l?.max_trials_per_retro_boosted ?? LOOKBACK_LIMITS.maxTrialsPerRetroBoosted,
  );
  const threshold = l?.boost_above_weekly_pct ?? LOOKBACK_LIMITS.boostAboveWeeklyPct;
  return {
    failureTasks: l?.replay_failure_tasks ?? LOOKBACK_LIMITS.replayFailureTasks,
    regressionTasks: l?.replay_regression_tasks ?? LOOKBACK_LIMITS.replayRegressionTasks,
    maxTrialsPerRetro:
      weeklyRemainingPct !== null && weeklyRemainingPct > threshold ? boosted : base,
  };
};

/** `gates.allow_unsandboxed` of a parsed user config; false when the section is absent. */
export const gatesAllowUnsandboxed = (config: Pick<UserConfig, "gates">): boolean =>
  config.gates?.allow_unsandboxed ?? false;
/**
 * `gates.allow_tools_hashed_after_scripts` of a parsed user config (H-14, reading 250); false when
 * the section is absent. No effect on gate runs since 5.10.0 (reading 251).
 */
export const gatesAllowToolsHashedAfterScripts = (config: Pick<UserConfig, "gates">): boolean =>
  config.gates?.allow_tools_hashed_after_scripts ?? false;
export type UserConfig = z.infer<typeof UserConfigSchema>;
export type UserConfigInput = z.input<typeof UserConfigSchema>;

// ------------------------------------------------------------- automation

/** What decides whether automation runs for a project now (D-bz). */
export interface AutomationContext {
  /** The project's push remote is on GitHub. */
  readonly githubRemote: boolean;
  /** `gh auth status` exits 0 (no token is read). */
  readonly ghLoggedIn: boolean;
  /** `vtc pause` is in effect. */
  readonly paused: boolean;
}

/** The resolved automation settings of one project, with the notes Flow Studio and doctor show. */
export interface AutomationSettings {
  readonly issues: boolean;
  readonly prs: boolean;
  readonly upstream: boolean;
  readonly upstreamRepo: GitHubRepo;
  readonly evidenceHosting: EvidenceHosting;
  readonly notes: readonly string[];
}

/**
 * Pure (D-bz, D-by; AD-27 rule 7): project issues and PRs are on by default when the project has a
 * GitHub remote and `gh` is logged in, and off with a visible note otherwise; `false` in
 * `project.yaml` turns either off. Upstream reporting needs `gh` and both opt-outs unset. `vtc
 * pause` stops everything. New in 5.0.0.
 */
export const automationFor = (
  project: Pick<ProjectConfig, "upstream" | "automation">,
  user: Pick<UserConfig, "upstream" | "automation">,
  context: AutomationContext,
): AutomationSettings => {
  const notes: string[] = [];
  if (context.paused) notes.push("automation is paused (vtc pause)");
  if (!context.githubRemote)
    notes.push("automatic issues and PRs are off: this project has no GitHub remote");
  if (!context.ghLoggedIn)
    notes.push("automatic issues and PRs are off: gh is not logged in (run gh auth login)");
  const live = !context.paused && context.ghLoggedIn;
  const projectOn = live && context.githubRemote;
  const shareUser = user.upstream?.share ?? true;
  const shareProject = project.upstream?.share ?? true;
  if (!shareUser) notes.push("upstream reports are off for every project (~/.vtc/config.yaml)");
  else if (!shareProject) notes.push("upstream reports are off for this project (project.yaml)");
  return {
    issues: projectOn && (project.automation?.issues ?? true),
    prs: projectOn && (project.automation?.prs ?? true),
    upstream: live && shareUser && shareProject,
    upstreamRepo: user.upstream?.repo ?? DEFAULT_UPSTREAM_REPO,
    evidenceHosting: user.automation?.evidence_hosting ?? EVIDENCE_HOSTING_DEFAULT,
    notes,
  };
};
