/**
 * `vtc-manifest.json` (AD-14, AD-16): what a compiled host plugin contains. The compiler writes
 * one at the root of each plugin output (`ASSET_SOURCES["plugin:<host>"]`); the engine reads it
 * for the prompt SHA of each agent (§13, `role.dispatched.prompt_sha`) and to map a discipline or
 * stack pack to an agent or skill; the adapters' `install` reads it to place the agents. It
 * crosses package boundaries, so its shape lives here (AD-3). Readers parse it with
 * `parsePersisted` (a plugin built by a newer MINOR may carry keys this reader does not know).
 */
import { z } from "zod";
import { AGENT_NAME_PREFIX, agentNameFor } from "./helpers/agent-name.js";
import { sha256Hex } from "./helpers/fingerprint.js";
import {
  DisciplineSchema,
  HostIdSchema,
  RelPathSchema,
  RoleIdSchema,
  Sha256HexSchema,
  SlugSchema,
} from "./primitives.js";
import { EffortSchema, ModelTierSchema, RoleKindSchema } from "./role-contract.js";

/** Path of the manifest inside each plugin namespace of the `AssetBundle`. */
export const PLUGIN_MANIFEST_ASSET = "vtc-manifest.json";

/**
 * Where each plugin carries every agent's role prompt sections (AD-21 rule 2, spine §5 reading
 * 118): `vtc/prompts/<agent>/{locked,editable}.md`, the trimmed `splitRolePrompt` sections the
 * manifest's `locked_sha256` / `editable_sha256` hash. New in 4.6.0.
 */
export const ROLE_PROMPTS_ASSET_DIR = "vtc/prompts";

export type RolePromptPart = "locked" | "editable";

/** Pure: the plugin asset path of one prompt section of one compiled agent. */
export const rolePromptAssetPath = (agent: string, part: RolePromptPart): string => {
  if (!new RegExp(`^${AGENT_NAME_PREFIX}[a-z0-9-]{1,120}$`).test(agent)) {
    throw new TypeError(`not a compiled agent name: ${agent}`);
  }
  return `${ROLE_PROMPTS_ASSET_DIR}/${agent}/${part}.md`;
};

/**
 * The prompt version of a compiled agent (§13): lower-case hex SHA-256 of the UTF-8 bytes of its
 * instructions exactly as emitted, i.e. the body after the frontmatter of a Claude Code agent
 * file, equal to `developer_instructions` of the Codex agent TOML. Host frontmatter and TOML keys
 * are not hashed, so one role mode has the same SHA on both hosts when the bodies agree.
 */
export const promptShaFor = (instructions: string): string => sha256Hex(instructions);

const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "expected semver MAJOR.MINOR.PATCH");

/** What a compiled skill is, for the engine's pack selection (§5.2a, §5.3). */
export const PluginSkillKindSchema = z.enum([
  "stack_pack",
  "domain_pack",
  "lens",
  "plugin",
  "command",
  "skill",
]);
export type PluginSkillKind = z.infer<typeof PluginSkillKindSchema>;

/** One compiled agent: a role, or one mode of a role (AD-14 rule 1). */
export const PluginManifestAgentSchema = z
  .strictObject({
    /** `agentNameFor(role, mode)`, before any host namespace. */
    name: z.string().regex(new RegExp(`^${AGENT_NAME_PREFIX}[a-z0-9-]{1,120}$`)),
    role: RoleIdSchema,
    mode: SlugSchema.nullable(),
    kind: RoleKindSchema,
    /** Engineer profiles only (§5.2a). */
    discipline: DisciplineSchema.nullable(),
    role_version: SemverSchema,
    /** The emitted agent file, relative to the plugin root. */
    file: RelPathSchema,
    /** {@link promptShaFor} of the agent's instructions. */
    prompt_sha256: Sha256HexSchema,
    /**
     * Lookback (AD-21, new in 4.5.0): SHA-256 of the trimmed `splitRolePrompt` sections of the
     * agent's own role prompt (`roles/<role>/prompt.md`; an engineer profile's own sections, not
     * the Engineer's), `locked` and `editable`; every mode of a role shares them (spine §5
     * reading 118). The plugin carries both texts at {@link rolePromptAssetPath}. Once an agent
     * compiles from the locked part only (`editable_in_pack`), the engine renders the pinned
     * editable section first in the task pack and the prompt version is
     * `effectivePromptSha(locked, editable)`.
     */
    locked_sha256: Sha256HexSchema.optional(),
    editable_sha256: Sha256HexSchema.optional(),
    /**
     * True when the agent carries no editable section and expects it as the task pack's
     * opening `Role heuristics` block (`TaskPack.role_heuristics`, reading 102). Absent = false.
     * New in 4.6.0.
     */
    editable_in_pack: z.boolean().optional(),
    tier: ModelTierSchema,
    effort: EffortSchema,
  })
  .refine((agent) => agent.name === agentNameFor(agent.role, agent.mode ?? undefined), {
    message: "name must be agentNameFor(role, mode)",
    path: ["name"],
  });
export type PluginManifestAgent = z.infer<typeof PluginManifestAgentSchema>;

export const PluginManifestSkillSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "expected a lower-case skill name"),
  kind: PluginSkillKindSchema,
  /** The pack slug a task names (a `stack_packs` entry, a domain discipline, a lens id), or null. */
  pack: SlugSchema.nullable(),
  file: RelPathSchema,
});
export type PluginManifestSkill = z.infer<typeof PluginManifestSkillSchema>;

export const PluginManifestSchema = z
  .strictObject({
    v: z.literal(1),
    host: HostIdSchema,
    /** The plugin's name on the host (`vtc`). */
    plugin: SlugSchema,
    /** `CONTRACTS_VERSION` the plugin was compiled against (`contractsCompatible`). */
    contracts_version: SemverSchema,
    agents: z.array(PluginManifestAgentSchema),
    skills: z.array(PluginManifestSkillSchema).default([]),
  })
  .superRefine((manifest, ctx) => {
    const unique = (names: readonly string[], path: string): void => {
      if (new Set(names).size !== names.length) {
        ctx.addIssue({ code: "custom", path: [path], message: `${path} names must be unique` });
      }
    };
    unique(
      manifest.agents.map((a) => a.name),
      "agents",
    );
    unique(
      manifest.skills.map((s) => s.name),
      "skills",
    );
  });
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginManifestInput = z.input<typeof PluginManifestSchema>;
