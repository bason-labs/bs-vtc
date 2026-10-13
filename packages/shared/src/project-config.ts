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
      /** Model id per tier per host, overriding the built-in mapping. */
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
  auto_merge: z
    .strictObject({
      /** Level 3 requires zero open findings at or above this severity (§6.7). */
      block_severity: SeveritySchema.default("medium"),
    })
    .prefault({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;
