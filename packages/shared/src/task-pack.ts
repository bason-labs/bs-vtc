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
  repoMapSlice: "repo_map_slice",
  designMd: "design_md",
  componentManifest: "component_manifest",
  interfaceContract: "interface_contract",
} as const;

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
