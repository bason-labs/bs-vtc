/**
 * `.vtc/project.yaml` (§4.3): track default, merge level, caps, budgets, risk rules,
 * allowlists, host preferences and concurrency. Every field has a spec default, so `{ version: 1 }`
 * is a valid file.
 */
import { z } from "zod";
import { DEFAULT_FINAL_REVIEW_SHARE } from "./feature.js";
import { GlobSchema, HostIdSchema, SeveritySchema, SlugSchema } from "./primitives.js";
import { ModelTierSchema } from "./role-contract.js";

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
       * `plugin_only` (default): the engine never launches a headless host process; every role
       * runs as a subagent the Lead dispatches. `headless_allowed`: the engine may launch
       * `claude -p` / `codex exec` for auto-resume and cross-family review. §12.5 requires
       * written vendor confirmation before headless spawning ships commercially; plugin-only
       * mode needs none (`planDispatch`, spine AD-17).
       */
      dispatch: DispatchModeSchema.default("plugin_only"),
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
 */
export const UserConfigSchema = z.strictObject({
  version: z.literal(1),
  env_passthrough: z.array(EnvVarNameSchema).max(64).default([]),
  /** Optional, so a `UserConfig` built in code needs no change; absent reads as all defaults. */
  gates: z
    .strictObject({
      allow_unsandboxed: z.boolean().default(false),
    })
    .optional(),
});

/** `gates.allow_unsandboxed` of a parsed user config; false when the section is absent. */
export const gatesAllowUnsandboxed = (config: Pick<UserConfig, "gates">): boolean =>
  config.gates?.allow_unsandboxed ?? false;
export type UserConfig = z.infer<typeof UserConfigSchema>;
export type UserConfigInput = z.input<typeof UserConfigSchema>;
