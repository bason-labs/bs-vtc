/**
 * Builds one agent's instructions from its role source (§5.1, AD-14):
 *
 * 1. the locked core: for an engineer profile, the Engineer's locked core first (§5.2a: every
 *    specialist shares the Engineer contract); for a lens reviewer, the shared lens procedure
 *    first and its lens skill's checklist after (§5.3);
 * 2. the contract, generated from the effective role.yaml contract of the mode;
 * 3. the shared result protocol (`roles/_shared/result-protocol.md`, filled from the frozen
 *    contracts); for an advisor (§5.4), which has no task pack and whose result goes to the human
 *    rather than the engine, `roles/_shared/advisor-protocol.md` instead;
 * 4. the host's `prompt_append` (§12.3);
 * 5. the editable section(s), the part Lookback may propose changes to (AD-14 rule 4).
 *
 * Parts 1–4 are the locked part and part 5 the editable part (`prompt-parts.ts`); each is rendered
 * on its own, and an agent carries `<locked>\n<editable>`, or the locked part only when its role's
 * editable section goes in the task pack (§5 reading 102).
 *
 * Mode blocks are resolved per mode, so each mode's agent carries only its own rules. Every part
 * may use `{{name}}` placeholders filled from the frozen contracts (`PROTOCOL_VARS`) and from the
 * compiled skills (`InstructionSources.vars`), so prompts never restate an enum by hand.
 */
import {
  ArchitectDepthSchema,
  ColourStrategySchema,
  ContractKindSchema,
  DESIGN_SCREENS_PATH,
  DisciplineSchema,
  EscalationEffectSchema,
  EvidenceTypeSchema,
  FactStatusSchema,
  FetcherIdSchema,
  FindingCategorySchema,
  FindingKindSchema,
  G2DirectionSchema,
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  MAX_STACK_PACKS,
  PrototypeThemeSchema,
  prototypeStatePath,
  ResearchDepthSchema,
  resolveRoleMode,
  ROLE_MCP_TOOLS,
  ScorecardMetricIdSchema,
  SUMMARY_MAX_CHARS,
  TASK_PACK_SECTIONS,
  VerdictQuestionTypeSchema,
  type EffectiveRoleContract,
  type HostId,
  type RoleContract,
  type RoleExit,
} from "@vtc/shared";
import { EDITABLE_IN_PACK_NOTE } from "./prompt-parts.js";
import { renderTemplate, selectMode } from "./role-source.js";
import type { LoadedRole } from "./role-source.js";

/** Values every prompt part may reference as `{{name}}`. */
export const PROTOCOL_VARS: Readonly<Record<string, string>> = {
  architect_depths: ArchitectDepthSchema.options.join(", "),
  colour_strategies: ColourStrategySchema.options.join(", "),
  research_depths: ResearchDepthSchema.options.join(", "),
  /** Where the Designer writes the screen list (`DesignScreensFileSchema`, §9). */
  design_screens_path: DESIGN_SCREENS_PATH,
  prototype_themes: PrototypeThemeSchema.options.join(", "),
  /** One state's prototype URL path, as `prototypeStatePath` builds it. */
  prototype_state_example: prototypeStatePath("/invoices", "empty", "dark"),
  contract_kinds: ContractKindSchema.options.join(", "),
  disciplines: DisciplineSchema.options.join(", "),
  max_stack_packs: String(MAX_STACK_PACKS),
  escalation_effects: EscalationEffectSchema.options.join(", "),
  evidence_types: EvidenceTypeSchema.options.join(", "),
  task_pack_sections: TASK_PACK_SECTIONS.join(", "),
  finding_categories: FindingCategorySchema.options.join(", "),
  finding_kinds: FindingKindSchema.options.join(", "),
  summary_max_chars: String(SUMMARY_MAX_CHARS),
  verdict_question_types: VerdictQuestionTypeSchema.options.join(", "),
  /** Lookback (AD-21): the metrics a proposal may target, its change cap and where it goes. */
  scorecard_metrics: ScorecardMetricIdSchema.options.join(", "),
  max_proposal_changes: String(LOOKBACK_LIMITS.maxProposalChanges),
  lookback_proposals_dir: LOOKBACK_REPO.proposalsDir,
  /** Research (AD-22): the role-facing tools, the fetchers behind them and the fact statuses. */
  role_mcp_tools: ROLE_MCP_TOOLS.map((tool) => tool.name).join(", "),
  fetchers: FetcherIdSchema.options.join(", "),
  fact_statuses: FactStatusSchema.options.join(", "),
  /** G2 (§9.1): what the Designer gives each direction; the engine adds its novelty verdict. */
  g2_direction_fields: Object.keys(G2DirectionSchema.shape)
    .filter((key) => key !== "novelty")
    .map((key) => `\`${key}\``)
    .join(", "),
};

