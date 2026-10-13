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
  type ArtifactType,
  type RoleId,
} from "./primitives.js";
import { RoleExitSchema, VerdictSchema, type RoleExit } from "./role-result.js";

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
 * The model a spawn actually uses (AD-6 rule 2): the engine resolves the tier to a concrete
 * model id from role.yaml and project.yaml, so adapters never pick models.
 */
export interface ResolvedModel {
  readonly tier: ModelTier;
  readonly effort: Effort;
  readonly model: string;
}

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
const RoleModelsSchema = z.strictObject({
  "claude-code": RoleHostModelSchema,
  codex: RoleHostModelSchema,
});

const RoleOutputSchema = z.strictObject({
  artifacts: z.array(ArtifactTypeSchema).default([]),
  verdicts: z.array(VerdictSchema).default([]),
});

/**
 * A mode overrides the base contract field by field, e.g. QA `author` (write_scoped to
 * acceptance-test paths) vs `judge` (read_only), Security `design` vs `verify` (§5.2).
 * Each mode compiles to its own host agent (`agentNameFor`).
 */
export const RoleModeSchema = z.strictObject({
  inputs: z.array(ArtifactTypeSchema).min(1).optional(),
  output: RoleOutputSchema.optional(),
  exits: z.array(RoleExitSchema).min(1).optional(),
  tools: RoleToolsSchema.optional(),
  models: RoleModelsSchema.optional(),
});
export type RoleMode = z.infer<typeof RoleModeSchema>;

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
    output: RoleOutputSchema,
    exits: z.array(RoleExitSchema).min(1),
    /** Machine-checked success criteria: ids of engine checks (§5.1). */
    success_criteria: z
      .array(z.strictObject({ id: SlugSchema, description: z.string().min(1).max(400) }))
      .default([]),
    /** Who checks this role's output (§5.5). A role id, or `engine` for code checks. */
    reviewer: RoleIdSchema,
    /** Model tier and effort per host (§5.1). Both hosts are required: roles compile for both. */
    models: RoleModelsSchema,
    tools: RoleToolsSchema,
    /** Optional modes; when present, every dispatch and result must name one of them. */
    modes: z.record(SlugSchema, RoleModeSchema).optional(),
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
    const engineerFamily = role.kind === "engineer_profile" || role.id === "engineer";
    const sandboxed = (tools: RoleTools | undefined): boolean =>
      tools?.profile === "code_sandboxed";
    if (sandboxed(role.tools) && !engineerFamily) {
      ctx.addIssue({
        code: "custom",
        path: ["tools", "profile"],
        message: "only the Engineer family may use code_sandboxed (the only role that writes code)",
      });
    }
    for (const [name, mode] of Object.entries(role.modes ?? {})) {
      if (sandboxed(mode.tools) && !engineerFamily) {
        ctx.addIssue({
          code: "custom",
          path: ["modes", name, "tools", "profile"],
          message: "only the Engineer family may use code_sandboxed",
        });
      }
    }
    if (role.modes !== undefined && Object.keys(role.modes).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["modes"],
        message: "declare at least one mode or omit modes",
      });
    }
  });
export type RoleContract = z.infer<typeof RoleContractSchema>;
export type RoleContractInput = z.input<typeof RoleContractSchema>;

/** The effective contract for one dispatch: base fields with the mode's overrides applied. */
export interface EffectiveRoleContract {
  readonly id: RoleId;
  readonly mode: string | undefined;
  readonly inputs: readonly ArtifactType[];
  readonly output: RoleContract["output"];
  readonly exits: readonly RoleExit[];
  readonly tools: RoleTools;
  readonly models: RoleContract["models"];
}

const pickBase = (role: RoleContract): Omit<EffectiveRoleContract, "mode"> => ({
  id: role.id,
  inputs: role.inputs,
  output: role.output,
  exits: role.exits,
  tools: role.tools,
  models: role.models,
});

export type ResolveModeResult =
  | { readonly ok: true; readonly contract: EffectiveRoleContract }
  | { readonly ok: false; readonly error: string };

/**
 * Applies a mode to a role contract. A role that declares modes must be dispatched (and must
 * submit results) with one of them; a role without modes accepts no mode.
 */
export const resolveRoleMode = (role: RoleContract, mode?: string): ResolveModeResult => {
  const modes = role.modes;
  if (modes === undefined) {
    if (mode !== undefined) return { ok: false, error: `role ${role.id} declares no modes` };
    return {
      ok: true,
      contract: { ...pickBase(role), mode: undefined },
    };
  }
  if (mode === undefined) {
    return {
      ok: false,
      error: `role ${role.id} requires a mode: ${Object.keys(modes).join(", ")}`,
    };
  }
  const override = modes[mode];
  if (override === undefined) {
    return { ok: false, error: `role ${role.id} has no mode ${mode}` };
  }
  const base = pickBase(role);
  return {
    ok: true,
    contract: {
      ...base,
      mode,
      inputs: override.inputs ?? base.inputs,
      output: override.output ?? base.output,
      exits: override.exits ?? base.exits,
      tools: override.tools ?? base.tools,
      models: override.models ?? base.models,
    },
  };
};
