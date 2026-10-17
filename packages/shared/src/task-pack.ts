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
import { DESIGN_COVERAGE_LOOP, DesignCoverageGapsSchema, DesignExitSchema } from "./design.js";
import { EscalationAnswerSchema } from "./escalation.js";
import { FindingSchema } from "./finding.js";
import { GateLayerSchema } from "./gates-config.js";
import {
  FeatureIdSchema,
  WriteScopeGlobSchema,
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
  /**
   * The issue an automatic run works on (`run.started.automation`, D-cd; spine §5 reading 198),
   * written by the engine under the run directory. Engine core lists it in the Spec Verifier's
   * pack on an automatic run and on no other run, so the verifier checks the PR against the issue
   * (the issue is the spec). New in 5.1.0.
   */
  automationIssue: "automation_issue",
  /**
   * An image the human attached to the request or a change request (`StartInput.attachments`),
   * copied into gitignored local state (`runAttachmentPath`); one input per file. New in 5.12.0.
   */
  attachments: "attachments",
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
  /**
   * Post-G2 UI dispatches (Engineer, Visual QA, Designer refinement): the design direction the
   * human approved at G2 (`ApproveInput.design_direction`), so the role judges against that
   * direction's contract in each key screen's design contract (`designContractPath`, §9.1;
   * spine §5 reading 179). Absent before G2, on a run with one direction, and after the
   * `category_standard` exit. New in 4.11.0. Printed as the Dispatch line
   * `design direction: <id>` (5.1.0).
   */
  design_direction: SlugSchema.optional(),
  /**
   * Post-G2 UI dispatches after the G2 `category_standard` exit (§9.1 step 5): the build follows
   * the category standard, not one of the 2–3 directions the design contracts still hold, so
   * `design_direction` is absent and roles need this to tell the exit from a missing line. Printed
   * as the Dispatch line `design exit: category_standard`. New in 5.1.0 (spine §5 reading 179 as
   * amended by reading 211).
   */
  design_exit: DesignExitSchema.extract(["category_standard"]).optional(),
  /**
   * Architect and Designer dispatches of the G2 coverage loop (H-13; spine §5 reading 237): the
   * fix round and the DESIGN check's gaps this dispatch must close (`designCoverageGaps`), ids
   * only. Printed as Dispatch lines (`coverage round: <n> of <max>`, then one line per non-empty
   * list). Absent on every other dispatch. New in 5.7.0.
   */
  coverage_gaps: DesignCoverageGapsSchema.optional(),
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
  files_scope: z.array(WriteScopeGlobSchema).default([]),
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
  /**
   * The pinned (or compiled default) editable section of a role whose agent carries the locked
   * core only (AD-21 rule 2, spine §5 readings 102 and 117), trimmed. Rendered as the pack's
   * opening block, `## Role heuristics` ({@link TASK_PACK_HEURISTICS_SECTION}), before
   * `## Dispatch`; absent for every other role. It may not contain a line that is a pack heading
   * (`## ` and a {@link TASK_PACK_SECTIONS} name or the heuristics name). New in 4.6.0.
   */
  role_heuristics: z
    .string()
    .min(1)
    .max(20000)
    .refine((text) => !packHeadingIn(text), {
      message: "role heuristics may not contain a task-pack section heading",
    })
    .optional(),
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

/**
 * The optional opening section of a pack: a switched role's editable section
 * (`TaskPack.role_heuristics`, spine §5 reading 102). It is not one of {@link TASK_PACK_SECTIONS}:
 * only a pack that carries it starts with it, so every other pack still starts with
 * `## Dispatch`. New in 4.6.0.
 */
export const TASK_PACK_HEURISTICS_SECTION = "Role heuristics";

/** Pure: whether `text` has a line that is a pack heading (`## <section>`). */
export const packHeadingIn = (text: string): boolean => {
  const names = new Set<string>([...TASK_PACK_SECTIONS, TASK_PACK_HEURISTICS_SECTION]);
  return text.split("\n").some((line) => {
    const m = /^\s*##\s+(.+?)\s*$/.exec(line);
    return m?.[1] !== undefined && names.has(m[1]);
  });
};

/** `.vtc/state/packs/<action_id>.md`. */
export const taskPackPath = (actionId: string): string =>
  `.vtc/state/packs/${SlugSchema.parse(actionId)}.md`;

const list = (items: readonly string[]): string =>
  items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");

/**
 * Pure: free text as pack data. A line that starts with `#` (after any indent) gets a backslash
 * before its first `#`, so requirement text, a finding title or a human answer can never pose as
 * a pack heading such as `## Role heuristics` (spine §5 reading 117). New in 4.6.0.
 */
export const escapePackText = (text: string): string => text.replace(/^([ \t]*)#/gm, "$1\\#");

/** The Dispatch lines of a coverage-loop dispatch (`TaskPack.coverage_gaps`, 5.7.0). */
const coverageLines = (gaps: TaskPack["coverage_gaps"]): string[] => {
  if (gaps === undefined) return [];
  const line = (label: string, ids: readonly string[]): string[] =>
    ids.length === 0 ? [] : [`${label}: ${ids.join(", ")}`];
  return [
    `coverage round: ${String(gaps.round)} of ${String(DESIGN_COVERAGE_LOOP.maxRounds)}`,
    ...line("requirements no AD or component names", gaps.reqs_without_component),
    ...line("UI requirements with no screen", gaps.reqs_without_screen),
    ...line("screens with no requirement", gaps.screens_without_req),
    ...line("components not registered", gaps.components_unregistered),
    ...(gaps.screens_problem === undefined
      ? []
      : [`screens.yaml problem: ${escapePackText(gaps.screens_problem.replace(/\s+/g, " "))}`]),
  ];
};

/**
 * Renders a pack as Markdown: every section of {@link TASK_PACK_SECTIONS} appears, in order, as
 * a `## ` heading; an empty section says `(none)`. A pack with `role_heuristics` opens with
 * `## Role heuristics` before them. Free text is escaped ({@link escapePackText}). Pure and
 * deterministic.
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
    ...(pack.design_direction === undefined ? [] : [`design direction: ${pack.design_direction}`]),
    ...(pack.design_exit === undefined ? [] : [`design exit: ${pack.design_exit}`]),
    ...coverageLines(pack.coverage_gaps),
  ];
  const intent =
    pack.intent === undefined
      ? "(none)"
      : [
          escapePackText(pack.intent.statement),
          "",
          "Always:",
          list(pack.intent.always.map(escapePackText)),
          "",
          "Never:",
          list(pack.intent.never.map(escapePackText)),
          "",
          "Cases:",
          list(
            pack.intent.io_matrix.map((c) =>
              escapePackText(`${c.case}: ${c.input} → ${c.expected}`),
            ),
          ),
        ].join("\n");
  const body: Record<TaskPackSection, string> = {
    Dispatch: list(dispatch),
    "Intent contract": intent,
    Requirements: list(pack.requirements.map((r) => `${r.id}: ${escapePackText(r.text)}`)),
    "Architecture decisions": list(pack.decisions.map((d) => `${d.id}: ${escapePackText(d.text)}`)),
    Inputs: list(pack.inputs.map((a) => `${a.type}: ${a.path}`)),
    "Write scope": list(pack.files_scope),
    "Gate commands": list(pack.gates.map((g) => `${g.id} (${g.layer}): ${g.command.join(" ")}`)),
    "Findings to address": list(
      pack.findings.map(
        (f) =>
          `${f.fingerprint.slice(0, 12)} ${f.severity} ${escapePackText(f.title)} (${f.location.path})`,
      ),
    ),
    "Human answer":
      pack.answer === undefined
        ? "(none)"
        : `${pack.answer.option}${pack.answer.text === undefined ? "" : `: ${escapePackText(pack.answer.text)}`}`,
  };
  const sections = TASK_PACK_SECTIONS.map((section) => `## ${section}\n\n${body[section]}\n`);
  return [
    ...(pack.role_heuristics === undefined
      ? []
      : [`## ${TASK_PACK_HEURISTICS_SECTION}\n\n${pack.role_heuristics.trim()}\n`]),
    ...sections,
  ].join("\n");
};