const list = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));

/**
 * What each profile may do, worded as instructions rather than as guarantees: on Codex a
 * write-scoped agent runs in `workspace-write`, which does not itself block a shell, and on both
 * hosts the write paths are not a host-level deny (spine §7: per-path deny is a spike item).
 */
const TOOL_LINES: Readonly<Record<EffectiveRoleContract["tools"]["profile"], string>> = {
  read_only: "read-only: read and search files; write no file and run no shell command",
  write_scoped:
    "read and search files; write files only inside the Write scope of your task pack; run no shell command",
  code_sandboxed:
    "files and shell in a sandboxed worktree; write only inside the Write scope of your task pack",
};

/**
 * When to use each exit (§5.1: the prompt's exits). The contract lists only the role's own exits,
 * each with its meaning, so every agent knows when to take each one.
 */
export const EXIT_MEANINGS: Readonly<Record<RoleExit, string>> = {
  built:
    "the change is complete: the acceptance tests and gate commands pass and every finding to address is resolved",
  done: "the work this contract asks for is complete and in your result",
  spec_conflict: "two frozen inputs cannot both hold; cite both sides in `conflict`",
  blocked:
    "one human decision is needed before useful work can go on; ask it as `question` with options",
  out_of_scope_fault:
    "a failure comes from code outside your write scope and also occurs without your change; cite it in `fault`",
  unknown: "your inputs cannot answer the question; say in `summary` what would",
};

/**
 * Who reads the result: the engine for every role; for an advisor (dispatched through `consult`,
 * spine §5 reading 25) also the human who asked, its reviewer.
 */
const CONTRACT_INTRO: Readonly<Record<"run" | "advisor", { checked: string; inputs: string }>> = {
  run: {
    checked:
      "Generated from role.yaml. The engine checks your result against it and rejects one that breaks it.",
    inputs: "artifact types in your task pack",
  },
  advisor: {
    checked:
      "Generated from role.yaml. The engine checks your result against it and rejects one that breaks it; then the human who asked reads your advice.",
    inputs: "artifact types in your task pack",
  },
};

/**
 * The contract's role line. An engineer profile reports role `engineer`: the engine dispatches
 * the Engineer and spawns the profile agent for the task's discipline (§5.2a, spine §5 reading
 * 38), so the whole family shares the Engineer's result contract.
 */
const roleLine = (role: RoleContract, contract: EffectiveRoleContract): string =>
  role.kind === "engineer_profile"
    ? `- Role: engineer, ${role.discipline ?? ""} profile ${role.id} (version ${role.version}); your result's \`role\` is \`engineer\``
    : `- Role: ${role.id}${contract.mode === undefined ? "" : `, mode ${contract.mode}`} (version ${role.version})`;

/** The `## Contract` section for one effective contract. */
export const renderContract = (role: RoleContract, contract: EffectiveRoleContract): string => {
  const intro = CONTRACT_INTRO[role.kind === "advisor" ? "advisor" : "run"];
  const lines = [
    "## Contract",
    "",
    intro.checked,
    "",
    roleLine(role, contract),
    `- Inputs (${intro.inputs}): ${list(contract.inputs)}`,
    `- Exits: ${list(contract.exits)}`,
    ...contract.exits.map((exit) => `  - \`${exit}\`: ${EXIT_MEANINGS[exit]}`),
    `- Verdicts: ${list(contract.output.verdicts)}`,
    `- Output artifact types: ${list(contract.output.artifacts)}`,
    `- Tools: ${TOOL_LINES[contract.tools.profile]}`,
    ...(contract.tools.profile === "write_scoped"
      ? [`- Write paths (role.yaml): ${list(contract.tools.write_paths)}`]
      : []),
    ...(contract.tools.engine_tools.length === 0
      ? []
      : [`- Engine tools: ${list(contract.tools.engine_tools)}`]),
    `- Context budget: about ${String(role.budget.context_tokens)} tokens; summary at most ${String(role.budget.return_tokens)} tokens`,
  ];
  if (role.success_criteria.length > 0) {
    lines.push("- Checked by the engine:");
    for (const c of role.success_criteria) lines.push(`  - ${c.id}: ${c.description}`);
  }
  return lines.join("\n");
};

