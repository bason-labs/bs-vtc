/** Role contract: the shape of `roles/<role>/role.yaml` (§5.1, §5.2a, §12.3). */
import { z } from "zod";
import { RETURN_CAP_TOKENS } from "./helpers/tokens.js";
import {
  ArtifactTypeSchema,
  DisciplineSchema,
  GlobSchema,
  HostIdSchema,
  RoleIdSchema,
  SlugSchema,
} from "./primitives.js";
import { RoleExitSchema, VerdictSchema } from "./role-result.js";

/** Model tier (§5.2 footnote): maps per host, e.g. Claude top/mid/low = Opus/Sonnet/Haiku. */
export const ModelTierSchema = z.enum(["top", "mid", "low"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const EffortSchema = z.enum(["low", "medium", "high"]);
export type Effort = z.infer<typeof EffortSchema>;

export const RoleHostModelSchema = z.strictObject({
  tier: ModelTierSchema,
  effort: EffortSchema,
  /** Optional explicit model id overriding the tier mapping for this host. */
  model: z.string().min(1).max(200).optional(),
});
export type RoleHostModel = z.infer<typeof RoleHostModelSchema>;

/**
 * Tool profile. `read_only` = no writes; `write_scoped` = writes only to `write_paths`
 * (e.g. BA → `.vtc/spec/**`); `code_sandboxed` = Read/Edit/Bash in a sandboxed worktree
 * (Engineer only, §5.2).
 */
export const ToolProfileSchema = z.enum(["read_only", "write_scoped", "code_sandboxed"]);
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

export const RoleToolsSchema = z
  .strictObject({
    profile: ToolProfileSchema,
    write_paths: z.array(GlobSchema).default([]),
    /** Engine MCP tools the role may call (e.g. research fetchers, fact lookups). */
    engine_tools: z.array(SlugSchema).default([]),
  })
  .superRefine((tools, ctx) => {
    if (tools.profile === "write_scoped" && tools.write_paths.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["write_paths"],
        message: "write_scoped requires at least one write path",
      });
    }
    if (tools.profile === "read_only" && tools.write_paths.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["write_paths"],
        message: "read_only roles cannot declare write paths",
      });
    }
  });
export type RoleTools = z.infer<typeof RoleToolsSchema>;

/** `core` = §5.2 roles; `engineer_profile` = §5.2a specialists; `lens` = §5.3; `advisor` = §5.4. */
export const RoleKindSchema = z.enum(["core", "engineer_profile", "lens", "advisor"]);
export type RoleKind = z.infer<typeof RoleKindSchema>;

export const RoleContractSchema = z
  .strictObject({
    id: RoleIdSchema,
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "expected semver MAJOR.MINOR.PATCH (locked core = MAJOR, §13)"),
    kind: RoleKindSchema,
    /** Required for engineer profiles (one discipline per specialist, §5.2a). */
    discipline: DisciplineSchema.optional(),
    mission: z.string().min(1).max(400),
    inputs: z.array(ArtifactTypeSchema).min(1),
    output: z.strictObject({
      artifacts: z.array(ArtifactTypeSchema).default([]),
      verdicts: z.array(VerdictSchema).default([]),
    }),
    exits: z.array(RoleExitSchema).min(1),
    /** Machine-checked success criteria: ids of engine checks (§5.1). */
    success_criteria: z
      .array(z.strictObject({ id: SlugSchema, description: z.string().min(1).max(400) }))
      .default([]),
    /** Who checks this role's output (§5.5). A role id, or `engine` for code checks. */
    reviewer: RoleIdSchema,
    /** Model tier and effort per host (§5.1). Both hosts are required: roles compile for both. */
    models: z.strictObject({
      "claude-code": RoleHostModelSchema,
      codex: RoleHostModelSchema,
    }),
    tools: RoleToolsSchema,
    budget: z.strictObject({
      context_tokens: z.int().positive(),
      return_tokens: z.int().positive().max(RETURN_CAP_TOKENS).default(RETURN_CAP_TOKENS),
    }),
    /** Small per-host prompt additions (§12.3). */
    host_overrides: z
      .partialRecord(HostIdSchema, z.strictObject({ prompt_append: z.string().max(2000) }))
      .optional(),
  })
  .superRefine((role, ctx) => {
    if (role.kind === "engineer_profile" && role.discipline === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["discipline"],
        message: "engineer profiles require a discipline",
      });
    }
    if (role.reviewer === role.id) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewer"],
        message: "a role may never review its own output (§5.5)",
      });
    }
    if (
      role.tools.profile === "code_sandboxed" &&
      role.kind !== "engineer_profile" &&
      role.id !== "engineer"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["tools", "profile"],
        message: "only the Engineer family may use code_sandboxed (the only role that writes code)",
      });
    }
  });
export type RoleContract = z.infer<typeof RoleContractSchema>;
export type RoleContractInput = z.input<typeof RoleContractSchema>;
