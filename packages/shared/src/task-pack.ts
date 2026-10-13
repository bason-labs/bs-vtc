/**
 * The task pack (§6.3 step 1): what the engine's Context Packer hands one role run. It is the
 * seam between the engine (sub-project 1) and the role prompts and compiler (sub-project 3):
 * prompts are written against the fixed section headings of {@link renderTaskPack}, and name
 * inputs by artifact type, never by path (principle 2).
 *
 * One pack per dispatch: `.vtc/state/packs/<action_id>.md` (`taskPackPath`), gitignored. The
 * `spawn_role` action and the `role.dispatched` event carry that path.
 */
import { z } from "zod";
import { EscalationAnswerSchema } from "./escalation.js";
import { FindingSchema } from "./finding.js";
import { GateLayerSchema } from "./gates-config.js";
import {
  FeatureIdSchema,
  GlobSchema,
  RequirementRefSchema,
  RoleIdSchema,
  RunIdSchema,
  SlugSchema,
  TaskIdSchema,
  VerdictSubjectSchema,
} from "./primitives.js";
import { ArtifactRefSchema } from "./role-result.js";
import { IntentContractSchema } from "./task.js";

/**
 * Artifact types the Context Packer puts in `inputs` (§6.3 step 1). Roles may receive other
 * types too (spec, architecture, evidence…); these are the ones every task pipeline uses.
 */
export const PACK_INPUT_TYPES = {
  /** The run's idea or change request (`runRequestPath`), for DISCOVER and SPECIFY roles. */
  request: "request",
  repoMapSlice: "repo_map_slice",
  designMd: "design_md",
  componentManifest: "component_manifest",
  interfaceContract: "interface_contract",
  /**
   * The human's question to an advisor (`consult`), written by the engine and listed first in
   * the advisor's inputs (§5.4). `request` stays the run's request, never the question.
   */
  advisorQuestion: "advisor_question",
} as const;

/**
 * Architect depth (§8.3), set by the engine from the spec's attributes: `S` decisions only, `M`
 * two candidates and a scorecard (default), `L` three candidates, ATAM-lite, threat model and
 * cost model. The track bounds it (§6.2).
 */
export const ArchitectDepthSchema = z.enum(["S", "M", "L"]);
export type ArchitectDepth = z.infer<typeof ArchitectDepthSchema>;

/** Research depth of DISCOVER (§6.2): `light` for the feature track, `full` for a new project. */
export const ResearchDepthSchema = z.enum(["light", "full"]);
export type ResearchDepth = z.infer<typeof ResearchDepthSchema>;

/** Colour strategies of the constraints lottery (§9.1 step 2), in OKLCH. */
export const ColourStrategySchema = z.enum(["restrained", "committed", "full", "drenched"]);
export type ColourStrategy = z.infer<typeof ColourStrategySchema>;

const lotteryPick = z.string().min(1).max(200);

/**
 * One direction's constraints, dealt by the engine's local RNG seeded by project and run
 * (§9.1 step 2: variation comes from code, not the model). The Designer builds the direction
 * inside them. Picks other than the colour strategy name entries of curated pools.
 */
export const DesignConstraintsSchema = z.strictObject({
  colour_strategy: ColourStrategySchema,
  type_pairing: lotteryPick,
  density_grid: lotteryPick,
  radius_elevation: lotteryPick,
  motion: lotteryPick,
  signature_interaction: lotteryPick,
});
export type DesignConstraints = z.infer<typeof DesignConstraintsSchema>;

/** An architecture decision id, `AD-n`. */
export const DecisionIdSchema = z.string().regex(/^AD-[1-9]\d*$/, "expected an AD id like AD-3");