export interface InstructionSources {
  /** `roles/_shared/result-protocol.md`. */
  readonly protocol: string;
  /** `roles/_shared/advisor-protocol.md`, for advisors. */
  readonly advisorProtocol: string | undefined;
  /** `roles/_shared/lens-reviewer.md`, for lens roles. */
  readonly lensReviewer: string | undefined;
  /** The Engineer role, for engineer profiles. */
  readonly engineer: LoadedRole | undefined;
  /** Skill bodies (frontmatter removed) by skill name, for lens checklists. */
  readonly skillBodies: ReadonlyMap<string, string>;
  /** Placeholders known only at compile time, e.g. the available stack packs. */
  readonly vars: Readonly<Record<string, string>>;
}

/** One agent's prompt parts, each rendered and trimmed (`prompt-parts.ts`). */
export type InstructionsResult =
  | {
      readonly ok: true;
      readonly locked: string;
      readonly editable: string;
      readonly contract: EffectiveRoleContract;
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/** What an agent carries: both parts, or the locked part only (§5 reading 102). */
export const agentInstructions = (
  parts: { readonly locked: string; readonly editable: string },
  editableInPack: boolean,
): string => (editableInPack ? parts.locked : `${parts.locked}\n${parts.editable}`);

/** `lens_supply_chain` → `lens-supply-chain`. */
export const lensSkillName = (roleId: string): string => roleId.replaceAll("_", "-");

const pick = (
  text: string,
  mode: string | undefined,
  role: RoleContract,
  errors: string[],
): string => {
  const check = selectMode(text, mode, Object.keys(role.modes ?? {}));
  if (!check.ok) {
    errors.push(...check.errors);
    return "";
  }
  return check.text.trim();
};

export const buildInstructions = (
  loaded: LoadedRole,
  mode: string | undefined,
  host: HostId,
  sources: InstructionSources,
  editableInPack = false,
): InstructionsResult => {
  const { role, prompt } = loaded;
  const resolved = resolveRoleMode(role, mode);
  if (!resolved.ok) return { ok: false, errors: [resolved.error] };
  const errors: string[] = [];
  const locked: string[] = [];
  const editable: string[] = [];
  if (role.kind === "engineer_profile") {
    if (sources.engineer === undefined) {
      errors.push("engineer profiles build on roles/engineer, which is missing");
    } else {
      locked.push(pick(sources.engineer.prompt.locked, undefined, sources.engineer.role, errors));
      editable.push(
        pick(sources.engineer.prompt.editable, undefined, sources.engineer.role, errors),
      );
    }
  }
  if (role.kind === "lens") {
    if (sources.lensReviewer === undefined) {
      errors.push("lens roles build on roles/_shared/lens-reviewer.md, which is missing");
    } else {
      locked.push(sources.lensReviewer.trim());
    }
  }
  locked.push(pick(prompt.locked, mode, role, errors));
  if (role.kind === "lens") {
    const skill = lensSkillName(role.id);
    const checklist = sources.skillBodies.get(skill);
    if (checklist === undefined) errors.push(`lens roles need the skill skills/${skill}`);
    else locked.push(checklist.trim());
  }
  editable.push(pick(prompt.editable, mode, role, errors));
  const protocol = role.kind === "advisor" ? sources.advisorProtocol : sources.protocol;
  if (protocol === undefined) {
    errors.push("advisor roles build on roles/_shared/advisor-protocol.md, which is missing");
  }
  if (errors.length > 0 || protocol === undefined) return { ok: false, errors };
  const append = role.host_overrides?.[host]?.prompt_append;
  const vars = { ...PROTOCOL_VARS, ...sources.vars };
  const render = (parts: readonly string[]): ReturnType<typeof renderTemplate> =>
    renderTemplate(parts.filter((part) => part !== "").join("\n\n"), vars);
  const lockedText = render([
    ...locked,
    renderContract(role, resolved.contract),
    protocol.trim(),
    ...(append === undefined ? [] : [append.trim()]),
    ...(editableInPack ? [EDITABLE_IN_PACK_NOTE] : []),
  ]);
  const editableText = render(editable);
  const renderErrors = [
    ...(lockedText.ok ? [] : lockedText.errors),
    ...(editableText.ok ? [] : editableText.errors),
  ];
  if (!lockedText.ok || !editableText.ok) return { ok: false, errors: renderErrors };
  if (editableText.text.trim() === "") {
    return { ok: false, errors: ["the editable section is empty; Lookback needs one to revise"] };
  }
  return {
    ok: true,
    locked: lockedText.text.trim(),
    editable: editableText.text.trim(),
    contract: resolved.contract,
  };
};
