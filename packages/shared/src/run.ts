/**
 * Run backbone (§6.1) and the run record (§6.2, §6.7). Flow Studio zoom level 1 ("project
 * phases", §17) and the `status` tool are built from these.
 */
import { z } from "zod";
import {
  IsoDateTimeSchema,
  RelPathSchema,
  RunIdSchema,
  Sha256HexSchema,
  SlugSchema,
} from "./primitives.js";
import { MergeLevelSchema, TrackSchema } from "./project-config.js";

/** The fixed backbone, in order (§6.1). `g1` / `g2` are the human gates. */
export const PHASES = [
  "intake",
  "discover",
  "specify",
  "g1",
  "design",
  "g2",
  "plan",
  "build",
  "integrate",
  "final_review",
  "release",
  "retro",
] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

/** Human gates (D4): G1 spec, G2 architecture + design. Quick fix shows both on one screen (§6.2). */
export const HumanGateIdSchema = z.enum(["G1", "G2"]);
export type HumanGateId = z.infer<typeof HumanGateIdSchema>;

/** One artifact frozen at its content hash by an approval (§6.2). */
export const FrozenArtifactSchema = z.strictObject({
  path: RelPathSchema,
  sha256: Sha256HexSchema,
});
export type FrozenArtifact = z.infer<typeof FrozenArtifactSchema>;

/**
 * What a change request can target (§6.2): an artifact frozen at G1/G2, or a published
 * interface contract (§6.6: a breaking contract change needs a CR).
 */
export const ChangeRequestArtifactSchema = z.enum([
  "spec",
  "architecture",
  "design",
  "interface_contract",
]);
export type ChangeRequestArtifact = z.infer<typeof ChangeRequestArtifactSchema>;

export const HumanGateStateSchema = z
  .strictObject({
    status: z.enum(["pending", "approved", "rejected"]),
    /** Set when approved; later changes need a change request (§6.2). */
    frozen: z.array(FrozenArtifactSchema).default([]),
    decided_at: IsoDateTimeSchema.optional(),
  })
  .superRefine((gate, ctx) => {
    if (gate.status === "approved" && gate.frozen.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["frozen"],
        message: "an approved gate freezes at least one artifact",
      });
    }
    if (gate.status === "pending" && gate.decided_at !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["decided_at"],
        message: "a pending gate has no decision time",
      });
    }
  });
export type HumanGateState = z.infer<typeof HumanGateStateSchema>;

/**
 * The Lead's INTAKE classification (§6.1): the Lead (an LLM) classifies, the engine records and
 * routes. `repo` picks DISCOVER (Cartographer vs Research Analyst); `has_ui` adds the Designer.
 */
export const IntakeClassificationSchema = z.strictObject({
  track: TrackSchema,
  repo: z.enum(["existing", "new"]),
  has_ui: z.boolean(),
  /** Free risk hints from the request, e.g. `payments`, `pii` (§7.6 rules still decide). */
  risk_hints: z.array(SlugSchema).max(20).default([]),
});
export type IntakeClassification = z.infer<typeof IntakeClassificationSchema>;

export const RunSchema = z.strictObject({
  id: RunIdSchema,
  ...IntakeClassificationSchema.shape,
  phase: PhaseSchema,
  gates: z.strictObject({ G1: HumanGateStateSchema, G2: HumanGateStateSchema }),
  /** Kill switch state (`vtc pause`, §6.7 guardrails). */
  paused: z.boolean(),
  /** Configured level, possibly downgraded after a revert or post-merge CI failure (§6.7). */
  merge_level_effective: MergeLevelSchema,
  started_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.optional(),
  /** Hash of the composed pipeline config in force (§13 trace data). */
  pipeline_config_hash: Sha256HexSchema,
});
export type Run = z.infer<typeof RunSchema>;