export const TaskPackSchema = z.strictObject({
  v: z.literal(1),
  run: RunIdSchema,
  action_id: SlugSchema,
  role: RoleIdSchema,
  mode: SlugSchema.optional(),
  task: TaskIdSchema.optional(),
  feature: FeatureIdSchema.optional(),
  /** The one subject this call judges, e.g. the AC of a Spec-Verifier call (§7.4). */
  subject: VerdictSubjectSchema.optional(),
  /** Architect dispatches: the depth the engine set (§8.3). */
  architect_depth: ArchitectDepthSchema.optional(),
  /** DISCOVER dispatches (Research Analyst, Repo Cartographer): the track's depth (§6.2). */
  research_depth: ResearchDepthSchema.optional(),
  /** Designer direction dispatches: the dealt constraints, one set per direction (§9.1). */
  design_constraints: DesignConstraintsSchema.optional(),
  /** The task's immutable intent contract (§6.3 plan file). */
  intent: IntentContractSchema.optional(),
  /** The REQs and ACs in scope, with their frozen text. */
  requirements: z
    .array(z.strictObject({ id: RequirementRefSchema, text: z.string().min(1).max(4000) }))
    .default([]),
  /** The relevant architecture decisions, with their Rule text. */
  decisions: z
    .array(z.strictObject({ id: DecisionIdSchema, text: z.string().min(1).max(4000) }))
    .default([]),
  /** Input artifacts by type: repo-map slice, DESIGN.md and component manifest for UI, … */
  inputs: z.array(ArtifactRefSchema).default([]),
  /** Where the role may write (the task's files_scope or the role's write paths). */
  files_scope: z.array(GlobSchema).default([]),
  /** Gate commands the role may run locally to check its work (§6.3 step 1). */
  gates: z
    .array(
      z.strictObject({
        id: SlugSchema,
        layer: GateLayerSchema,
        command: z.array(z.string().min(1).max(4096)).min(1),
      }),
    )
    .default([]),
  /** Fix rounds: the findings routed to this role (§6.3 step 8). */
  findings: z.array(FindingSchema).default([]),
  /** A resumed run after an escalation: the human's answer (§6.5). */
  answer: EscalationAnswerSchema.optional(),
});
export type TaskPack = z.infer<typeof TaskPackSchema>;
export type TaskPackInput = z.input<typeof TaskPackSchema>;

/** The fixed section headings of a rendered pack, in order. Prompts refer to these names. */
export const TASK_PACK_SECTIONS = [
  "Dispatch",
  "Intent contract",
  "Requirements",
  "Architecture decisions",
  "Inputs",
  "Write scope",
  "Gate commands",
  "Findings to address",
  "Human answer",
] as const;
export type TaskPackSection = (typeof TASK_PACK_SECTIONS)[number];

/** `.vtc/state/packs/<action_id>.md`. */
export const taskPackPath = (actionId: string): string =>
  `.vtc/state/packs/${SlugSchema.parse(actionId)}.md`;

const list = (items: readonly string[]): string =>
  items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");

/**
 * Renders a pack as Markdown: every section of {@link TASK_PACK_SECTIONS} appears, in order, as
 * a `## ` heading; an empty section says `(none)`. Pure and deterministic.
 */
export const renderTaskPack = (input: TaskPackInput): string => {
  const pack = TaskPackSchema.parse(input);
  const dispatch = [
    `run: ${pack.run}`,
    `action: ${pack.action_id}`,
    `role: ${pack.role}${pack.mode === undefined ? "" : ` (${pack.mode})`}`,
    ...(pack.task === undefined ? [] : [`task: ${pack.task}`]),
    ...(pack.feature === undefined ? [] : [`feature: ${pack.feature}`]),
    ...(pack.subject === undefined ? [] : [`subject: ${pack.subject}`]),
    ...(pack.architect_depth === undefined ? [] : [`architect depth: ${pack.architect_depth}`]),
    ...(pack.research_depth === undefined ? [] : [`research depth: ${pack.research_depth}`]),
    ...(pack.design_constraints === undefined
      ? []
      : [
          `design constraints: colour strategy ${pack.design_constraints.colour_strategy}; type pairing ${pack.design_constraints.type_pairing}; density and grid ${pack.design_constraints.density_grid}; radius and elevation ${pack.design_constraints.radius_elevation}; motion ${pack.design_constraints.motion}; signature interaction ${pack.design_constraints.signature_interaction}`,
        ]),
  ];
  const intent =
    pack.intent === undefined
      ? "(none)"
      : [
          pack.intent.statement,
          "",
          "Always:",
          list(pack.intent.always),
          "",
          "Never:",
          list(pack.intent.never),
          "",
          "Cases:",
          list(pack.intent.io_matrix.map((c) => `${c.case}: ${c.input} → ${c.expected}`)),
        ].join("\n");
  const body: Record<TaskPackSection, string> = {
    Dispatch: list(dispatch),
    "Intent contract": intent,
    Requirements: list(pack.requirements.map((r) => `${r.id}: ${r.text}`)),
    "Architecture decisions": list(pack.decisions.map((d) => `${d.id}: ${d.text}`)),
    Inputs: list(pack.inputs.map((a) => `${a.type}: ${a.path}`)),
    "Write scope": list(pack.files_scope),
    "Gate commands": list(pack.gates.map((g) => `${g.id} (${g.layer}): ${g.command.join(" ")}`)),
    "Findings to address": list(
      pack.findings.map(
        (f) => `${f.fingerprint.slice(0, 12)} ${f.severity} ${f.title} (${f.location.path})`,
      ),
    ),
    "Human answer":
      pack.answer === undefined
        ? "(none)"
        : `${pack.answer.option}${pack.answer.text === undefined ? "" : `: ${pack.answer.text}`}`,
  };
  return TASK_PACK_SECTIONS.map((section) => `## ${section}\n\n${body[section]}\n`).join("\n");
};
